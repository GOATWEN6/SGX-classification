import {
  AssociationCandidateSchema,
  ContentItemSchema,
  ContentObservationSchema,
  type AssociationCandidate,
  type ContentItem,
  type ContentObservation,
  type ObservationSupport
} from './content-organization';
import {
  HYBRID_CONTRACT_VERSION,
  HYBRID_SCHEMA_VERSION,
  RetrievalCandidateSchema,
  type RetrievalCandidate
} from './hybrid-contract';
import {
  RequestSchema,
  STAGE_A_VERSION,
  StageError,
  digest,
  sameScope,
  type Observation,
  type Request,
  type Support
} from './stage-a-contract';
import type { Edge, Group } from './stage-a-association';
import type { StageResult } from './stage-a-pipeline';

export const STAGE_A_ORGANIZATION_ADAPTER_VERSION = 'stage-a-organization-adapter.1';

export interface StageAOrganizationInput {
  request: Request;
  result: StageResult;
  createdAt: string;
}

export interface StageAOrganizationAudit {
  adapterVersion: typeof STAGE_A_ORGANIZATION_ADAPTER_VERSION;
  stageContractVersion: typeof STAGE_A_VERSION;
  runId: string;
  snapshotRevision: number;
  modelVersion: string;
  mappedContentCount: number;
  mappedObservationCount: number;
  mappedRetrievalCandidateCount: number;
  mappedExplicitAssociationCount: number;
  sourceGroupIds: string[];
  sourceReviewItems: string[];
}

export interface StageAOrganizationOutput {
  contents: ContentItem[];
  observations: ContentObservation[];
  retrievalCandidates: RetrievalCandidate[];
  explicitAssociations: AssociationCandidate[];
  audit: StageAOrganizationAudit;
}

function fail(code: string): never { throw new StageError(code); }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function pairKey(left: string, right: string, relation: RetrievalCandidate['relation']): string {
  return [...[left, right].sort(), relation].join('/');
}

function evidenceIdForSupport(support: Support): string {
  return support.source === 'user_text' || support.source === 'final_asr'
    ? support.evidenceId ?? fail('TEXT_SUPPORT_REQUIRES_EVIDENCE')
    : support.photoId;
}

function mapSupports(supports: Support[], region?: ObservationSupport['region']): ObservationSupport[] {
  return supports.map(support => ({
    evidenceId: evidenceIdForSupport(support),
    quote: support.quote,
    ...(region && support.source === 'visual' ? { region } : {})
  }));
}

function groupFor(groups: Group[], kind: Group['kind'], photoId: string, faceId?: string): Group | undefined {
  return groups.find(group => group.kind === kind && group.members.some(member =>
    member.photoId === photoId && (kind === 'event' || member.faceId === faceId)));
}

function addObservation(
  target: ContentObservation[],
  content: ContentItem,
  facet: ContentObservation['facet'],
  rawValue: string,
  normalizedValue: string | undefined,
  supports: ObservationSupport[],
  conflicted: boolean
): void {
  if(!supports.length) fail('STAGE_A_OBSERVATION_WITHOUT_SUPPORT');
  if(supports.some(support => !content.evidenceIds.includes(support.evidenceId))) fail('FOREIGN_STAGE_A_SUPPORT');
  target.push(ContentObservationSchema.parse({
    contentId: content.contentId,
    evidenceId: supports[0].evidenceId,
    facet,
    rawValue,
    ...(normalizedValue ? { normalizedValue } : {}),
    supports,
    state: conflicted ? 'conflicted' : 'candidate'
  }));
}

