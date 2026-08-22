import type { AgentKind } from '@/hooks/useAgentCapabilities';

export function canChoosePlanImplementationModel(input: {
  hasPendingPlanReview: boolean;
  agentKind: AgentKind;
  /** The exact live route must be known so the approval cannot select a new source. */
  providerId?: string | null;
  remoteHostId?: string | null;
  /** null means confirmed local; undefined is still unresolved and fails closed. */
  deviceLinkDeviceId: string | null | undefined;
  hasAgentSwitchIntent: boolean;
  settingsLocked: boolean;
}): boolean {
  return (
    input.hasPendingPlanReview &&
    input.agentKind === 'codex' &&
    typeof input.providerId === 'string' &&
    input.providerId.trim().length > 0 &&
    !input.remoteHostId &&
    input.deviceLinkDeviceId === null &&
    !input.hasAgentSwitchIntent &&
    !input.settingsLocked
  );
}

export type PlanImplementationApprovalPath = 'atomic' | 'ordinary' | 'stale';

/**
 * Once a request has exposed an implementation-model choice, losing eligibility
 * must not silently downgrade its approval to the ordinary interaction path.
 */
export function planImplementationApprovalPath(input: {
  requestId: string;
  offeredRequestId: string | null;
  featureAvailable: boolean;
  pendingRequestId: string | null;
  selectionRequestId: string | null;
}): PlanImplementationApprovalPath {
  if (
    input.featureAvailable &&
    input.pendingRequestId === input.requestId &&
    input.selectionRequestId === input.requestId
  ) {
    return 'atomic';
  }
  return input.offeredRequestId === input.requestId ? 'stale' : 'ordinary';
}
