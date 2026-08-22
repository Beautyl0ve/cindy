import { describe, expect, it, vi } from 'vitest';

import {
  assessPlanReviewModelContextSwitch,
  PlanReviewModelApprovalCoordinator,
  PlanReviewModelApprovalError,
  resolveConservativePlanReviewContextTokens,
  runPlanReviewModelApprovalTransaction,
} from '../planReviewModelApproval.js';

describe('assessPlanReviewModelContextSwitch', () => {
  it('does not apply the window guard when approval keeps the current model', () => {
    expect(
      assessPlanReviewModelContextSwitch({
        currentModel: 'small',
        targetModel: 'small',
        contextTokens: 250_000,
        targetContextWindow: 200_000,
        autoCompactThresholdPct: 90,
      }),
    ).toEqual({ level: 'ok', projectedPct: 0, requiresHandoff: false });
  });

  it.each([
    { contextTokens: 150_000, level: 'warn', requiresHandoff: false },
    { contextTokens: 180_000, level: 'danger', requiresHandoff: true },
    { contextTokens: 200_000, level: 'overflow', requiresHandoff: true },
  ] as const)(
    'maps a $level target-window assessment to requiresHandoff=$requiresHandoff',
    ({ contextTokens, level, requiresHandoff }) => {
      expect(
        assessPlanReviewModelContextSwitch({
          currentModel: 'large',
          targetModel: 'small',
          contextTokens,
          targetContextWindow: 200_000,
          autoCompactThresholdPct: 90,
        }),
      ).toEqual({
        level,
        projectedPct: Math.round((contextTokens / 200_000) * 100),
        requiresHandoff,
      });
    },
  );

  it('fails open when the target context window is unknown', () => {
    expect(
      assessPlanReviewModelContextSwitch({
        currentModel: 'large',
        targetModel: 'unknown',
        contextTokens: 500_000,
        targetContextWindow: undefined,
        autoCompactThresholdPct: 90,
      }),
    ).toEqual({ level: 'ok', projectedPct: 0, requiresHandoff: false });
  });

  it('uses the conservative maximum of valid live and persisted usage', () => {
    expect(resolveConservativePlanReviewContextTokens(120_000, 180_000)).toBe(180_000);
    expect(resolveConservativePlanReviewContextTokens(180_000, 120_000)).toBe(180_000);
    expect(resolveConservativePlanReviewContextTokens(120_000, Number.NaN)).toBe(120_000);
  });
});

