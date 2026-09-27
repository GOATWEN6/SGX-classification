import { z } from 'zod';
import { digest } from './stage-a-contract';
import {
  DecisionPolicyResultSchema,
  DecisionPolicySchema,
  HYBRID_CONTRACT_VERSION,
  HYBRID_SCHEMA_VERSION,
  RetrievalCandidateSchema,
  type DecisionPolicyResult,
  type RetrievalCandidate
} from './hybrid-contract';

export const CONTENT_ORGANIZATION_VERSION = 'content-organization.1';
export const SPARSE_CONTENT_ORGANIZATION_VERSION = 'content-organization.2';
export const ASSOCIATION_RULES_VERSION = 'association-rules.1';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const dateTime = z.string().datetime({ offset: true });
const scope = z.object({ householdId: id, subjectId: id }).strict();
const facet = z.enum(['person', 'time', 'place', 'event', 'scene', 'theme', 'content_type']);
const modality = z.enum(['photo', 'user_text', 'final_asr', 'file', 'work']);
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

export const ObservationSupportSchema = z.object({ evidenceId: id, quote: z.string().min(1).max(1000).optional(), region: region.optional() }).strict();
export const ContentObservationSchema = z.object({
  contentId: id,
  evidenceId: id,
  facet,
  rawValue: z.string().min(1).max(256),
  normalizedValue: z.string().min(1).max(256).optional(),
  supports: z.array(ObservationSupportSchema).min(1).max(16),
  state: z.enum(['candidate', 'abstained', 'conflicted'])
}).strict();

