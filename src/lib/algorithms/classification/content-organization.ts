import { z } from 'zod';
import { digest } from './stage-a-contract';
import {
  DecisionPolicyResultSchema,
  DecisionPolicySchema,
  HYBRID_CONTRACT_VERSION,
  HYBRID_SCHEMA_VERSION,
  RetrievalCandidateSchema,
  type DecisionPolicy,
  type DecisionPolicyResult,
  type RetrievalCandidate
} from './hybrid-contract';

export const SPARSE_CONTENT_ORGANIZATION_VERSION = 'content-organization.3';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const dateTime = z.string().datetime({ offset: true });
const scope = z.object({ householdId: id, subjectId: id }).strict();
const facet = z.enum(['person', 'time', 'place', 'event', 'scene', 'theme', 'content_type']);
const modality = z.enum(['photo', 'user_text', 'final_asr', 'file', 'work']);
const observationSourceType = z.enum(['visual', 'caption', 'exif', 'ocr', 'user_text', 'final_asr']);
const temporalQualifier = z.object({
  role: z.enum(['event', 'capture', 'scan', 'upload']),
  precision: z.enum(['date', 'year', 'decade', 'relative'])
}).strict();
const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) })
  .refine(value => value.x + value.width <= 1 && value.y + value.height <= 1, 'INVALID_REGION');

export const ContentItemSchema = z.object({
  contentId: id,
  scope,
  modality,
  evidenceIds: z.array(id).min(1).max(64),
  title: z.string().min(1).max(32).optional(),
  originalText: z.string().max(65536).optional(),
  capturedAt: dateTime.optional(),
  lifecycle: z.enum(['active', 'withdrawn'])
}).strict();

export const ObservationSupportSchema = z.object({ evidenceId: id, sourceType: observationSourceType.optional(), quote: z.string().min(1).max(1000).optional(), region: region.optional() }).strict();
export const ContentObservationSchema = z.object({
  contentId: id,
  evidenceId: id,
  facet,
  rawValue: z.string().min(1).max(256),
  normalizedValue: z.string().min(1).max(256).optional(),
  temporal: temporalQualifier.optional(),
  placeKind: z.enum(['named', 'generic', 'unresolved']).optional(),
  supports: z.array(ObservationSupportSchema).min(1).max(16),
  state: z.enum(['candidate', 'abstained', 'conflicted'])
}).strict().superRefine((value, ctx) => {
  if(value.temporal && value.facet !== 'time') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_TEMPORAL_QUALIFIER' });
  if(value.placeKind && value.facet !== 'place') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_PLACE_KIND_QUALIFIER' });
});

export const AssociationCandidateSchema = z.object({
  associationId: id,
  fromContentId: id,
  toContentId: id.optional(),
  toStoryId: id.optional(),
  relation: z.enum(['same_story', 'same_event', 'supports', 'related']),
  source: z.enum(['user_explicit', 'ai_inferred']),
  status: z.enum(['user_confirmed', 'ai_auto', 'needs_review', 'not_selected', 'rejected']),
  // Read compatibility for historical replay artifacts. The sparse organizer
  // never writes these fields or uses them to authorize a product action.
  score: z.number().min(0).max(1).optional(),
  confidenceBand: z.enum(['high', 'medium', 'low']).optional(),
  decisionBasis: z.enum(['legacy_overlap', 'stage_relation', 'retrieval_only', 'conflict_guard', 'calibrated_probability']).optional(),
  evidenceStrength: z.enum(['supported', 'conflicted', 'insufficient']).optional(),
  method: z.string().min(1).max(128),
  evidenceRefs: z.array(id).min(1).max(64),
  createdAt: dateTime
}).strict().superRefine((value, ctx) => {
  if(Boolean(value.toContentId) === Boolean(value.toStoryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ASSOCIATION_REQUIRES_ONE_TARGET' });
  if(value.source === 'user_explicit') {
    if(value.status !== 'user_confirmed' && value.status !== 'rejected') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'USER_ASSOCIATION_STATE' });
    if(value.score !== undefined || value.confidenceBand !== undefined || value.decisionBasis !== undefined || value.evidenceStrength !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'USER_ASSOCIATION_HAS_AI_DECISION' });
    }
  }
  if(value.source === 'ai_inferred') {
    if(value.status === 'user_confirmed') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_CANNOT_BE_USER_CONFIRMED' });
    const hasLegacyScore = value.score !== undefined || value.confidenceBand !== undefined;
    const hasDecision = value.decisionBasis !== undefined || value.evidenceStrength !== undefined;
    if(hasLegacyScore && (value.score === undefined || value.confidenceBand === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'LEGACY_ASSOCIATION_SCORE_INCOMPLETE' });
    }
    if(hasDecision && (!value.decisionBasis || !value.evidenceStrength)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_ASSOCIATION_DECISION_INCOMPLETE' });
    }
    if(!hasLegacyScore && !hasDecision) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_ASSOCIATION_REQUIRES_DECISION_BASIS' });
    if(value.decisionBasis && value.decisionBasis !== 'legacy_overlap' && hasLegacyScore) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'NON_CALIBRATED_ASSOCIATION_HAS_LEGACY_SCORE' });
    }
    if(value.decisionBasis === 'legacy_overlap' && !hasLegacyScore) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'LEGACY_ASSOCIATION_REQUIRES_SCORE' });
    }
  }
});

