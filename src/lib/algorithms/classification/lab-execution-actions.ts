import {
  LabActionRequestV2Schema,
  LabActionV2Schema,
  computeLabGrantDigest,
  parseTrustedLabGuardSnapshot,
  type LabActionRequestV2,
  type LabActionV2,
  type LabJobRecordV2,
  type TrustedLabGuardSnapshot
} from './lab-execution-contract';
import {
  listEffectiveLabPrivacyEvents,
  type LabClock,
  type TrustedLabGuardProvider
} from './lab-execution';
import { FileClassificationLabV2Store } from './lab-execution-store';
import { stable } from './stage-a-contract';

const contentActionKinds = new Set<LabActionRequestV2['kind']>([
  'accept_story',
  'reject_association',
  'remove_content',
  'split_content',
  'merge_stories'
]);

export class LabExecutionActionError extends Error {
  constructor(readonly code: string) { super(code); }
}

function fail(code: string): never { throw new LabExecutionActionError(code); }
function equal(left: unknown, right: unknown): boolean { return stable(left) === stable(right); }
function sameTargets(left: readonly string[], right: readonly string[]): boolean {
  return equal([...left].sort(), [...right].sort());
}

function sameAction(existing: LabActionV2, request: LabActionRequestV2): boolean {
  return existing.actionId === request.actionId
    && existing.kind === request.kind
    && existing.actorId === request.actorId
    && sameTargets(existing.targetIds, request.targetIds);
}

function assertTrustedActionGuard(
  job: LabJobRecordV2,
  request: LabActionRequestV2,
  rawGuard: TrustedLabGuardSnapshot
): TrustedLabGuardSnapshot {
  const guard = parseTrustedLabGuardSnapshot(rawGuard);
  if(job.authorization.state !== 'active' || !guard.active) fail('AUTHORIZATION_REVOKED');
  if(request.actorId !== job.authorization.actorId || guard.actorId !== request.actorId) {
    fail('LAB_ACTION_ACTOR_FORBIDDEN');
  }
  if(!guard.purposes.includes('album_organization')) fail('AUTHORIZATION_CHANGED');
  if(!equal(guard.scope, job.envelope.scope)
    || guard.authorityRef !== job.authorization.authorityRef
    || guard.authorizationRevision !== job.authorization.authorizationRevision
    || guard.contextRevision !== job.authorization.contextRevision
    || computeLabGrantDigest(guard) !== job.authorization.grantDigest) {
    fail('AUTHORIZATION_CHANGED');
  }

  const evidenceById = new Map(guard.evidence.map(evidence => [evidence.evidenceId, evidence]));
  if(evidenceById.size !== job.envelope.evidence.length) fail('EVIDENCE_CHANGED');
  for(const evidence of job.envelope.evidence) {
    if(evidence.lifecycleState !== 'active') fail('INACTIVE_EVIDENCE');
    const trusted = evidenceById.get(evidence.evidenceId);
    if(!trusted
      || trusted.revision !== evidence.revision
      || trusted.sourceHash !== evidence.sourceHash
      || trusted.consentRef !== evidence.consentRef) fail('EVIDENCE_CHANGED');
    if(trusted.lifecycleState !== 'active') fail('INACTIVE_EVIDENCE');
    if(!guard.allowedConsentRefs.includes(evidence.consentRef)) fail('AUTHORIZATION_CHANGED');
  }
  return guard;
}

async function getTrustedActionGuard(
  job: LabJobRecordV2,
  request: LabActionRequestV2,
  provider: TrustedLabGuardProvider
): Promise<TrustedLabGuardSnapshot> {
  let raw: TrustedLabGuardSnapshot;
  try { raw = await provider.get(job.jobId); }
  catch { fail('LAB_GUARD_UNAVAILABLE'); }
  try { return assertTrustedActionGuard(job, request, raw); }
  catch(error) {
    if(error instanceof LabExecutionActionError) throw error;
    fail('LAB_GUARD_UNAVAILABLE');
  }
}

function assertExactTargetCount(request: LabActionRequestV2, count: number): void {
  if(request.targetIds.length !== count) fail('LAB_ACTION_TARGET_COUNT');
}