function mapObservation(value: Observation, content: ContentItem, groups: Group[]): ContentObservation[] {
  const mapped: ContentObservation[] = [];
  const conflict = (facet: Observation['conflicts'][number]): boolean => value.conflicts.includes(facet);

  for(const person of value.people) {
    const group = groupFor(groups, 'person', value.photoId, person.faceId);
    addObservation(
      mapped,
      content,
      'person',
      group?.identity?.displayName ?? (person.description || '未命名人物'),
      group?.groupId,
      mapSupports(person.supports, person.box),
      conflict('person')
    );
  }
  for(const mention of value.mentions) {
    addObservation(mapped, content, 'person', mention.text, mention.text.normalize('NFKC').trim(), mapSupports(mention.supports), conflict('person'));
  }
  for(const time of value.times) {
    addObservation(mapped, content, 'time', time.value, time.value, mapSupports(time.supports), conflict('time'));
  }
  for(const place of value.places) {
    addObservation(mapped, content, 'place', place.label, place.canonical ?? place.label, mapSupports(place.supports), conflict('place'));
  }
  for(const event of value.events) {
    addObservation(mapped, content, 'event', event.type, event.type, mapSupports(event.supports), conflict('event'));
  }
  for(const scene of value.scenes) {
    addObservation(mapped, content, 'scene', scene.label, scene.label, mapSupports(scene.supports), conflict('scene'));
  }
  return mapped;
}

function edgeEvidenceRefs(edge: Edge, contentById: Map<string, ContentItem>): string[] {
  const refs = edge.supports.map(evidenceIdForSupport);
  for(const endpoint of [edge.left, edge.right]) refs.push(...(contentById.get(endpoint.photoId)?.evidenceIds ?? []));
  return unique(refs);
}

function retrievalFromEdge(edge: Edge, scope: Request['scope'], contentById: Map<string, ContentItem>, createdAt: string): RetrievalCandidate {
  const relation: RetrievalCandidate['relation'] = edge.kind === 'person' ? 'same_person' : 'same_event';
  return RetrievalCandidateSchema.parse({
    schemaVersion: HYBRID_SCHEMA_VERSION,
    contractVersion: HYBRID_CONTRACT_VERSION,
    candidateId: `candidate_${digest([edge.kind, edge.left, edge.right, edge.decision, edge.deps]).slice(7, 31)}`,
    scope,
    fromContentId: edge.left.photoId,
    toContentId: edge.right.photoId,
    relation,
    rank: 1,
    stageDecision: edge.decision,
    method: STAGE_A_ORGANIZATION_ADAPTER_VERSION,
    coverage: 'selected',
    reasons: [`stage_a_${edge.kind}_edge`, `origin_${edge.origin}`],
    featureRefs: [],
    evidenceRefs: edgeEvidenceRefs(edge, contentById),
    createdAt
  });
}

function explicitFromUserEventEdge(edge: Edge, contentById: Map<string, ContentItem>, createdAt: string): AssociationCandidate {
  return AssociationCandidateSchema.parse({
    associationId: `assoc_${digest(['stage_a_user_event', edge.left, edge.right, edge.decision, edge.deps]).slice(7, 31)}`,
    fromContentId: edge.left.photoId,
    toContentId: edge.right.photoId,
    relation: 'same_event',
    source: 'user_explicit',
    status: edge.decision === 'same' ? 'user_confirmed' : 'rejected',
    method: STAGE_A_ORGANIZATION_ADAPTER_VERSION,
    evidenceRefs: edgeEvidenceRefs(edge, contentById),
    createdAt
  });
}

function retrievalFromGroups(
  groups: Group[],
  scope: Request['scope'],
  contentById: Map<string, ContentItem>,
  existingPairs: Set<string>,
  createdAt: string
): RetrievalCandidate[] {
  const candidates: RetrievalCandidate[] = [];
  for(const group of groups) {
    const relation: RetrievalCandidate['relation'] = group.kind === 'person' ? 'same_person' : 'same_event';
    const contentIds = unique(group.members.map(member => member.photoId)).filter(contentId => contentById.has(contentId)).sort();
    for(let index = 1; index < contentIds.length; index++) {
      const fromContentId = contentIds[index - 1];
      const toContentId = contentIds[index];
      const key = pairKey(fromContentId, toContentId, relation);
      if(existingPairs.has(key)) continue;
      existingPairs.add(key);
      const evidenceRefs = unique([
        ...(contentById.get(fromContentId)?.evidenceIds ?? []),
        ...(contentById.get(toContentId)?.evidenceIds ?? [])
      ]);
      candidates.push(RetrievalCandidateSchema.parse({
        schemaVersion: HYBRID_SCHEMA_VERSION,
        contractVersion: HYBRID_CONTRACT_VERSION,
        candidateId: `candidate_${digest(['stage_a_group', group.groupId, fromContentId, toContentId]).slice(7, 31)}`,
        scope,
        fromContentId,
        toContentId,
        relation,
        rank: index,
        stageDecision: 'same',
        method: STAGE_A_ORGANIZATION_ADAPTER_VERSION,
        coverage: 'selected',
        reasons: [`stage_a_${group.kind}_group`, 'group_is_ai_candidate'],
        featureRefs: [],
        evidenceRefs,
        createdAt
      }));
    }
  }
  return candidates;
}

