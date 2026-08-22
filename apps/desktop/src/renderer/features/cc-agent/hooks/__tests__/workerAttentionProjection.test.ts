import { describe, expect, it } from 'vitest';

import {
  computeWorkerAttentionUpdates,
  type WorkerAttentionObservedState,
  type WorkerAttentionRecord,
} from '../useOrcaWorkerAttentionWatcher';

function worker(overrides: Partial<WorkerAttentionRecord> = {}): WorkerAttentionRecord {
  return {
    workerId: 'worker-1',
    leadSessionId: 'lead-1',
    status: 'idle',
    focused: false,
    pendingPermissionRequestId: null,
    ...overrides,
  };
}

function observed(
  status: WorkerAttentionObservedState['status'],
  pendingPermissionRequestId: string | null,
): WorkerAttentionObservedState {
  return { status, pendingPermissionRequestId };
}

describe('Worker attention projection', () => {
  it('projects permission and done as two simultaneous reasons', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map(),
      [worker({ status: 'done', pendingPermissionRequestId: 'permission-1' })],
      undefined,
    );

    expect(updates.toMark).toEqual([
      { workerId: 'worker-1', reason: { kind: 'done' } },
      {
        workerId: 'worker-1',
        reason: { kind: 'permission', requestId: 'permission-1' },
      },
    ]);
    expect(updates.toClear).toEqual([]);
  });

  it('clears and replaces only the resolved permission request', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map([['worker-1', observed('done', 'permission-1')]]),
      [worker({ status: 'done', pendingPermissionRequestId: 'permission-2' })],
      undefined,
    );

    expect(updates.toClear).toEqual([
      {
        workerId: 'worker-1',
        reason: { kind: 'permission', requestId: 'permission-1' },
      },
    ]);
    expect(updates.toMark).toEqual([
      {
        workerId: 'worker-1',
        reason: { kind: 'permission', requestId: 'permission-2' },
      },
    ]);
  });

  it('keeps other Workers and other reasons intact during resolution', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map([
        ['worker-1', observed('running', 'permission-1')],
        ['worker-2', observed('idle', 'permission-2')],
      ]),
      [
        worker({ status: 'done', pendingPermissionRequestId: null }),
        worker({
          workerId: 'worker-2',
          leadSessionId: 'lead-2',
          pendingPermissionRequestId: 'permission-2',
        }),
      ],
      undefined,
    );

    expect(updates.toClear).toEqual([
      {
        workerId: 'worker-1',
        reason: { kind: 'permission', requestId: 'permission-1' },
      },
    ]);
    expect(updates.toMark).toEqual([{ workerId: 'worker-1', reason: { kind: 'done' } }]);
    expect(updates.toPrune).toEqual([]);
  });

  it('retains live permission state for a focused Worker while suppressing done unread', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map(),
      [
        worker({
          status: 'done',
          focused: true,
          pendingPermissionRequestId: 'permission-focused',
        }),
      ],
      'lead-1',
    );

    expect(updates.toMark).toEqual([
      {
        workerId: 'worker-1',
        reason: { kind: 'permission', requestId: 'permission-focused' },
      },
    ]);
  });

  it('prunes every reason when a Worker session leaves the team', () => {
    const updates = computeWorkerAttentionUpdates(
      new Map([['worker-1', observed('done', 'permission-1')]]),
      [],
      undefined,
    );

    expect(updates.toPrune).toEqual(['worker-1']);
  });
});
