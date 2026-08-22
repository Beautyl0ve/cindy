import { describe, expect, it } from 'vitest';

import {
  canChoosePlanImplementationModel,
  planImplementationApprovalPath,
} from '../planImplementationModelEligibility';

const localCodex = {
  hasPendingPlanReview: true,
  agentKind: 'codex' as const,
  providerId: 'openai',
  remoteHostId: null,
  deviceLinkDeviceId: null,
  hasAgentSwitchIntent: false,
  settingsLocked: false,
};

describe('canChoosePlanImplementationModel', () => {
  it('allows only a confirmed-local Codex plan review', () => {
    expect(canChoosePlanImplementationModel(localCodex)).toBe(true);
  });

  it.each([
    ['Claude Code', { agentKind: 'claude-code' as const }],
    ['Pi', { agentKind: 'pi' as const }],
    ['implicit provider route', { providerId: null }],
    ['unresolved provider route', { providerId: undefined }],
    ['SSH remote', { remoteHostId: 'host-1' }],
    ['device-link remote', { deviceLinkDeviceId: 'device-1' }],
    ['unresolved device ownership', { deviceLinkDeviceId: undefined }],
    ['agent switch intent', { hasAgentSwitchIntent: true }],
    ['review session', { settingsLocked: true }],
    ['no plan review', { hasPendingPlanReview: false }],
  ])('hides it for %s', (_label, patch) => {
    expect(canChoosePlanImplementationModel({ ...localCodex, ...patch })).toBe(false);
  });
});

describe('planImplementationApprovalPath', () => {
  it('uses the atomic path while the same offered request remains eligible', () => {
    expect(
      planImplementationApprovalPath({
        requestId: 'plan-1',
        offeredRequestId: 'plan-1',
        featureAvailable: true,
        pendingRequestId: 'plan-1',
        selectionRequestId: 'plan-1',
      }),
    ).toBe('atomic');
  });

  it.each([
    ['provider route disappears', { featureAvailable: false }],
    ['pending request is replaced', { pendingRequestId: 'plan-2' }],
    ['selection belongs to another request', { selectionRequestId: 'plan-2' }],
  ])('fails closed when %s after the model choice was offered', (_label, patch) => {
    expect(
      planImplementationApprovalPath({
        requestId: 'plan-1',
        offeredRequestId: 'plan-1',
        featureAvailable: true,
        pendingRequestId: 'plan-1',
        selectionRequestId: 'plan-1',
        ...patch,
      }),
    ).toBe('stale');
  });

  it('keeps the ordinary approval path for a request that never exposed model selection', () => {
    expect(
      planImplementationApprovalPath({
        requestId: 'plan-ordinary',
        offeredRequestId: null,
        featureAvailable: false,
        pendingRequestId: 'plan-ordinary',
        selectionRequestId: null,
      }),
    ).toBe('ordinary');
  });
});
