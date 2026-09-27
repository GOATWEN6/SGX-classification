import { z } from 'zod';
import { SparseOrganizationResultSchema, StoryUnitSchema, type AssociationCandidate, type StoryUnit } from './content-organization';
import { parseIngestionEnvelope } from './ingestion-contract';
import { digest } from './stage-a-contract';
import { FileClassificationLabStore, LabActionSchema, type LabAction, type LabJobRecord } from './lab-store';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const dateTime = z.string().datetime({ offset: true });
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

export const LabActionRequestSchema = z.object({
  jobId: id,
  actionId: id,
  expectedUpdatedAt: dateTime,
  kind: LabActionSchema.shape.kind,
  targetIds: z.array(id).min(1).max(100).refine(unique, 'DUPLICATE_ACTION_TARGET'),
  actorId: id
}).strict();

export type LabActionRequest = z.infer<typeof LabActionRequestSchema>;
export type LabAuthorizationState = 'active' | 'revoked';
export type LabJobView = LabJobRecord & {
  view: {
    source: 'provider_base_plus_append_only_actions';
    actionCount: number;
    authorizationState: LabAuthorizationState;
  };
};

function fail(code: string): never { throw new Error(code); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function truncate(value: string, max: number): string { return [...value].slice(0, max).join(''); }
function uniqueStrings(values: string[]): string[] { return [...new Set(values)]; }
function sameMembers(left: string[], right: string[]): boolean {
  return [...left].sort().join('/') === [...right].sort().join('/');
}
function nextTimestamp(current: string, candidate: string): string {
  return candidate > current ? candidate : new Date(Date.parse(current) + 1).toISOString();
}

function evidenceIdsForContent(job: LabJobRecord, contentId: string): string[] {
  const evidenceId = job.envelope.contents.find(content => content.contentId === contentId)?.evidenceId;
  return evidenceId ? [evidenceId] : [];
}

function materializedStory(job: LabJobRecord, members: string[], prior?: StoryUnit): StoryUnit {
  const sorted = uniqueStrings(members).sort();
  if(!sorted.length) fail('LAB_EMPTY_STORY');
  const observations = (job.result?.observations ?? []).filter(item => sorted.includes(item.contentId) && item.state === 'candidate');
  const values = (facet: string) => uniqueStrings(observations.filter(item => item.facet === facet).map(item => item.rawValue));
  const event = values('event')[0];
  const theme = values('theme')[0];
  const place = values('place')[0];
  const labels = uniqueStrings([...values('person'), ...values('time'), ...values('place'), ...values('theme')]).slice(0, 4);
  const supports = uniqueStrings([
    ...observations.flatMap(item => [item.evidenceId, ...item.supports.map(support => support.evidenceId)]),
    ...sorted.flatMap(contentId => evidenceIdsForContent(job, contentId))
  ]).slice(0, 64);
  const unchanged = prior && sameMembers(prior.memberContentIds, sorted);
  return StoryUnitSchema.parse({
    storyId: unchanged ? prior.storyId : `story_view_${digest(sorted).slice(7, 31)}`,
    scope: job.scope,
    titleCandidate: truncate(event ?? theme ?? place ?? prior?.titleCandidate ?? '未命名故事', 32),
    summaryCandidate: truncate(`包含${sorted.length}项内容${labels.length ? `，涉及${labels.join('、')}` : ''}`, 120),
    memberContentIds: sorted,
    facets: { people: values('person'), times: values('time'), places: values('place'), themes: values('theme') },
    titleSupports: supports,
    summarySupports: supports,
    state: unchanged ? prior.state : 'ai_candidate'
  });
}

function activeGroupingEdge(association: AssociationCandidate): boolean {
  return Boolean(association.toContentId)
    && ['same_story', 'same_event', 'supports'].includes(association.relation)
    && ['user_confirmed', 'ai_auto'].includes(association.status);
}

function splitDisconnectedStory(job: LabJobRecord, story: StoryUnit): StoryUnit[] {
  if(!job.result || story.memberContentIds.length < 2) return [story];
  const members = new Set(story.memberContentIds);
  const parent = new Map(story.memberContentIds.map(value => [value, value]));
  const find = (value: string): string => {
    const current = parent.get(value)!;
    if(current === value) return value;
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const a = find(left); const b = find(right);
    if(a !== b) parent.set(b, a);
  };
  for(const association of job.result.organization.associations) {
    if(!activeGroupingEdge(association) || !association.toContentId) continue;
    if(members.has(association.fromContentId) && members.has(association.toContentId)) union(association.fromContentId, association.toContentId);
  }
  const groups = new Map<string, string[]>();
  for(const member of story.memberContentIds) groups.set(find(member), [...(groups.get(find(member)) ?? []), member]);
  return [...groups.values()].map(group => materializedStory(job, group, sameMembers(group, story.memberContentIds) ? story : undefined));
}

function removeContentFromStories(job: LabJobRecord, contentId: string, keepSingleton: boolean): void {
  if(!job.result) return;
  const next: StoryUnit[] = [];
  for(const story of job.result.organization.stories) {
    if(!story.memberContentIds.includes(contentId)) { next.push(story); continue; }
    const remaining = story.memberContentIds.filter(value => value !== contentId);
    if(remaining.length) next.push(materializedStory(job, remaining));
    if(keepSingleton) next.push(materializedStory(job, [contentId]));
  }
  job.result.organization.stories = next;
  for(const association of job.result.organization.associations) {
    if(association.fromContentId === contentId || association.toContentId === contentId) association.status = 'rejected';
  }
}

function applyActionToView(job: LabJobRecord, action: LabAction): void {
  const organization = job.result?.organization;
  if(action.kind === 'revoke_authorization') {
    job.status = 'cancelled';
    if(organization) {
      organization.stories.forEach(story => { story.state = 'withdrawn'; });
      organization.associations.forEach(association => { association.status = 'rejected'; });
      organization.reviewItems = uniqueStrings([...organization.reviewItems, 'AUTHORIZATION_REVOKED']);
    }
    return;
  }
  if(action.kind === 'delete_evidence') {
    const evidenceId = action.targetIds[0];
    const evidence = job.envelope.evidence.find(item => item.evidenceId === evidenceId);
    if(!evidence) return;
    const content = job.envelope.contents.find(item => item.evidenceId === evidenceId);
    job.envelope.evidence = job.envelope.evidence.map(item => item.evidenceId === evidenceId
      ? { evidenceId: item.evidenceId, subjectId: item.subjectId, householdId: item.householdId, schemaVersion: item.schemaVersion, revision: item.revision + 1, lifecycleState: 'deleted', deletedAt: action.createdAt }
      : item);
    if(content) content.lifecycleState = 'withdrawn';
    job.assetRefs = job.assetRefs.filter(item => item.evidenceId !== evidenceId);
    delete job.originalTextByEvidenceId[evidenceId];
    if(content && organization) {
      removeContentFromStories(job, content.contentId, false);
      job.result!.observations = job.result!.observations.filter(item => item.evidenceId !== evidenceId && !item.supports.some(support => support.evidenceId === evidenceId));
      organization.associations.forEach(association => {
        if(association.evidenceRefs.includes(evidenceId)) association.status = 'rejected';
      });
      organization.reviewItems = uniqueStrings([...organization.reviewItems, `EVIDENCE_DELETED:${evidenceId}`]);
    }
    job.envelope.bindings = job.envelope.bindings.flatMap(binding => {
      if(content && binding.sourceContentId === content.contentId) return [];
      if(binding.target.kind !== 'contents' || !content || !binding.target.contentIds.includes(content.contentId)) {
        return [{ ...binding, evidenceRefs: binding.evidenceRefs.filter(ref => ref !== evidenceId) }];
      }
      const contentIds = binding.target.contentIds.filter(idValue => idValue !== content.contentId);
      return [{
        ...binding,
        target: contentIds.length ? { kind: 'contents' as const, contentIds } : { kind: 'batch' as const },
        evidenceRefs: binding.evidenceRefs.filter(ref => ref !== evidenceId)
      }];
    });
    return;
  }
  if(!organization) return;
  if(action.kind === 'accept_story') {
    const story = organization.stories.find(item => item.storyId === action.targetIds[0]);
    if(story) story.state = 'user_confirmed';
    return;
  }
  if(action.kind === 'reject_association') {
    const association = organization.associations.find(item => item.associationId === action.targetIds[0]);
    if(!association) return;
    association.status = 'rejected';
    organization.stories = organization.stories.flatMap(story => splitDisconnectedStory(job, story));
    return;
  }
  if(action.kind === 'remove_content' || action.kind === 'split_content') {
    removeContentFromStories(job, action.targetIds[0], action.kind === 'split_content');
    return;
  }
  if(action.kind === 'merge_stories') {
    const selected = organization.stories.filter(story => action.targetIds.includes(story.storyId));
    if(selected.length < 2) return;
    const members = uniqueStrings(selected.flatMap(story => story.memberContentIds));
    organization.stories = [
      ...organization.stories.filter(story => !action.targetIds.includes(story.storyId)),
      materializedStory(job, members)
    ];
  }
}

export function materializeClassificationLabJob(record: LabJobRecord): LabJobView {
  const job = clone(record);
  for(const action of job.actions) applyActionToView(job, action);
  const revoked = job.actions.some(action => action.kind === 'revoke_authorization');
  if(job.result) job.result.organization = SparseOrganizationResultSchema.parse(job.result.organization);
  job.envelope = parseIngestionEnvelope(job.envelope);
  return {
    ...job,
    view: {
      source: 'provider_base_plus_append_only_actions',
      actionCount: job.actions.length,
      authorizationState: revoked ? 'revoked' : 'active'
    }
  };
}

function validateTargets(view: LabJobView, request: LabActionRequest): void {
  const organization = view.result?.organization;
  if(view.view.authorizationState === 'revoked') fail('LAB_AUTHORIZATION_REVOKED');
  if(request.actorId !== view.envelope.actorId) fail('LAB_ACTION_ACTOR_FORBIDDEN');
  const exact = (count: number) => { if(request.targetIds.length !== count) fail('LAB_ACTION_TARGET_COUNT'); };
  if(request.kind === 'accept_story') {
    exact(1); if(!organization?.stories.some(item => item.storyId === request.targetIds[0])) fail('LAB_STORY_NOT_FOUND');
  } else if(request.kind === 'reject_association') {
    exact(1); if(!organization?.associations.some(item => item.associationId === request.targetIds[0])) fail('LAB_ASSOCIATION_NOT_FOUND');
  } else if(request.kind === 'remove_content' || request.kind === 'split_content') {
    exact(1);
    if(!view.envelope.contents.some(item => item.contentId === request.targetIds[0] && item.lifecycleState === 'active')) fail('LAB_CONTENT_NOT_FOUND');
    if(!organization?.stories.some(story => story.memberContentIds.includes(request.targetIds[0]))) fail('LAB_CONTENT_NOT_IN_STORY');
  } else if(request.kind === 'merge_stories') {
    if(request.targetIds.length < 2) fail('LAB_ACTION_TARGET_COUNT');
    if(!organization || request.targetIds.some(target => !organization.stories.some(story => story.storyId === target))) fail('LAB_STORY_NOT_FOUND');
  } else if(request.kind === 'delete_evidence') {
    exact(1);
    if(!view.envelope.evidence.some(item => item.evidenceId === request.targetIds[0] && item.lifecycleState !== 'deleted')) fail('LAB_EVIDENCE_NOT_FOUND');
  } else if(request.kind === 'revoke_authorization') {
    exact(1); if(request.targetIds[0] !== view.envelope.authorizationRevision) fail('LAB_AUTHORIZATION_REVISION_MISMATCH');
  }
}

function sameAction(existing: LabAction, request: LabActionRequest): boolean {
  return existing.actionId === request.actionId
    && existing.kind === request.kind
    && existing.actorId === request.actorId
    && sameMembers(existing.targetIds, request.targetIds);
}

export async function applyClassificationLabAction(
  raw: unknown,
  store = new FileClassificationLabStore(),
  now = () => new Date().toISOString()
): Promise<LabJobView> {
  const request = LabActionRequestSchema.parse(raw);
  const updated = await store.update(request.jobId, current => {
    const existing = current.actions.find(action => action.actionId === request.actionId);
    if(existing) {
      if(!sameAction(existing, request)) fail('LAB_ACTION_ID_CONFLICT');
      return current;
    }
    if(current.updatedAt !== request.expectedUpdatedAt) fail('LAB_ACTION_STALE');
    const view = materializeClassificationLabJob(current);
    validateTargets(view, request);
    const createdAt = nextTimestamp(current.updatedAt, now());
    const action = LabActionSchema.parse({ actionId: request.actionId, kind: request.kind, targetIds: request.targetIds, actorId: request.actorId, createdAt });
    const candidate = materializeClassificationLabJob({ ...current, updatedAt: createdAt, actions: [...current.actions, action] });
    if(candidate.view.authorizationState === 'active' && candidate.result?.organization.stories.some(story => story.memberContentIds.length === 0)) fail('LAB_EMPTY_STORY');
    return { ...current, updatedAt: createdAt, actions: [...current.actions, action] };
  });
  return materializeClassificationLabJob(updated);
}

export async function getClassificationLabJob(jobId: string, store = new FileClassificationLabStore()): Promise<LabJobView | undefined> {
  const record = await store.get(jobId);
  return record ? materializeClassificationLabJob(record) : undefined;
}

export function canReadClassificationLabAsset(job: LabJobView, evidenceId: string): boolean {
  if(job.view.authorizationState !== 'active') return false;
  return job.envelope.evidence.some(item => item.evidenceId === evidenceId && item.lifecycleState === 'active')
    && job.assetRefs.some(item => item.evidenceId === evidenceId);
}