describe('PlanReviewModelApprovalCoordinator', () => {
  it('orders exact-entry reservation before revalidation and approval', async () => {
    const coordinator = new PlanReviewModelApprovalCoordinator();
    const pending = { requestId: 'plan-1' };
    let live: typeof pending | undefined = pending;
    const order: string[] = [];
    const reservation = coordinator.begin({
      requestId: pending.requestId,
      expectedPending: pending,
      readPending: () => {
        order.push('read');
        return live;
      },
    });

    order.push('apply');
    const result = await reservation.complete({
      changed: true,
      value: 'ok',
      rollback: vi.fn(async () => {}),
      resolve: (expected) => {
        order.push('resolve');
        if (live !== expected) return false;
        live = undefined;
        return true;
      },
    });
    reservation.release();

    expect(result).toBe('ok');
    expect(order).toEqual(['read', 'apply', 'read', 'resolve']);
    expect(coordinator.isReserved('plan-1')).toBe(false);
  });

  it('rolls back and never approves when the exact pending entry is replaced', async () => {
    const coordinator = new PlanReviewModelApprovalCoordinator();
    const pending = { requestId: 'plan-2', generation: 1 };
    let live: typeof pending | undefined = pending;
    const rollback = vi.fn(async () => {});
    const resolve = vi.fn(() => true);
    const reservation = coordinator.begin({
      requestId: pending.requestId,
      expectedPending: pending,
      readPending: () => live,
    });
    live = { requestId: 'plan-2', generation: 2 };

    await expect(
      reservation.complete({ changed: true, value: undefined, rollback, resolve }),
    ).rejects.toMatchObject({ failure: 'stale' });
    reservation.release();

    expect(rollback).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rolls back an apply failure and preserves the original error', async () => {
    const coordinator = new PlanReviewModelApprovalCoordinator();
    const pending = { requestId: 'plan-3' };
    const failure = new Error('persist failed');
    const rollback = vi.fn(async () => {});
    const reservation = coordinator.begin({
      requestId: pending.requestId,
      expectedPending: pending,
      readPending: () => pending,
    });

    await expect(reservation.abort(failure, { changed: true, rollback })).rejects.toBe(failure);
    reservation.release();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('reports rollback failure distinctly and releases the reservation', async () => {
    const coordinator = new PlanReviewModelApprovalCoordinator();
    const pending = { requestId: 'plan-4' };
    const reservation = coordinator.begin({
      requestId: pending.requestId,
      expectedPending: pending,
      readPending: () => pending,
    });

    await expect(
      reservation.abort(new Error('runtime failed'), {
        changed: true,
        rollback: async () => {
          throw new Error('rollback failed');
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlanReviewModelApprovalError>>({
        failure: 'rollback_failed',
      }),
    );
    reservation.release();
    expect(coordinator.isReserved(pending.requestId)).toBe(false);
  });

  it('rejects a concurrent duplicate before it can mutate or approve', async () => {
    const coordinator = new PlanReviewModelApprovalCoordinator();
    const pending = { requestId: 'plan-5' };
    const reservation = coordinator.begin({
      requestId: pending.requestId,
      expectedPending: pending,
      readPending: () => pending,
    });

    expect(coordinator.isReserved(pending.requestId)).toBe(true);
    expect(() =>
      coordinator.begin({
        requestId: pending.requestId,
        expectedPending: pending,
        readPending: () => pending,
      }),
    ).toThrow(expect.objectContaining({ failure: 'in_flight' }));

    await expect(
      reservation.complete({
        changed: false,
        value: 'first',
        rollback: vi.fn(async () => {}),
        resolve: vi.fn(() => true),
      }),
    ).resolves.toBe('first');
    reservation.release();
  });
});

describe('runPlanReviewModelApprovalTransaction', () => {
  function setup() {
    const coordinator = new PlanReviewModelApprovalCoordinator();
    const pending = { requestId: 'plan-tx', generation: 1 };
    let live: typeof pending | undefined = pending;
    const order: string[] = [];
    const apply = vi.fn(async () => {
      order.push('apply');
      return 'applied';
    });
    const persist = vi.fn(async () => {
      order.push('persist');
    });
    const rollback = vi.fn(async () => {
      order.push('rollback');
    });
    const resolve = vi.fn((expected: typeof pending) => {
      order.push('resolve');
      if (live !== expected) return false;
      live = undefined;
      return true;
    });
    type Snapshot = { unchanged: boolean };
    type Value = string;
    type Overrides = Partial<{
      captureSnapshot: () => Promise<Snapshot>;
      revalidate: (snapshot: Snapshot) => void | Promise<void>;
      isUnchanged: (snapshot: Snapshot) => boolean;
      unchangedValue: Value;
      apply: (snapshot: Snapshot) => Promise<Value>;
      persist: (snapshot: Snapshot, value: Value) => Promise<void>;
      rollback: (snapshot: Snapshot) => Promise<void>;
      resolve: (expectedPending: typeof pending) => boolean;
    }>;
    const run = (overrides: Overrides = {}) =>
      runPlanReviewModelApprovalTransaction({
        coordinator,
        requestId: pending.requestId,
        expectedPending: pending,
        readPending: () => live,
        captureSnapshot: async () => {
          order.push('snapshot');
          return { unchanged: false };
        },
        revalidate: () => {
          order.push('revalidate');
        },
        isUnchanged: (snapshot) => snapshot.unchanged,
        unchangedValue: 'unchanged',
        apply,
        persist,
        rollback,
        resolve,
        ...overrides,
      });
    return {
      coordinator,
      pending,
      get live() {
        return live;
      },
      set live(value: typeof pending | undefined) {
        live = value;
      },
      order,
      apply,
      persist,
      rollback,
      resolve,
      run,
    };
  }

  it('approves a no-change selection without model mutation or persistence', async () => {
    const tx = setup();

    await expect(tx.run({ captureSnapshot: async () => ({ unchanged: true }) })).resolves.toBe(
      'unchanged',
    );

    expect(tx.apply).not.toHaveBeenCalled();
    expect(tx.persist).not.toHaveBeenCalled();
    expect(tx.rollback).not.toHaveBeenCalled();
    expect(tx.resolve).toHaveBeenCalledOnce();
  });

  it('persists the complete selection before resolving the plan', async () => {
    const tx = setup();

    await expect(tx.run()).resolves.toBe('applied');

    expect(tx.order).toEqual(['snapshot', 'revalidate', 'apply', 'persist', 'resolve']);
    expect(tx.live).toBeUndefined();
  });

  it.each(['apply', 'persist'] as const)(
    'rolls back an %s failure and keeps the plan pending',
    async (phase) => {
      const tx = setup();
      const failure = new Error(`${phase} failed`);

      await expect(
        tx.run({
          ...(phase === 'apply'
            ? {
                apply: async () => {
                  throw failure;
                },
              }
            : {
                persist: async () => {
                  throw failure;
                },
              }),
        }),
      ).rejects.toBe(failure);

      expect(tx.rollback).toHaveBeenCalledOnce();
      expect(tx.resolve).not.toHaveBeenCalled();
      expect(tx.live).toBe(tx.pending);
    },
  );

  it('rolls back when the pending entry is replaced before resolve', async () => {
    const tx = setup();

    await expect(
      tx.run({
        persist: async () => {
          tx.order.push('persist');
          tx.live = { requestId: 'plan-tx', generation: 2 };
        },
      }),
    ).rejects.toMatchObject({ failure: 'stale' });

    expect(tx.rollback).toHaveBeenCalledOnce();
    expect(tx.resolve).not.toHaveBeenCalled();
  });

  it('surfaces rollback failure distinctly while preserving the pending plan', async () => {
    const tx = setup();

    await expect(
      tx.run({
        persist: async () => {
          throw new Error('persist failed');
        },
        rollback: async () => {
          throw new Error('rollback failed');
        },
      }),
    ).rejects.toMatchObject({ failure: 'rollback_failed' });
    expect(tx.live).toBe(tx.pending);
  });

  it('reserves the request before the first await so the normal resolver cannot win', async () => {
    const tx = setup();
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const running = tx.run({
      captureSnapshot: async () => {
        await snapshotGate;
        return { unchanged: true };
      },
    });

    expect(tx.coordinator.isReserved(tx.pending.requestId)).toBe(true);
    const normalResolve = () => {
      if (tx.coordinator.isReserved(tx.pending.requestId)) return false;
      tx.live = undefined;
      return true;
    };
    expect(normalResolve()).toBe(false);
    expect(tx.live).toBe(tx.pending);

    releaseSnapshot();
    await expect(running).resolves.toBe('unchanged');
  });

  it('fails authoritative route revalidation before mutation and keeps the plan pending', async () => {
    const tx = setup();
    const routeChanged = new Error('live provider changed');

    await expect(
      tx.run({
        revalidate: () => {
          throw routeChanged;
        },
      }),
    ).rejects.toBe(routeChanged);

    expect(tx.apply).not.toHaveBeenCalled();
    expect(tx.persist).not.toHaveBeenCalled();
    expect(tx.rollback).not.toHaveBeenCalled();
    expect(tx.resolve).not.toHaveBeenCalled();
    expect(tx.live).toBe(tx.pending);
  });

  it('fails a dangerous context-window revalidation before mutation and keeps the plan pending', async () => {
    const tx = setup();
    const hotSwitchRequired = new Error('context handoff required');

    await expect(
      tx.run({
        revalidate: () => {
          const assessment = assessPlanReviewModelContextSwitch({
            currentModel: 'large',
            targetModel: 'small',
            contextTokens: resolveConservativePlanReviewContextTokens(120_000, 180_000),
            targetContextWindow: 200_000,
            autoCompactThresholdPct: 90,
          });
          if (assessment.requiresHandoff) throw hotSwitchRequired;
        },
      }),
    ).rejects.toBe(hotSwitchRequired);

    expect(tx.apply).not.toHaveBeenCalled();
    expect(tx.persist).not.toHaveBeenCalled();
    expect(tx.rollback).not.toHaveBeenCalled();
    expect(tx.resolve).not.toHaveBeenCalled();
    expect(tx.live).toBe(tx.pending);
  });
});