export const StoryUnitSchema = z.object({
  storyId: id,
  scope,
  titleCandidate: z.string().min(1).max(32),
  summaryCandidate: z.string().min(1).max(120),
  memberContentIds: z.array(id).min(1).max(5000),
  facets: z.object({ people: z.array(z.string().min(1).max(256)).max(100), times: z.array(z.string().min(1).max(256)).max(100), places: z.array(z.string().min(1).max(256)).max(100), themes: z.array(z.string().min(1).max(256)).max(100) }).strict(),
  titleSupports: z.array(id).min(1).max(64),
  summarySupports: z.array(id).min(1).max(64),
  state: z.enum(['ai_candidate', 'needs_review', 'user_confirmed', 'withdrawn'])
}).strict();

export const OrganizationInputSchema = z.object({
  scope,
  contents: z.array(ContentItemSchema).min(1).max(5000),
  observations: z.array(ContentObservationSchema).max(30000),
  explicitAssociations: z.array(AssociationCandidateSchema).max(30000),
  createdAt: dateTime
}).strict();

export const SparseAssociationInputSchema = z.object({
  schemaVersion: z.literal(HYBRID_SCHEMA_VERSION),
  contractVersion: z.literal(HYBRID_CONTRACT_VERSION),
  scope,
  contents: z.array(ContentItemSchema).min(1).max(5000),
  observations: z.array(ContentObservationSchema).max(30000),
  retrievalCandidates: z.array(RetrievalCandidateSchema).max(30000),
  explicitAssociations: z.array(AssociationCandidateSchema).max(30000),
  decisionPolicy: DecisionPolicySchema,
  createdAt: dateTime
}).strict();

export const SparseOrganizationResultSchema = z.object({
  version: z.literal(SPARSE_CONTENT_ORGANIZATION_VERSION),
  scope,
  stories: z.array(StoryUnitSchema).max(5000),
  associations: z.array(AssociationCandidateSchema).max(30000),
  decisionResults: z.array(DecisionPolicyResultSchema).max(30000),
  reviewItems: z.array(z.string().min(1).max(256)).max(30000),
  retrievalAudit: z.object({
    candidateCount: z.number().int().nonnegative().max(30000),
    evaluatedCount: z.number().int().nonnegative().max(30000),
    skippedPersonOnlyCount: z.number().int().nonnegative().max(30000),
    maxCandidatesPerContent: z.number().int().min(1).max(128),
    policyMode: z.enum(['shadow', 'active']),
    decisionMode: z.enum(['evidence_rules', 'calibrated_probability'])
  }).strict()
}).strict();

export type Scope = z.infer<typeof scope>;
export type ContentItem = z.infer<typeof ContentItemSchema>;
export type ContentObservation = z.infer<typeof ContentObservationSchema>;
export type ObservationSupport = z.infer<typeof ObservationSupportSchema>;
export type AssociationCandidate = z.infer<typeof AssociationCandidateSchema>;
export type StoryUnit = z.infer<typeof StoryUnitSchema>;
export type OrganizationInput = z.infer<typeof OrganizationInputSchema>;
export type SparseAssociationInput = z.infer<typeof SparseAssociationInputSchema>;
export type SparseOrganizationResult = z.infer<typeof SparseOrganizationResultSchema>;