export const AssociationCandidateSchema = z.object({
  associationId: id,
  fromContentId: id,
  toContentId: id.optional(),
  toStoryId: id.optional(),
  relation: z.enum(['same_story', 'same_event', 'supports', 'related']),
  source: z.enum(['user_explicit', 'ai_inferred']),
  status: z.enum(['user_confirmed', 'ai_auto', 'needs_review', 'not_selected', 'rejected']),
  score: z.number().min(0).max(1).optional(),
  confidenceBand: z.enum(['high', 'medium', 'low']).optional(),
  method: z.string().min(1).max(128),
  evidenceRefs: z.array(id).min(1).max(64),
  createdAt: dateTime
}).strict().superRefine((value, ctx) => {
  if(Boolean(value.toContentId) === Boolean(value.toStoryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ASSOCIATION_REQUIRES_ONE_TARGET' });
  if(value.source === 'user_explicit') {
    if(value.status !== 'user_confirmed' && value.status !== 'rejected') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'USER_ASSOCIATION_STATE' });
    if(value.score !== undefined || value.confidenceBand !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'USER_ASSOCIATION_HAS_SCORE' });
  }
  if(value.source === 'ai_inferred') {
    if(value.status === 'user_confirmed') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_CANNOT_BE_USER_CONFIRMED' });
    if(value.score === undefined || value.confidenceBand === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_ASSOCIATION_REQUIRES_SCORE' });
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

export const OrganizationConfigSchema = z.object({
  autoAssociationThreshold: z.number().min(0).max(1).default(0.8),
  reviewAssociationThreshold: z.number().min(0).max(1).default(0.55),
  method: z.string().min(1).max(128).default(ASSOCIATION_RULES_VERSION)
}).strict().refine(value => value.reviewAssociationThreshold <= value.autoAssociationThreshold, 'INVALID_ASSOCIATION_THRESHOLDS');

export const OrganizationInputSchema = z.object({
  scope,
  contents: z.array(ContentItemSchema).min(1).max(5000),
  observations: z.array(ContentObservationSchema).max(30000),
  explicitAssociations: z.array(AssociationCandidateSchema).max(30000),
  createdAt: dateTime,
  config: OrganizationConfigSchema.default({})
}).strict();

export const OrganizationResultSchema = z.object({
  version: z.literal(CONTENT_ORGANIZATION_VERSION),
  scope,
  stories: z.array(StoryUnitSchema).max(5000),
  associations: z.array(AssociationCandidateSchema).max(30000),
  reviewItems: z.array(z.string().min(1).max(256)).max(30000)
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
    policyMode: z.literal('shadow')
  }).strict()
}).strict();

export type Scope = z.infer<typeof scope>;
export type ContentItem = z.infer<typeof ContentItemSchema>;
export type ContentObservation = z.infer<typeof ContentObservationSchema>;
export type ObservationSupport = z.infer<typeof ObservationSupportSchema>;
export type AssociationCandidate = z.infer<typeof AssociationCandidateSchema>;
export type StoryUnit = z.infer<typeof StoryUnitSchema>;
export type OrganizationConfig = z.infer<typeof OrganizationConfigSchema>;
export type OrganizationInput = z.infer<typeof OrganizationInputSchema>;
export type OrganizationResult = z.infer<typeof OrganizationResultSchema>;
export type SparseAssociationInput = z.infer<typeof SparseAssociationInputSchema>;
export type SparseOrganizationResult = z.infer<typeof SparseOrganizationResultSchema>;

export class ContentOrganizationError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function fail(code: string): never { throw new ContentOrganizationError(code); }
function sameScope(a: Scope, b: Scope): boolean { return a.householdId === b.householdId && a.subjectId === b.subjectId; }
function valueOf(observation: ContentObservation): string { return (observation.normalizedValue ?? observation.rawValue).trim().toLocaleLowerCase(); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function contentEvidenceIds(content: ContentItem): Set<string> { return new Set(content.evidenceIds); }

export function validateOrganizationInput(raw: unknown): OrganizationInput {
  const input = OrganizationInputSchema.parse(raw);
  const contentById = new Map<string, ContentItem>();
  for(const content of input.contents) {
    if(contentById.has(content.contentId)) fail('DUPLICATE_CONTENT');
    if(!sameScope(content.scope, input.scope)) fail('CROSS_SCOPE');
    if(content.lifecycle === 'withdrawn') continue;
    contentById.set(content.contentId, content);
  }
  const observationsByContent = new Map<string, ContentObservation[]>();
  for(const observation of input.observations) {
    const content = contentById.get(observation.contentId);
    if(!content) fail('OBSERVATION_FOR_WITHDRAWN_OR_FOREIGN_CONTENT');
    if(!contentEvidenceIds(content).has(observation.evidenceId)) fail('FOREIGN_EVIDENCE');
    for(const support of observation.supports) {
      if(!contentEvidenceIds(content).has(support.evidenceId)) fail('FOREIGN_SUPPORT');
      if(support.evidenceId !== observation.evidenceId) fail('OBSERVATION_EVIDENCE_MISMATCH');
    }
    const list = observationsByContent.get(observation.contentId) ?? [];
    list.push(observation);
    observationsByContent.set(observation.contentId, list);
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
  return input;
}

export function validateSparseAssociationInput(raw: unknown): SparseAssociationInput {
  const input = SparseAssociationInputSchema.parse(raw);
  if(input.decisionPolicy.mode !== 'shadow') fail('ACTIVE_DECISION_POLICY_NOT_IMPLEMENTED');
  validateOrganizationInput({
    scope: input.scope,
    contents: input.contents,
    observations: input.observations,
    explicitAssociations: input.explicitAssociations,
    createdAt: input.createdAt,
    config: {}
  });
  const active = new Map(input.contents.filter(content => content.lifecycle === 'active').map(content => [content.contentId, content]));
  const ids = new Set<string>();
  const pairs = new Set<string>();
  const perSource = new Map<string, number>();
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
    const count = (perSource.get(candidate.fromContentId) ?? 0) + 1;
    perSource.set(candidate.fromContentId, count);
    if(count > input.decisionPolicy.maxCandidatesPerContent) fail('RETRIEVAL_LIMIT_EXCEEDED');
  }
  return input;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  constructor(ids: string[]) { ids.forEach(id => this.parent.set(id, id)); }
  find(id: string): string { const parent = this.parent.get(id); if(!parent) fail('FOREIGN_CONTENT'); if(parent === id) return id; const root = this.find(parent); this.parent.set(id, root); return root; }
  union(a: string, b: string): void { const left = this.find(a); const right = this.find(b); if(left !== right) this.parent.set(right, left); }
  groups(): Map<string, string[]> { const result = new Map<string, string[]>(); for(const id of this.parent.keys()) { const root = this.find(id); const list = result.get(root) ?? []; list.push(id); result.set(root, list); } return result; }
}

function observationsFor(contentId: string, observations: ContentObservation[]): ContentObservation[] {
  return observations.filter(observation => observation.contentId === contentId && observation.state === 'candidate');
}
function facetValues(contentId: string, facetName: ContentObservation['facet'], observations: ContentObservation[]): string[] {
  return unique(observationsFor(contentId, observations).filter(observation => observation.facet === facetName).map(valueOf));
}
function evidenceFor(contentId: string, observations: ContentObservation[]): string[] {
  return unique(observationsFor(contentId, observations).flatMap(observation => [observation.evidenceId, ...observation.supports.map(support => support.evidenceId)]));
}
function hasConflict(left: string, right: string, observations: ContentObservation[]): boolean {
  const facets: ContentObservation['facet'][] = ['person', 'time', 'place', 'event', 'theme'];
  return facets.some(name => observations.some(observation => observation.contentId === left && observation.facet === name && observation.state === 'conflicted') || observations.some(observation => observation.contentId === right && observation.facet === name && observation.state === 'conflicted'));
}
function overlaps(left: string[], right: string[]): boolean { return left.some(value => right.includes(value)); }

export function scoreAssociation(leftContentId: string, rightContentId: string, observations: ContentObservation[]): { score: number; confidenceBand: AssociationCandidate['confidenceBand']; evidenceRefs: string[]; conflicted: boolean } {
  const weights: Array<[ContentObservation['facet'], number]> = [['time', 0.25], ['place', 0.20], ['event', 0.25], ['person', 0.20], ['theme', 0.10]];
  let score = 0;
  for(const [facetName, weight] of weights) if(overlaps(facetValues(leftContentId, facetName, observations), facetValues(rightContentId, facetName, observations))) score += weight;
  const conflicted = hasConflict(leftContentId, rightContentId, observations);
  if(conflicted) score = Math.min(score, 0.54);
  const confidenceBand = score >= 0.8 ? 'high' : score >= 0.55 ? 'medium' : 'low';
  return { score: Number(score.toFixed(4)), confidenceBand, evidenceRefs: unique([...evidenceFor(leftContentId, observations), ...evidenceFor(rightContentId, observations)]), conflicted };
}

function associationId(left: string, right: string): string { return `assoc_${digest([left, right]).slice(7, 31)}`; }
function storyId(contentIds: string[]): string { return `story_${digest(contentIds.sort()).slice(7, 31)}`; }
function truncate(value: string, max: number): string { return [...value].slice(0, max).join(''); }

function buildStory(scopeValue: Scope, members: string[], contents: ContentItem[], observations: ContentObservation[], explicit: boolean, review: boolean): StoryUnit {
  const memberObservations = observations.filter(observation => members.includes(observation.contentId) && observation.state === 'candidate');
  const event = memberObservations.find(observation => observation.facet === 'event');
  const theme = memberObservations.find(observation => observation.facet === 'theme');
  const place = memberObservations.find(observation => observation.facet === 'place');
  const time = memberObservations.find(observation => observation.facet === 'time');
  const title = truncate(event?.rawValue ?? theme?.rawValue ?? place?.rawValue ?? '未命名故事', 32);
  const facetLabels = unique(memberObservations.filter(observation => ['person', 'time', 'place', 'theme'].includes(observation.facet)).map(observation => observation.rawValue)).slice(0, 4);
  const summary = truncate(`包含${members.length}项内容${facetLabels.length ? `，涉及${facetLabels.join('、')}` : ''}`, 120);
  const contentById = new Map(contents.map(content => [content.contentId, content]));
  const supports = unique(memberObservations.flatMap(observation => [observation.evidenceId, ...observation.supports.map(support => support.evidenceId)]));
  const fallbackSupports = unique(members.flatMap(contentId => contentById.get(contentId)?.evidenceIds ?? []));
  return StoryUnitSchema.parse({ storyId: storyId(members), scope: scopeValue, titleCandidate: title, summaryCandidate: summary, memberContentIds: [...members].sort(), facets: {
    people: unique(memberObservations.filter(observation => observation.facet === 'person').map(observation => observation.rawValue)),
    times: unique(memberObservations.filter(observation => observation.facet === 'time').map(observation => observation.rawValue)),
    places: unique(memberObservations.filter(observation => observation.facet === 'place').map(observation => observation.rawValue)),
    themes: unique(memberObservations.filter(observation => observation.facet === 'theme').map(observation => observation.rawValue))
  }, titleSupports: supports.length ? supports : fallbackSupports, summarySupports: supports.length ? supports : fallbackSupports, state: explicit ? 'user_confirmed' : review ? 'needs_review' : 'ai_candidate' });
}

export function organizeContent(raw: unknown): OrganizationResult {
  const input = validateOrganizationInput(raw);
  const active = input.contents.filter(content => content.lifecycle === 'active');
  const contentIds = active.map(content => content.contentId);
  const observations = input.observations;
  const union = new UnionFind(contentIds);
  const explicitPairs = new Set<string>();
  const associations: AssociationCandidate[] = [...input.explicitAssociations];
  const reviewItems: string[] = [];
  for(const explicit of input.explicitAssociations) {
    if(!explicit.toContentId) continue;
    const pair = [explicit.fromContentId, explicit.toContentId].sort().join('/');
    explicitPairs.add(pair);
    if(explicit.status === 'user_confirmed' && ['same_story', 'same_event', 'supports'].includes(explicit.relation)) union.union(explicit.fromContentId, explicit.toContentId);
  }
  for(let i = 0; i < contentIds.length; i++) for(let j = i + 1; j < contentIds.length; j++) {
    const left = contentIds[i]; const right = contentIds[j]; const pair = [left, right].sort().join('/');
    if(explicitPairs.has(pair)) continue;
    const scored = scoreAssociation(left, right, observations);
    const status: AssociationCandidate['status'] = scored.conflicted ? 'needs_review' : scored.score >= input.config.autoAssociationThreshold ? 'ai_auto' : scored.score >= input.config.reviewAssociationThreshold ? 'needs_review' : 'not_selected';
    const leftContent = active.find(content => content.contentId === left)!;
    const rightContent = active.find(content => content.contentId === right)!;
    const association = AssociationCandidateSchema.parse({ associationId: associationId(left, right), fromContentId: left, toContentId: right, relation: 'same_story', source: 'ai_inferred', status, score: scored.score, confidenceBand: scored.confidenceBand, method: input.config.method, evidenceRefs: scored.evidenceRefs.length ? scored.evidenceRefs : unique([...leftContent.evidenceIds, ...rightContent.evidenceIds]), createdAt: input.createdAt });
    associations.push(association);
    if(status === 'ai_auto') union.union(left, right);
    if(status === 'needs_review') reviewItems.push(`NEEDS_REVIEW:${association.associationId}`);
    if(scored.conflicted) reviewItems.push(`CONFLICT:${association.associationId}`);
  }
  const explicitByRoot = new Set<string>();
  for(const explicit of input.explicitAssociations) if(explicit.status === 'user_confirmed' && explicit.toContentId) explicitByRoot.add(union.find(explicit.fromContentId));
  const reviewByRoot = new Set<string>();
  for(const review of associations.filter(association => association.status === 'needs_review')) { reviewByRoot.add(union.find(review.fromContentId)); if(review.toContentId) reviewByRoot.add(union.find(review.toContentId)); }
  const stories = [...union.groups().values()].map(members => buildStory(input.scope, members, active, observations, explicitByRoot.has(union.find(members[0])), reviewByRoot.has(union.find(members[0]))));
  return OrganizationResultSchema.parse({ version: CONTENT_ORGANIZATION_VERSION, scope: input.scope, stories, associations, reviewItems: unique(reviewItems) });
}

function sparseDecisionResult(candidate: RetrievalCandidate, score: ReturnType<typeof scoreAssociation>, policyVersion: string, createdAt: string): DecisionPolicyResult {
  const reasons: string[] = ['uncalibrated_policy'];
  let action: DecisionPolicyResult['action'] = 'review';
  let riskLevel: DecisionPolicyResult['riskLevel'] = 'medium';
  if(candidate.stageDecision === 'different') {
    action = 'auto_separate';
    riskLevel = 'low';
    reasons.push('stage_different');
  } else if(candidate.stageDecision === 'unknown') {
    reasons.push('stage_unknown');
  } else if(score.conflicted) {
    riskLevel = 'high';
    reasons.push('association_conflict');
  } else if(score.score >= 0.8) {
    action = 'auto_link_candidate';
    riskLevel = 'low';
    reasons.push('legacy_baseline_high_score');
  } else {
    reasons.push('insufficient_link_evidence');
  }
  return DecisionPolicyResultSchema.parse({
    schemaVersion: HYBRID_SCHEMA_VERSION,
    contractVersion: HYBRID_CONTRACT_VERSION,
    resultId: `decision_${digest([candidate.candidateId, policyVersion]).slice(7, 31)}`,
    candidateId: candidate.candidateId,
    policyVersion,
    action,
    riskLevel,
    shadow: true,
    inDistribution: false,
    reasons,
    createdAt
  });
}

/**
 * Hybrid path: only supplied retrieval candidates are evaluated. The legacy
 * all-pairs organizer remains available as a reproducible baseline.
 */
export function organizeSparseContent(raw: unknown): SparseOrganizationResult {
  const input = validateSparseAssociationInput(raw);
  const active = input.contents.filter(content => content.lifecycle === 'active');
  const contentIds = active.map(content => content.contentId);
  const contentById = new Map(active.map(content => [content.contentId, content]));
  const union = new UnionFind(contentIds);
  const explicitPairs = new Set<string>();
  const associations: AssociationCandidate[] = [...input.explicitAssociations];
  const reviewItems: string[] = [];
  const decisionResults: DecisionPolicyResult[] = [];

  for(const explicit of input.explicitAssociations) {
    if(!explicit.toContentId) continue;
    explicitPairs.add([explicit.fromContentId, explicit.toContentId].sort().join('/'));
    if(explicit.status === 'user_confirmed' && ['same_story', 'same_event', 'supports'].includes(explicit.relation)) {
      union.union(explicit.fromContentId, explicit.toContentId);
    }
  }

  let skippedPersonOnlyCount = 0;
  let evaluatedCount = 0;
  for(const candidate of input.retrievalCandidates) {
    if(candidate.relation === 'same_person') {
      skippedPersonOnlyCount += 1;
      decisionResults.push(DecisionPolicyResultSchema.parse({
        schemaVersion: HYBRID_SCHEMA_VERSION,
        contractVersion: HYBRID_CONTRACT_VERSION,
        resultId: `decision_${digest([candidate.candidateId, input.decisionPolicy.policyVersion]).slice(7, 31)}`,
        candidateId: candidate.candidateId,
        policyVersion: input.decisionPolicy.policyVersion,
        action: 'review',
        riskLevel: 'medium',
        shadow: true,
        inDistribution: false,
        reasons: ['person_relation_not_story_edge', 'uncalibrated_policy'],
        createdAt: input.createdAt
      }));
      continue;
    }
    const pair = [candidate.fromContentId, candidate.toContentId].sort().join('/');
    if(explicitPairs.has(pair)) continue;
    evaluatedCount += 1;
    const scored = scoreAssociation(candidate.fromContentId, candidate.toContentId, input.observations);
    const decision = sparseDecisionResult(candidate, scored, input.decisionPolicy.policyVersion, input.createdAt);
    decisionResults.push(decision);
    const status: AssociationCandidate['status'] = candidate.stageDecision === 'different'
      ? 'not_selected'
      : candidate.stageDecision === 'unknown' || scored.conflicted
        ? 'needs_review'
        : scored.score >= 0.8
          ? 'ai_auto'
          : scored.score >= 0.55
            ? 'needs_review'
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
      score: scored.score,
      confidenceBand: scored.confidenceBand,
      method: `${candidate.method}:${ASSOCIATION_RULES_VERSION}`,
      evidenceRefs: unique([...candidate.evidenceRefs, ...scored.evidenceRefs, ...from.evidenceIds, ...to.evidenceIds]),
      createdAt: input.createdAt
    });
    associations.push(association);
    if(status === 'ai_auto') union.union(candidate.fromContentId, candidate.toContentId);
    if(status === 'needs_review') reviewItems.push(`NEEDS_REVIEW:${association.associationId}`);
    if(scored.conflicted) reviewItems.push(`CONFLICT:${association.associationId}`);
  }

  const explicitByRoot = new Set<string>();
  for(const explicit of input.explicitAssociations) {
    if(explicit.status === 'user_confirmed' && explicit.toContentId) explicitByRoot.add(union.find(explicit.fromContentId));
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
    explicitByRoot.has(union.find(members[0])),
    reviewByRoot.has(union.find(members[0]))
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
      policyMode: 'shadow'
    }
  });
}