export function adaptStageAForOrganization(raw: StageAOrganizationInput): StageAOrganizationOutput {
  const request = RequestSchema.parse(raw.request);
  const result = raw.result;
  if(result.contractVersion !== STAGE_A_VERSION || result.runId !== request.runId) fail('STAGE_A_RESULT_MISMATCH');
  if(!sameScope(result.scope, request.scope)) fail('CROSS_SCOPE');
  if(!result.snapshot) fail('STAGE_A_SNAPSHOT_REQUIRED');
  const snapshot = result.snapshot;
  if(!sameScope(snapshot.scope, request.scope)) fail('CROSS_SCOPE');
  if(snapshot.authorizationRevision !== request.authorizationRevision) fail('AUTHORIZATION_CHANGED');

  const contents = request.photos.map(photo => ContentItemSchema.parse({
    contentId: photo.photoId,
    scope: photo.scope,
    modality: 'photo',
    evidenceIds: unique([photo.photoId, ...(photo.textEvidence ?? []).map(evidence => evidence.evidenceId)]),
    ...(photo.exif?.capturedAt ? { capturedAt: photo.exif.capturedAt } : {}),
    lifecycle: photo.active ? 'active' : 'withdrawn'
  }));
  const contentById = new Map(contents.map(content => [content.contentId, content]));
  const observations: ContentObservation[] = [];
  for(const [photoId, cached] of Object.entries(snapshot.observations)) {
    const content = contentById.get(photoId);
    if(!content || content.lifecycle !== 'active') fail('STAGE_A_OBSERVATION_FOR_INACTIVE_CONTENT');
    if(cached.value.photoId !== photoId) fail('STAGE_A_RESULT_MISMATCH');
    observations.push(...mapObservation(cached.value, content, snapshot.groups));
  }

  const retrievalCandidates: RetrievalCandidate[] = [];
  const explicitAssociations: AssociationCandidate[] = [];
  const existingPairs = new Set<string>();
  for(const edge of snapshot.edges) {
    const left = contentById.get(edge.left.photoId);
    const right = contentById.get(edge.right.photoId);
    if(!left || !right || left.lifecycle !== 'active' || right.lifecycle !== 'active') fail('STAGE_A_EDGE_FOR_INACTIVE_CONTENT');
    if(edge.origin === 'user' && edge.kind === 'event' && edge.decision !== 'unknown') {
      explicitAssociations.push(explicitFromUserEventEdge(edge, contentById, raw.createdAt));
      existingPairs.add(pairKey(edge.left.photoId, edge.right.photoId, 'same_event'));
      continue;
    }
    const candidate = retrievalFromEdge(edge, request.scope, contentById, raw.createdAt);
    const key = pairKey(candidate.fromContentId, candidate.toContentId, candidate.relation);
    if(existingPairs.has(key)) fail('DUPLICATE_STAGE_A_EDGE');
    existingPairs.add(key);
    retrievalCandidates.push(candidate);
  }
  retrievalCandidates.push(...retrievalFromGroups(snapshot.groups, request.scope, contentById, existingPairs, raw.createdAt));

  return {
    contents,
    observations,
    retrievalCandidates,
    explicitAssociations,
    audit: {
      adapterVersion: STAGE_A_ORGANIZATION_ADAPTER_VERSION,
      stageContractVersion: STAGE_A_VERSION,
      runId: request.runId,
      snapshotRevision: snapshot.revision,
      modelVersion: snapshot.version,
      mappedContentCount: contents.length,
      mappedObservationCount: observations.length,
      mappedRetrievalCandidateCount: retrievalCandidates.length,
      mappedExplicitAssociationCount: explicitAssociations.length,
      sourceGroupIds: snapshot.groups.map(group => group.groupId),
      sourceReviewItems: [...snapshot.reviewItems]
    }
  };
}
