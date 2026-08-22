/**
 * Serializes the local Codex "switch model, then approve" boundary.
 *
 * The session mutation itself remains owned by the existing SET_MODEL path. This
 * coordinator only owns the interaction-side compare-and-resolve contract:
 * reserve the exact request, apply the existing transaction, verify that the
 * same pending entry still exists, then resolve it synchronously. Callers supply
 * rollback so a disappearing/replaced request cannot leave a model change behind.
 */

import {
  assessModelSwitchContext,
  shouldHandoffAfterContextAssessment,
  type AssessModelSwitchContextInput,
  type ModelSwitchContextAssessment,
} from '../../shared/modelSwitchAssessment.js';

interface AssessPlanReviewModelContextSwitchInput extends AssessModelSwitchContextInput {
  currentModel: string;
  targetModel: string;
}

export interface PlanReviewModelContextSwitchAssessment extends ModelSwitchContextAssessment {
  requiresHandoff: boolean;
}

/** Keep the newest known usage without trusting an invalid live/DB sample. */
export function resolveConservativePlanReviewContextTokens(
  persistedContextTokens: number,
  liveContextTokens?: number | null,
): number {
  const persisted =
    Number.isFinite(persistedContextTokens) && persistedContextTokens >= 0
      ? persistedContextTokens
      : 0;
  const live =
    typeof liveContextTokens === 'number' &&
    Number.isFinite(liveContextTokens) &&
    liveContextTokens >= 0
      ? liveContextTokens
      : 0;
  return Math.max(persisted, live);
}

/**
 * Applies the shared context-capacity policy to the atomic plan-approval path.
 * A same-model approval only changes preferences, so it cannot shrink the
 * context window and must not be blocked by the switch guard.
 */
export function assessPlanReviewModelContextSwitch(
  input: AssessPlanReviewModelContextSwitchInput,
): PlanReviewModelContextSwitchAssessment {
  if (input.currentModel === input.targetModel) {
    return { level: 'ok', projectedPct: 0, requiresHandoff: false };
  }
  const assessment = assessModelSwitchContext(input);
  return {
    ...assessment,
    requiresHandoff: shouldHandoffAfterContextAssessment(assessment),
  };
}

export type PlanReviewModelApprovalFailure = 'in_flight' | 'stale' | 'rollback_failed';

export class PlanReviewModelApprovalError extends Error {
  constructor(
    readonly failure: PlanReviewModelApprovalFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PlanReviewModelApprovalError';
  }
}

interface PlanReviewModelApprovalInput<TPending extends object> {
  requestId: string;
  expectedPending: TPending;
  readPending: () => TPending | undefined;
}

async function rollbackThenThrow(cause: unknown, rollback: () => Promise<void>): Promise<never> {
  try {
    await rollback();
  } catch (rollbackError) {
    throw new PlanReviewModelApprovalError(
      'rollback_failed',
      'The model change failed and its rollback could not be completed',
      { cause: new AggregateError([cause, rollbackError]) },
    );
  }
  throw cause;
}

export class PlanReviewModelApprovalCoordinator {
  readonly #reservedRequestIds = new Set<string>();

  isReserved(requestId: string): boolean {
    return this.#reservedRequestIds.has(requestId);
  }

  begin<TPending extends object>(
    input: PlanReviewModelApprovalInput<TPending>,
  ): PlanReviewModelApprovalReservation<TPending> {
    if (this.#reservedRequestIds.has(input.requestId)) {
      throw new PlanReviewModelApprovalError(
        'in_flight',
        'This plan approval is already in progress',
      );
    }
    // Deliberately acquired before the first await. The ordinary interaction
    // resolver checks this reservation, so it cannot start the implementation
    // turn while the model transaction is between mutation and revalidation.
    this.#reservedRequestIds.add(input.requestId);
    if (input.readPending() !== input.expectedPending) {
      this.#reservedRequestIds.delete(input.requestId);
      throw new PlanReviewModelApprovalError('stale', 'The plan review is no longer pending');
    }
    return new PlanReviewModelApprovalReservation(input.expectedPending, input.readPending, () =>
      this.#reservedRequestIds.delete(input.requestId),
    );
  }
}