function assertContentActionTargets(job: LabJobRecordV2, request: LabActionRequestV2): void {
  const organization = job.result?.output.organization;
  if(!organization) fail('LAB_RESULT_NOT_AVAILABLE');

  if(request.kind === 'accept_story') {
    assertExactTargetCount(request, 1);
    if(!organization.stories.some(story => story.storyId === request.targetIds[0])) fail('LAB_STORY_NOT_FOUND');
    return;
  }
  if(request.kind === 'reject_association') {
    assertExactTargetCount(request, 1);
    if(!organization.associations.some(association => association.associationId === request.targetIds[0])) {
      fail('LAB_ASSOCIATION_NOT_FOUND');
    }
    return;
  }
  if(request.kind === 'remove_content' || request.kind === 'split_content') {
    assertExactTargetCount(request, 1);
    const contentId = request.targetIds[0];
    if(!job.envelope.contents.some(content => content.contentId === contentId && content.lifecycleState === 'active')) {
      fail('LAB_CONTENT_NOT_FOUND');
    }
    if(!organization.stories.some(story => story.memberContentIds.includes(contentId))) fail('LAB_CONTENT_NOT_IN_STORY');
    return;
  }
  if(request.kind === 'merge_stories') {
    if(request.targetIds.length < 2) fail('LAB_ACTION_TARGET_COUNT');
    if(request.targetIds.some(storyId => !organization.stories.some(story => story.storyId === storyId))) {
      fail('LAB_STORY_NOT_FOUND');
    }
    return;
  }
  fail('LAB_TRUSTED_PRIVACY_EVENT_REQUIRED');
}

function actionTimestamp(current: LabJobRecordV2, clock: LabClock): string {
  const now = new Date(clock.nowMs()).toISOString();
  return Date.parse(now) >= Date.parse(current.updatedAt) ? now : current.updatedAt;
}

/**
 * Appends a v2 content-organization action to the audit ledger.
 *
 * This function deliberately does not materialize the action into the frozen
 * Provider result and has no Memory side effect. Privacy controls use
 * applyTrustedPrivacyEvent instead of this ordinary action path.
 */
export async function applyLabExecutionAction(
  jobId: string,
  rawRequest: unknown,
  options: {
    store: FileClassificationLabV2Store;
    guardProvider: TrustedLabGuardProvider;
    clock: LabClock;
  }
): Promise<LabJobRecordV2> {
  const request = LabActionRequestV2Schema.parse(rawRequest);
  const current = await options.store.get(jobId);
  if(!current) fail('LAB_JOB_NOT_FOUND');

  if(!contentActionKinds.has(request.kind)) fail('LAB_TRUSTED_PRIVACY_EVENT_REQUIRED');

  const existing = current.actions.find(action => action.actionId === request.actionId);
  if(existing && !sameAction(existing, request)) fail('LAB_ACTION_ID_CONFLICT');

  await getTrustedActionGuard(current, request, options.guardProvider);
  return options.store.withRootExclusive(() => options.store.withJobExclusive(jobId, async () => {
    const latest = await options.store.get(jobId);
    if(!latest) fail('LAB_JOB_NOT_FOUND');
    const privacyEvents = await listEffectiveLabPrivacyEvents(latest, options.store);
    if(privacyEvents.some(event => event.kind === 'authorization_revoked')) fail('AUTHORIZATION_REVOKED');
    if(privacyEvents.some(event => event.kind === 'evidence_deleted')) fail('INACTIVE_EVIDENCE');

    const replay = latest.actions.find(action => action.actionId === request.actionId);
    if(replay) {
      if(!sameAction(replay, request)) fail('LAB_ACTION_ID_CONFLICT');
      return latest;
    }

    if(latest.status !== 'succeeded' && latest.status !== 'needs_review') fail('LAB_ACTION_STATUS_INVALID');
    if(latest.revision !== request.expectedRevision) fail('LAB_JOB_REVISION_CONFLICT');
    assertContentActionTargets(latest, request);

    const createdAt = actionTimestamp(latest, options.clock);
    const action = LabActionV2Schema.parse({
      actionId: request.actionId,
      kind: request.kind,
      targetIds: [...request.targetIds],
      actorId: request.actorId,
      createdAt
    });
    const committed = await options.store.compareAndSetTrusted(jobId, request.expectedRevision, value => ({
      ...value,
      updatedAt: createdAt,
      actions: [...value.actions, action]
    }));
    if(committed.ok) return committed.record;

    const raced = committed.record.actions.find(value => value.actionId === request.actionId);
    if(raced) {
      if(!sameAction(raced, request)) fail('LAB_ACTION_ID_CONFLICT');
      return committed.record;
    }
    fail('LAB_JOB_REVISION_CONFLICT');
  }));
}