export class ContentOrganizationError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function fail(code: string): never { throw new ContentOrganizationError(code); }
function sameScope(a: Scope, b: Scope): boolean { return a.householdId === b.householdId && a.subjectId === b.subjectId; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function contentEvidenceIds(content: ContentItem): Set<string> { return new Set(content.evidenceIds); }

function validateOrganizationRecords(input: OrganizationInput): void {
  const contentById = new Map<string, ContentItem>();
  for(const content of input.contents) {
    if(contentById.has(content.contentId)) fail('DUPLICATE_CONTENT');
    if(!sameScope(content.scope, input.scope)) fail('CROSS_SCOPE');
    if(content.lifecycle === 'withdrawn') continue;
    contentById.set(content.contentId, content);
  }
  for(const observation of input.observations) {
    const content = contentById.get(observation.contentId);
    if(!content) fail('OBSERVATION_FOR_WITHDRAWN_OR_FOREIGN_CONTENT');
    if(!contentEvidenceIds(content).has(observation.evidenceId)) fail('FOREIGN_EVIDENCE');
    if(!observation.supports.some(support => support.evidenceId === observation.evidenceId)) fail('OBSERVATION_PRIMARY_SUPPORT_MISSING');
    for(const support of observation.supports) if(!contentEvidenceIds(content).has(support.evidenceId)) fail('FOREIGN_SUPPORT');
  }
  const associationIds = new Set<string>();
  for(const association of input.explicitAssociations) {
    if(associationIds.has(association.associationId)) fail('DUPLICATE_ASSOCIATION');
    associationIds.add(association.associationId);
    if(association.source !== 'user_explicit') fail('EXPLICIT_ASSOCIATION_SOURCE');
    const from = contentById.get(association.fromContentId);
    const to = association.toContentId ? contentById.get(association.toContentId) : undefined;
    if(!from || !to) fail('FOREIGN_ASSOCIATION_CONTENT');
    if(association.evidenceRefs.some(ref => !from.evidenceIds.includes(ref) && !to.evidenceIds.includes(ref))) fail('FOREIGN_ASSOCIATION_EVIDENCE');
  }
}

function withoutRemovedLegacyConfig(raw: unknown): unknown {
  if(!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.prototype.hasOwnProperty.call(raw, 'config')) return raw;
  const record = raw as Record<string, unknown>;
  const legacyConfig = record.config;
  if(legacyConfig !== undefined
    && (!legacyConfig || typeof legacyConfig !== 'object' || Array.isArray(legacyConfig) || Object.keys(legacyConfig).length > 0)) {
    fail('LEGACY_ORGANIZATION_CONFIG_REMOVED');
  }
  const { config: _removed, ...input } = record;
  return input;
}

/** Shared scope, lifecycle and Evidence validation; it performs no scoring. */
export function validateOrganizationInput(raw: unknown): OrganizationInput {
  const input = OrganizationInputSchema.parse(withoutRemovedLegacyConfig(raw));
  validateOrganizationRecords(input);
  return input;
}

export function validateSparseAssociationInput(raw: unknown): SparseAssociationInput {
  const input = SparseAssociationInputSchema.parse(raw);
  if(input.decisionPolicy.decisionMode === 'calibrated_probability') {
    fail('CALIBRATED_DECISION_POLICY_NOT_IMPLEMENTED');
  }
  validateOrganizationRecords({
    scope: input.scope,
    contents: input.contents,
    observations: input.observations,
    explicitAssociations: input.explicitAssociations,
    createdAt: input.createdAt
  });
  const active = new Map(input.contents.filter(content => content.lifecycle === 'active').map(content => [content.contentId, content]));
  const ids = new Set<string>();
  const pairs = new Set<string>();
  const incidentCounts = new Map<string, number>();
  for(const candidate of input.retrievalCandidates) {
    if(ids.has(candidate.candidateId)) fail('DUPLICATE_RETRIEVAL_CANDIDATE');
    ids.add(candidate.candidateId);
    if(!sameScope(candidate.scope, input.scope)) fail('CROSS_SCOPE');
    const from = active.get(candidate.fromContentId);
    const to = active.get(candidate.toContentId);
    if(!from || !to) fail('FOREIGN_RETRIEVAL_CONTENT');
    const pair = [...[candidate.fromContentId, candidate.toContentId].sort(), candidate.relation].join('/');
    if(pairs.has(pair)) fail('DUPLICATE_RETRIEVAL_PAIR');
    pairs.add(pair);
    const allowedEvidence = new Set([...from.evidenceIds, ...to.evidenceIds]);
    if(candidate.evidenceRefs.some(ref => !allowedEvidence.has(ref))) fail('FOREIGN_RETRIEVAL_EVIDENCE');
    for(const contentId of [candidate.fromContentId, candidate.toContentId]) {
      const count = (incidentCounts.get(contentId) ?? 0) + 1;
      incidentCounts.set(contentId, count);
      if(count > input.decisionPolicy.maxCandidatesPerContent) fail('RETRIEVAL_LIMIT_EXCEEDED');
    }
  }
  return input;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  constructor(ids: string[]) { ids.forEach(id => this.parent.set(id, id)); }
  find(id: string): string { const parent = this.parent.get(id); if(!parent) fail('FOREIGN_CONTENT'); if(parent === id) return id; const root = this.find(parent); this.parent.set(id, root); return root; }
  union(a: string, b: string): void { const left = this.find(a); const right = this.find(b); if(left !== right) this.parent.set(right, left); }
  members(id: string): string[] { const root = this.find(id); return [...this.parent.keys()].filter(candidate => this.find(candidate) === root); }
  groups(): Map<string, string[]> { const result = new Map<string, string[]>(); for(const id of this.parent.keys()) { const root = this.find(id); const list = result.get(root) ?? []; list.push(id); result.set(root, list); } return result; }
}

function observationsFor(contentId: string, observations: ContentObservation[]): ContentObservation[] {
  return observations.filter(observation => observation.contentId === contentId && observation.state === 'candidate');
}
function evidenceFor(contentId: string, observations: ContentObservation[]): string[] {
  return unique(observationsFor(contentId, observations).flatMap(observation => [observation.evidenceId, ...observation.supports.map(support => support.evidenceId)]));
}
function hasConflict(left: string, right: string, observations: ContentObservation[]): boolean {
  const facets: ContentObservation['facet'][] = ['person', 'time', 'place', 'event', 'theme'];
  return facets.some(name => observations.some(observation => observation.contentId === left && observation.facet === name && observation.state === 'conflicted') || observations.some(observation => observation.contentId === right && observation.facet === name && observation.state === 'conflicted'));
}
function storyId(contentIds: string[]): string { return `story_${digest(contentIds.sort()).slice(7, 31)}`; }
function truncate(value: string, max: number): string { return [...value].slice(0, max).join(''); }

function buildStory(scopeValue: Scope, members: string[], contents: ContentItem[], observations: ContentObservation[], review: boolean): StoryUnit {
  const memberObservations = observations.filter(observation => members.includes(observation.contentId) && observation.state === 'candidate');
  const values = (facetName: ContentObservation['facet']) => unique(memberObservations
    .filter(observation => observation.facet === facetName)
    .map(observation => observation.rawValue));
  const events = values('event');
  const themes = values('theme');
  const places = values('place');
  const times = values('time');
  const scenes = values('scene');
  const explicitPeople = unique(memberObservations
    .filter(observation => observation.facet === 'person'
      && observation.supports.some(support => support.sourceType && support.sourceType !== 'visual'))
    .map(observation => observation.rawValue));
  const title = truncate(events[0]
    ? `${places.length ? `${places.slice(0, 2).join('与')}的` : ''}${events[0]}`
    : themes[0] ?? places[0] ?? (scenes.length ? `${scenes.slice(0, 2).join('与')}记录` : '待整理内容'), 32);
  const summaryParts = [`共${members.length}项内容`];
  if(events.length) summaryParts.push(`记录${events.slice(0, 2).join('、')}`);
  if(times.length) summaryParts.push(`时间：${times.slice(0, 3).join('、')}`);
  if(places.length) summaryParts.push(`地点：${places.slice(0, 3).join('、')}`);
  if(themes.length) summaryParts.push(`主题：${themes.slice(0, 3).join('、')}`);
  if(explicitPeople.length) summaryParts.push(`相关人物：${explicitPeople.slice(0, 3).join('、')}`);
  if(summaryParts.length === 1 && scenes.length) summaryParts.push(`场景：${scenes.slice(0, 3).join('、')}`);
  const summary = truncate(`${summaryParts.join('；')}。`, 120);
  const contentById = new Map(contents.map(content => [content.contentId, content]));
  const supports = unique(memberObservations.flatMap(observation => [observation.evidenceId, ...observation.supports.map(support => support.evidenceId)]));
  const fallbackSupports = unique(members.flatMap(contentId => contentById.get(contentId)?.evidenceIds ?? []));
  return StoryUnitSchema.parse({ storyId: storyId(members), scope: scopeValue, titleCandidate: title, summaryCandidate: summary, memberContentIds: [...members].sort(), facets: {
    people: unique(memberObservations.filter(observation => observation.facet === 'person').map(observation => observation.rawValue)),
    times: unique(memberObservations.filter(observation => observation.facet === 'time').map(observation => observation.rawValue)),
    places: unique(memberObservations.filter(observation => observation.facet === 'place').map(observation => observation.rawValue)),
    themes: unique(memberObservations.filter(observation => observation.facet === 'theme').map(observation => observation.rawValue))
  }, titleSupports: supports.length ? supports : fallbackSupports, summarySupports: supports.length ? supports : fallbackSupports, state: review ? 'needs_review' : 'ai_candidate' });
}

type AssociationEvidence = { evidenceRefs: string[]; conflicted: boolean };

function associationEvidence(leftContentId: string, rightContentId: string, observations: ContentObservation[]): AssociationEvidence {
  return {
    evidenceRefs: unique([...evidenceFor(leftContentId, observations), ...evidenceFor(rightContentId, observations)]),
    conflicted: hasConflict(leftContentId, rightContentId, observations)
  };
}

type GroupImpact = DecisionPolicyResult['groupImpact'];

function retrievalCandidateOrderKey(candidate: RetrievalCandidate): string {
  const [left, right] = [candidate.fromContentId, candidate.toContentId].sort();
  return [left, right, candidate.relation, candidate.candidateId].join('\u0000');
}

function compareRetrievalCandidates(left: RetrievalCandidate, right: RetrievalCandidate): number {
  const leftKey = retrievalCandidateOrderKey(left);
  const rightKey = retrievalCandidateOrderKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function sparseDecisionResult(
  candidate: RetrievalCandidate,
  evidence: AssociationEvidence,
  policy: DecisionPolicy,
  groupImpact: GroupImpact,
  blockedByKnownDifference: boolean,
  createdAt: string
): DecisionPolicyResult {
  const reasons: string[] = [];
  let action: DecisionPolicyResult['action'] = 'keep_separate';
  let riskLevel: DecisionPolicyResult['riskLevel'] = 'low';
  let basis: DecisionPolicyResult['basis'] = 'retrieval_only';
  let evidenceStrength: DecisionPolicyResult['evidenceStrength'] = 'insufficient';
  // Evidence rules are deterministic guards, not proof that an input belongs
  // to a statistically validated distribution. This stays false until a
  // frozen validation set and calibration artifact exist.
  const inDistribution = false;
  const supportedStageEvent = candidate.relation === 'same_event'
    && candidate.reasons.some(reason => reason === 'stage_a_event_edge' || reason === 'stage_a_event_group');
  if(blockedByKnownDifference) {
    action = 'review';
    riskLevel = 'high';
    basis = 'conflict_guard';
    evidenceStrength = 'conflicted';
    reasons.push('known_difference_blocks_merge');
  } else if(candidate.stageDecision === 'different' && supportedStageEvent) {
    action = 'auto_separate';
    basis = 'stage_relation';
    evidenceStrength = 'supported';
    reasons.push('stage_event_different');
  } else if(candidate.stageDecision === 'same' && supportedStageEvent) {
    basis = 'stage_relation';
    evidenceStrength = evidence.conflicted ? 'conflicted' : 'supported';
    if(evidence.conflicted) {
      action = 'review';
      riskLevel = 'high';
      reasons.push('stage_event_same_with_conflict');
    } else if(groupImpact === 'bridge_existing_groups') {
      action = 'review';
      riskLevel = 'high';
      reasons.push('stage_event_same_bridges_groups');
    } else {
      action = 'auto_link_candidate';
      reasons.push('stage_event_same');
    }
    if(candidate.reasons.includes('two_sided_user_text_support')) reasons.push('two_sided_user_text_support');
  } else if(candidate.stageDecision === 'unknown') {
    reasons.push('stage_unknown_keep_separate');
  } else {
    reasons.push('retrieval_only_no_automation');
  }
  return DecisionPolicyResultSchema.parse({
    schemaVersion: HYBRID_SCHEMA_VERSION,
    contractVersion: HYBRID_CONTRACT_VERSION,
    resultId: `decision_${digest([candidate.candidateId, policy.policyVersion]).slice(7, 31)}`,
    candidateId: candidate.candidateId,
    policyVersion: policy.policyVersion,
    decisionMode: policy.decisionMode,
    basis,
    evidenceStrength,
    groupImpact,
    action,
    riskLevel,
    shadow: policy.mode === 'shadow',
    inDistribution,
    userActionRequired: policy.mode === 'active' && action === 'review',
    reasons,
    createdAt
  });
}

/**
 * Active organization path: only supplied retrieval candidates are evaluated;
 * retrieval scores order recall and never authorize a product action.
 */
export function organizeSparseContent(raw: unknown): SparseOrganizationResult {
  const input = validateSparseAssociationInput(raw);
  const active = input.contents.filter(content => content.lifecycle === 'active');
  const contentIds = active.map(content => content.contentId);
  const contentById = new Map(active.map(content => [content.contentId, content]));
  const union = new UnionFind(contentIds);
  const stableUnion = new UnionFind(contentIds);
  const explicitPairs = new Set<string>();
  const associations: AssociationCandidate[] = [...input.explicitAssociations];
  const reviewItems: string[] = [];
  const decisionResults: DecisionPolicyResult[] = [];
  const knownDifferentPairs = new Set(input.retrievalCandidates
    .filter(candidate => candidate.relation !== 'same_person' && candidate.stageDecision === 'different')
    .map(candidate => [candidate.fromContentId, candidate.toContentId].sort().join('/')));
  for(const association of input.explicitAssociations.filter(item => item.status === 'rejected' && item.toContentId)) {
    knownDifferentPairs.add([association.fromContentId, association.toContentId!].sort().join('/'));
  }

  for(const explicit of input.explicitAssociations) {
    if(!explicit.toContentId) continue;
    explicitPairs.add([explicit.fromContentId, explicit.toContentId].sort().join('/'));
    if(explicit.status === 'user_confirmed' && ['same_story', 'same_event', 'supports'].includes(explicit.relation)) {
      union.union(explicit.fromContentId, explicit.toContentId);
      stableUnion.union(explicit.fromContentId, explicit.toContentId);
    }
  }

  const stableRoots = new Set([...stableUnion.groups().entries()]
    .filter(([, members]) => members.length > 1)
    .map(([root]) => root));
  const stableAnchors = (members: string[]): Set<string> => new Set(members
    .map(contentId => stableUnion.find(contentId))
    .filter(root => stableRoots.has(root)));

  let skippedPersonOnlyCount = 0;
  let evaluatedCount = 0;
  const orderedCandidates = [...input.retrievalCandidates].sort(compareRetrievalCandidates);
  for(const candidate of orderedCandidates) {
    if(candidate.relation === 'same_person') {
      skippedPersonOnlyCount += 1;
      decisionResults.push(DecisionPolicyResultSchema.parse({
        schemaVersion: HYBRID_SCHEMA_VERSION,
        contractVersion: HYBRID_CONTRACT_VERSION,
        resultId: `decision_${digest([candidate.candidateId, input.decisionPolicy.policyVersion]).slice(7, 31)}`,
        candidateId: candidate.candidateId,
        policyVersion: input.decisionPolicy.policyVersion,
        decisionMode: input.decisionPolicy.decisionMode,
        basis: 'person_reference',
        evidenceStrength: 'insufficient',
        groupImpact: 'not_applicable',
        action: 'keep_separate',
        riskLevel: 'low',
        shadow: input.decisionPolicy.mode === 'shadow',
        inDistribution: false,
        userActionRequired: false,
        reasons: ['person_relation_not_story_edge', 'person_matching_disabled'],
        createdAt: input.createdAt
      }));
      continue;
    }
    const pair = [candidate.fromContentId, candidate.toContentId].sort().join('/');
    if(explicitPairs.has(pair)) continue;
    evaluatedCount += 1;
    const evidence = associationEvidence(candidate.fromContentId, candidate.toContentId, input.observations);
    const leftMembers = union.members(candidate.fromContentId);
    const rightMembers = union.members(candidate.toContentId);
    const leftStableRoot = stableUnion.find(candidate.fromContentId);
    const rightStableRoot = stableUnion.find(candidate.toContentId);
    const leftAnchors = stableAnchors(leftMembers);
    const rightAnchors = stableAnchors(rightMembers);
    const bridgesStableGroups = [...leftAnchors].some(left => [...rightAnchors].some(right => left !== right));
    const groupImpact: GroupImpact = leftStableRoot === rightStableRoot
      ? 'not_applicable'
      : bridgesStableGroups || (stableRoots.has(leftStableRoot) && stableRoots.has(rightStableRoot))
        ? 'bridge_existing_groups'
        : stableRoots.has(leftStableRoot) || stableRoots.has(rightStableRoot)
          ? 'extend_story'
          : 'singleton_pair';
    const blockedByKnownDifference = candidate.stageDecision === 'same'
      && leftMembers.some(left => rightMembers.some(right => knownDifferentPairs.has([left, right].sort().join('/'))));
    const decision = sparseDecisionResult(candidate, evidence, input.decisionPolicy, groupImpact, blockedByKnownDifference, input.createdAt);
    decisionResults.push(decision);
    const status: AssociationCandidate['status'] = decision.userActionRequired
      ? 'needs_review'
      : !decision.shadow && decision.action === 'auto_link_candidate'
        ? 'ai_auto'
        : 'not_selected';
    const from = contentById.get(candidate.fromContentId)!;
    const to = contentById.get(candidate.toContentId)!;
    const association = AssociationCandidateSchema.parse({
      associationId: `assoc_${digest([candidate.candidateId, candidate.relation]).slice(7, 31)}`,
      fromContentId: candidate.fromContentId,
      toContentId: candidate.toContentId,
      relation: candidate.relation === 'same_event' ? 'same_event' : candidate.relation === 'same_story' ? 'same_story' : 'related',
      source: 'ai_inferred',
      status,
      decisionBasis: decision.basis,
      evidenceStrength: decision.evidenceStrength,
      method: `${candidate.method}:${input.decisionPolicy.policyVersion}`,
      evidenceRefs: unique([...candidate.evidenceRefs, ...evidence.evidenceRefs, ...from.evidenceIds, ...to.evidenceIds]),
      createdAt: input.createdAt
    });
    associations.push(association);
    if(status === 'ai_auto') union.union(candidate.fromContentId, candidate.toContentId);
    if(status === 'needs_review') {
      reviewItems.push(`NEEDS_REVIEW:${association.associationId}`);
      if(evidence.conflicted) reviewItems.push(`CONFLICT:${association.associationId}`);
    }
  }

  const reviewByRoot = new Set<string>();
  for(const association of associations.filter(item => item.status === 'needs_review')) {
    reviewByRoot.add(union.find(association.fromContentId));
    if(association.toContentId) reviewByRoot.add(union.find(association.toContentId));
  }
  const stories = [...union.groups().values()].map(members => buildStory(
    input.scope,
    members,
    active,
    input.observations,
    reviewByRoot.has(union.find(members[0]))
      || input.observations.some(observation => members.includes(observation.contentId) && observation.state === 'conflicted')
  ));
  return SparseOrganizationResultSchema.parse({
    version: SPARSE_CONTENT_ORGANIZATION_VERSION,
    scope: input.scope,
    stories,
    associations,
    decisionResults,
    reviewItems: unique(reviewItems),
    retrievalAudit: {
      candidateCount: input.retrievalCandidates.length,
      evaluatedCount,
      skippedPersonOnlyCount,
      maxCandidatesPerContent: input.decisionPolicy.maxCandidatesPerContent,
      policyMode: input.decisionPolicy.mode,
      decisionMode: input.decisionPolicy.decisionMode
    }
  });
}