export class PlanReviewModelApprovalReservation<TPending extends object> {
  #released = false;
  readonly #readPending: () => TPending | undefined;
  readonly #releaseReservation: () => void;

  constructor(
    readonly expectedPending: TPending,
    readPending: () => TPending | undefined,
    release: () => void,
  ) {
    this.#readPending = readPending;
    this.#releaseReservation = release;
  }

  async complete<TValue>(input: {
    changed: boolean;
    value: TValue;
    rollback: () => Promise<void>;
    resolve: (expectedPending: TPending) => boolean;
  }): Promise<TValue> {
    if (this.#readPending() !== this.expectedPending) {
      const stale = new PlanReviewModelApprovalError(
        'stale',
        'The plan review changed while the model was being updated',
      );
      if (input.changed) return await rollbackThenThrow(stale, input.rollback);
      throw stale;
    }

    // No await is allowed between the identity check above and this CAS-style
    // resolve. The reservation prevents the normal IPC resolver from racing it.
    let resolved: boolean;
    try {
      resolved = input.resolve(this.expectedPending);
    } catch (cause) {
      if (input.changed) return await rollbackThenThrow(cause, input.rollback);
      throw cause;
    }
    if (!resolved) {
      const stale = new PlanReviewModelApprovalError(
        'stale',
        'The plan review changed before approval could be recorded',
      );
      if (input.changed) return await rollbackThenThrow(stale, input.rollback);
      throw stale;
    }
    return input.value;
  }

  async abort(
    cause: unknown,
    input: {
      changed: boolean;
      rollback: () => Promise<void>;
    },
  ): Promise<never> {
    if (input.changed) return await rollbackThenThrow(cause, input.rollback);
    throw cause;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#releaseReservation();
  }
}

interface RunPlanReviewModelApprovalTransactionInput<TPending extends object, TSnapshot, TValue> {
  coordinator: PlanReviewModelApprovalCoordinator;
  requestId: string;
  expectedPending: TPending;
  readPending: () => TPending | undefined;
  captureSnapshot: () => Promise<TSnapshot>;
  /** Re-check the authoritative live route after the async snapshot read. */
  revalidate: (snapshot: TSnapshot) => void | Promise<void>;
  isUnchanged: (snapshot: TSnapshot) => boolean;
  unchangedValue: TValue;
  apply: (snapshot: TSnapshot) => Promise<TValue>;
  persist: (snapshot: TSnapshot, value: TValue) => Promise<void>;
  rollback: (snapshot: TSnapshot) => Promise<void>;
  resolve: (expectedPending: TPending) => boolean;
}

/**
 * Runs the tested ordering contract around the existing model mutation:
 * reserve -> snapshot/revalidate -> apply -> persist -> exact resolve.
 * Any failure after apply begins rolls the snapshot back while leaving the
 * interaction pending. No-change approvals skip every model-side mutation.
 */
export async function runPlanReviewModelApprovalTransaction<
  TPending extends object,
  TSnapshot,
  TValue,
>(input: RunPlanReviewModelApprovalTransactionInput<TPending, TSnapshot, TValue>): Promise<TValue> {
  const reservation = input.coordinator.begin({
    requestId: input.requestId,
    expectedPending: input.expectedPending,
    readPending: input.readPending,
  });
  let snapshot: TSnapshot | undefined;
  let mutationStarted = false;
  let completionAttempted = false;

  try {
    snapshot = await input.captureSnapshot();
    await input.revalidate(snapshot);
    if (input.isUnchanged(snapshot)) {
      completionAttempted = true;
      return await reservation.complete({
        changed: false,
        value: input.unchangedValue,
        rollback: async () => {},
        resolve: input.resolve,
      });
    }

    mutationStarted = true;
    const value = await input.apply(snapshot);
    await input.persist(snapshot, value);
    completionAttempted = true;
    return await reservation.complete({
      changed: true,
      value,
      rollback: () => input.rollback(snapshot as TSnapshot),
      resolve: input.resolve,
    });
  } catch (error) {
    if (completionAttempted) throw error;
    return await reservation.abort(error, {
      changed: mutationStarted,
      rollback: () => input.rollback(snapshot as TSnapshot),
    });
  } finally {
    reservation.release();
  }
}
