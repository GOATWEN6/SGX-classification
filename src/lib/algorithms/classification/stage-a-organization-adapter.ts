import { z } from 'zod';
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
  EndpointSchema,
  RequestSchema,
  RelationSchema,
  STAGE_A_VERSION,
  StageError,
  digest,
  endpointKey,
  photoHash,
  sameScope,
  validateObservation,
  type Observation,
  type Photo,
  type Request,
  type Support
} from './stage-a-contract';
import { validateRelation, type CachedObservation, type Edge, type Group } from './stage-a-association';
import type { StageResult } from './stage-a-pipeline';

export const STAGE_A_ORGANIZATION_ADAPTER_VERSION = 'stage-a-organization-adapter.1';

export interface StageAOrganizationInput {
  request: Request;
  result: StageResult;
  createdAt: string;
  contentIdByPhotoId?: Readonly<Record<string, string>>;
  evidenceIdsByPhotoId?: Readonly<Record<string, readonly string[]>>;
  trustedOriginalCaptureEvidenceIds?: readonly string[];
  placeKindPolicy?: { genericLabels: readonly string[] };
  expectedContextHash?: string;
  allowPersonMatching?: boolean;
}

export interface UnresolvedTemporalObservation {
  observationId: string;
  contentId: string;
  rawValue: string;
  normalizedValue: string;
  role: 'role_unknown';
  precision: 'date' | 'year' | 'decade' | 'relative';
  sourceRefs: string[];
  evidenceKinds: Array<'user_text' | 'final_asr' | 'visual_content' | 'ocr_candidate' | 'trusted_original_exif' | 'scan_system_event' | 'server_upload_event'>;
  reason: 'untrusted_capture' | 'role_missing';
  e2RuntimeObservation?: {
    observationId: string;
    facet: 'time';
    kind: 'visible_time_text';
    rawValue: string;
    normalizedValue: string;
    role: 'role_unknown';
    precision: 'exact_day' | 'year' | 'decade' | 'relative';
    sourceRefs: string[];
    evidenceKinds: ['ocr_candidate'];
  };
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
  idMappings: Array<{ stagePhotoId: string; contentId: string }>;
}

export interface StageAOrganizationOutput {
  contents: ContentItem[];
  observations: ContentObservation[];
  retrievalCandidates: RetrievalCandidate[];
  explicitAssociations: AssociationCandidate[];
  reviewItems: string[];
  unresolvedTemporalObservations: UnresolvedTemporalObservation[];
  audit: StageAOrganizationAudit;
}

function fail(code: string): never { throw new StageError(code); }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }

const StageIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const StageHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const StageAEdgeSchema = RelationSchema.extend({
  supports: z.array(RelationSchema.shape.supports.element).max(12),
  deps: z.record(StageHashSchema),
  origin: z.enum(['ai', 'user'])
}).strict();
const StageAGroupSchema = z.object({
  groupId: StageIdSchema,
  kind: z.enum(['person', 'event']),
  members: z.array(EndpointSchema).min(1).max(5000),
  revision: z.number().int().positive(),
  state: z.literal('ai_organized'),
  usableForOrganization: z.boolean(),
  identity: z.object({
    personId: StageIdSchema,
    displayName: z.string().min(1).max(128),
    state: z.literal('reference_label_candidate')
  }).strict().optional(),
  supersedes: z.array(StageIdSchema).max(5000)
}).strict().superRefine((group, context) => {
  if(group.identity && group.kind !== 'person') context.addIssue({ code: z.ZodIssueCode.custom, message: 'EVENT_GROUP_WITH_IDENTITY' });
});

function parseSnapshotEdges(raw: unknown): Edge[] {
  const parsed = z.array(StageAEdgeSchema).safeParse(raw);
  if(!parsed.success) fail('STAGE_A_RESULT_MISMATCH');
  return parsed.data;
}

function parseSnapshotGroups(raw: unknown): Group[] {
  const parsed = z.array(StageAGroupSchema).safeParse(raw);
  if(!parsed.success) fail('STAGE_A_RESULT_MISMATCH');
  return parsed.data;
}
function pairKey(left: string, right: string, relation: RetrievalCandidate['relation']): string {
  return [...[left, right].sort(), relation].join('/');
}

function evidenceIdForSupport(support: Support): string {
  return support.source === 'user_text' || support.source === 'final_asr'
    ? support.evidenceId ?? fail('TEXT_SUPPORT_REQUIRES_EVIDENCE')
    : support.photoId;
}

function sourceTypeForSupport(source: Support['source']): NonNullable<ObservationSupport['sourceType']> { return source; }

function mapSupports(supports: Support[], region?: ObservationSupport['region']): ObservationSupport[] {
  const mapped = supports.map(support => ({
    evidenceId: evidenceIdForSupport(support),
    sourceType: sourceTypeForSupport(support.source),
    quote: support.quote,
    ...(region && support.source === 'visual' ? { region } : {})
  }));
  const deduplicated = new Map(mapped.map(support => [digest(support), support]));
  return [...deduplicated.values()].sort((left, right) =>
    left.evidenceId.localeCompare(right.evidenceId)
      || (left.sourceType ?? '').localeCompare(right.sourceType ?? '')
      || digest(left).localeCompare(digest(right)));
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
  conflicted: boolean,
  qualifiers: Pick<ContentObservation, 'temporal' | 'placeKind'> = {}
): void {
  if(!supports.length) fail('STAGE_A_OBSERVATION_WITHOUT_SUPPORT');
  if(supports.some(support => !content.evidenceIds.includes(support.evidenceId))) fail('FOREIGN_STAGE_A_SUPPORT');
  target.push(ContentObservationSchema.parse({
    contentId: content.contentId,
    evidenceId: supports[0].evidenceId,
    facet,
    rawValue,
    ...(normalizedValue ? { normalizedValue } : {}),
    ...qualifiers,
    supports,
    state: conflicted ? 'conflicted' : 'candidate'
  }));
}

function normalizedLabel(value: string): string { return value.normalize('NFKC').trim().toLowerCase(); }
function temporalEvidenceKind(source: Support['source']): UnresolvedTemporalObservation['evidenceKinds'][number] {
  if(source === 'user_text') return 'user_text';
  if(source === 'final_asr') return 'final_asr';
  if(source === 'ocr') return 'ocr_candidate';
  if(source === 'exif') return 'trusted_original_exif';
  return 'visual_content';
}

function unresolvedTime(value: Observation['times'][number], contentId: string, reason: UnresolvedTemporalObservation['reason']): UnresolvedTemporalObservation {
  const sourceRefs = unique(value.supports.map(evidenceIdForSupport)).sort();
  const evidenceKinds = unique(value.supports.map(support => temporalEvidenceKind(support.source))).sort();
  const observationId = `time_${digest(['role_unknown', contentId, value.value, value.precision, sourceRefs, evidenceKinds]).slice(7, 31)}`;
  const onlyOcr = evidenceKinds.length === 1 && evidenceKinds[0] === 'ocr_candidate';
  return {
    observationId,
    contentId,
    rawValue: value.value,
    normalizedValue: value.value,
    role: 'role_unknown',
    precision: value.precision,
    sourceRefs,
    evidenceKinds,
    reason,
    ...(onlyOcr ? { e2RuntimeObservation: {
      observationId,
      facet: 'time' as const,
      kind: 'visible_time_text' as const,
      rawValue: value.value,
      normalizedValue: value.value,
      role: 'role_unknown' as const,
      precision: value.precision === 'date' ? 'exact_day' as const : value.precision,
      sourceRefs,
      evidenceKinds: ['ocr_candidate'] as ['ocr_candidate']
    } } : {})
  };
}

function mapObservation(
  value: Observation,
  content: ContentItem,
  groups: Group[],
  trustedOriginalCaptureEvidenceIds: ReadonlySet<string>,
  genericLabels: ReadonlySet<string>,
  unresolvedTemporalObservations: UnresolvedTemporalObservation[],
  reviewItems: string[]
): ContentObservation[] {
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
    const trustedRole = ['event', 'scan', 'upload'].includes(time.role) || (time.role === 'capture' && time.supports.some(support =>
      support.source === 'exif' && trustedOriginalCaptureEvidenceIds.has(evidenceIdForSupport(support))));
    if(!trustedRole) {
      const unresolved = unresolvedTime(time, content.contentId, time.role === 'capture' ? 'untrusted_capture' : 'role_missing');
      unresolvedTemporalObservations.push(unresolved);
      reviewItems.push(`ROLE_UNKNOWN_TIME:${unresolved.observationId}`);
      continue;
    }
    addObservation(mapped, content, 'time', time.value, time.value, mapSupports(time.supports), conflict('time'), {
      temporal: { role: time.role, precision: time.precision }
    });
  }
  for(const place of value.places) {
    const normalized = place.canonical ?? place.label;
    const placeKind: NonNullable<ContentObservation['placeKind']> = genericLabels.has(normalizedLabel(place.label)) || genericLabels.has(normalizedLabel(normalized))
      ? 'generic'
      : place.canonical?.trim()
        ? 'named'
        : 'unresolved';
    addObservation(mapped, content, 'place', place.label, normalized, mapSupports(place.supports), conflict('place'), { placeKind });
    if(placeKind === 'unresolved') reviewItems.push(`PLACE_KIND_UNRESOLVED:${content.contentId}:${place.label}`);
  }
  for(const event of value.events) {
    addObservation(mapped, content, 'event', event.type, event.type, mapSupports(event.supports), conflict('event'));
  }
  for(const scene of value.scenes) {
    addObservation(mapped, content, 'scene', scene.label, scene.label, mapSupports(scene.supports), conflict('scene'));
  }
  return mapped;
}

function remapEndpoint<T extends { photoId: string }>(endpoint: T, contentIdByPhotoId: Readonly<Record<string, string>>): T {
  const contentId = contentIdByPhotoId[endpoint.photoId];
  if(!contentId) fail('STAGE_A_EDGE_FOR_INACTIVE_CONTENT');
  return { ...endpoint, photoId: contentId };
}

function remapEdge(edge: Edge, contentIdByPhotoId: Readonly<Record<string, string>>): Edge {
  return { ...edge, left: remapEndpoint(edge.left, contentIdByPhotoId), right: remapEndpoint(edge.right, contentIdByPhotoId) };
}

function remapGroup(group: Group, contentIdByPhotoId: Readonly<Record<string, string>>): Group {
  return { ...group, members: group.members.map(member => remapEndpoint(member, contentIdByPhotoId)) };
}

function sameEndpoints(left: Edge['left'], right: Edge['right'], expectedLeft: Edge['left'], expectedRight: Edge['right']): boolean {
  const actual = [endpointKey(left), endpointKey(right)].sort();
  const expected = [endpointKey(expectedLeft), endpointKey(expectedRight)].sort();
  return actual[0] === expected[0] && actual[1] === expected[1];
}

function validateEdgeDependencies(edge: Edge, photoById: ReadonlyMap<string, Photo>): [Photo, Photo] {
  const left = photoById.get(edge.left.photoId);
  const right = photoById.get(edge.right.photoId);
  if(!left || !right || !left.active || !right.active || left.photoId === right.photoId) fail('STAGE_A_EDGE_FOR_INACTIVE_CONTENT');
  const expectedIds = [left.photoId, right.photoId].sort();
  const dependencyIds = Object.keys(edge.deps).sort();
  if(dependencyIds.length !== expectedIds.length || dependencyIds.some((photoId, index) => photoId !== expectedIds[index])) fail('STAGE_A_RESULT_MISMATCH');
  if(edge.deps[left.photoId] !== photoHash(left) || edge.deps[right.photoId] !== photoHash(right)) fail('STAGE_A_RESULT_MISMATCH');
  return [left, right];
}

function validateSnapshotEdge(edge: Edge, request: Request, observations: Record<string, CachedObservation>, photoById: ReadonlyMap<string, Photo>): Edge {
  const photos = validateEdgeDependencies(edge, photoById);
  if(edge.origin === 'ai') {
    const { deps: _deps, origin: _origin, ...relation } = edge;
    return validateRelation(relation, photos, observations, [photos[0].photoId, photos[1].photoId].sort() as [string, string]);
  }
  const correction = request.corrections.find(candidate => candidate.active
    && candidate.correctionId === edge.rationale
    && candidate.kind === edge.kind
    && candidate.decision === edge.decision
    && sameEndpoints(edge.left, edge.right, candidate.left, candidate.right));
  if(!correction) fail('STAGE_A_RESULT_MISMATCH');
  const left = photoById.get(correction.left.photoId);
  const right = photoById.get(correction.right.photoId);
  if(!left || !right || correction.leftPhotoHash !== left.sourceHash || correction.rightPhotoHash !== right.sourceHash) fail('STAGE_A_RESULT_MISMATCH');
  return edge;
}

function validateGroupMembers(group: Group, observations: Readonly<Record<string, CachedObservation>>): void {
  for(const member of group.members) {
    const observation = observations[member.photoId]?.value;
    if(!observation) fail('STAGE_A_EDGE_FOR_INACTIVE_CONTENT');
    if(group.kind === 'event' && member.faceId) fail('STAGE_A_RESULT_MISMATCH');
    if(group.kind === 'person' && (!member.faceId || !observation.people.some(person => person.faceId === member.faceId))) fail('STAGE_A_RESULT_MISMATCH');
  }
}

function validateObservationProvenance(value: Observation, photoId: string, content: ContentItem): void {
  const supported = new Set(content.evidenceIds);
  const supports = [
    ...value.people.flatMap(item => item.supports),
    ...value.mentions.flatMap(item => item.supports),
    ...value.times.flatMap(item => item.supports),
    ...value.places.flatMap(item => item.supports),
    ...value.events.flatMap(item => item.supports),
    ...value.scenes.flatMap(item => item.supports)
  ];
  if(supports.some(support => support.photoId !== photoId || !supported.has(evidenceIdForSupport(support)))) fail('FOREIGN_STAGE_A_SUPPORT');
}

function edgeEvidenceRefs(edge: Edge, contentById: Map<string, ContentItem>): string[] {
  const refs = edge.supports.map(evidenceIdForSupport);
  for(const endpoint of [edge.left, edge.right]) refs.push(...(contentById.get(endpoint.photoId)?.evidenceIds ?? []));
  return unique(refs);
}

function retrievalFromEdge(edge: Edge, sourceEdgeId: string, scope: Request['scope'], contentById: Map<string, ContentItem>, createdAt: string): RetrievalCandidate {
  const relation: RetrievalCandidate['relation'] = edge.kind === 'person' ? 'same_person' : 'same_event';
  const textSupportedPhotoIds = new Set(edge.supports
    .filter(support => support.source === 'user_text' || support.source === 'final_asr')
    .map(support => support.photoId));
  const twoSidedUserText = edge.kind === 'event'
    && textSupportedPhotoIds.has(edge.left.photoId)
    && textSupportedPhotoIds.has(edge.right.photoId);
  return RetrievalCandidateSchema.parse({
    schemaVersion: HYBRID_SCHEMA_VERSION,
    contractVersion: HYBRID_CONTRACT_VERSION,
    candidateId: `candidate_${digest([STAGE_A_ORGANIZATION_ADAPTER_VERSION, 'edge', sourceEdgeId, edge.left, edge.right, edge.decision]).slice(7, 31)}`,
    scope,
    fromContentId: edge.left.photoId,
    toContentId: edge.right.photoId,
    relation,
    rank: 1,
    stageDecision: edge.decision,
    method: STAGE_A_ORGANIZATION_ADAPTER_VERSION,
    coverage: 'selected',
    reasons: [`stage_a_${edge.kind}_edge`, `origin_${edge.origin}`, ...(twoSidedUserText ? ['two_sided_user_text_support'] : [])],
    featureRefs: [],
    evidenceRefs: edgeEvidenceRefs(edge, contentById),
    createdAt
  });
}

function explicitFromUserEventEdge(edge: Edge, sourceEdgeId: string, contentById: Map<string, ContentItem>, createdAt: string): AssociationCandidate {
  return AssociationCandidateSchema.parse({
    associationId: `assoc_${digest([STAGE_A_ORGANIZATION_ADAPTER_VERSION, 'user_event', sourceEdgeId, edge.left, edge.right, edge.decision]).slice(7, 31)}`,
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
    if(!group.usableForOrganization) continue;
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
        candidateId: `candidate_${digest([STAGE_A_ORGANIZATION_ADAPTER_VERSION, 'group', group.groupId, fromContentId, toContentId]).slice(7, 31)}`,
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
  if(typeof result.providerVersion !== 'string' || !result.providerVersion || result.providerVersion !== snapshot.version) fail('STAGE_A_RESULT_MISMATCH');
  if(raw.expectedContextHash !== undefined) {
    const expectedContextHash = StageHashSchema.safeParse(raw.expectedContextHash);
    if(!expectedContextHash.success || ![expectedContextHash.data, `incomplete:${expectedContextHash.data}`].includes(snapshot.contextHash)) fail('STAGE_A_RESULT_MISMATCH');
  }
  const snapshotEdges = parseSnapshotEdges(snapshot.edges);
  const snapshotGroups = parseSnapshotGroups(snapshot.groups);
  if(raw.allowPersonMatching === false) {
    const forbiddenPersonGroup = snapshotGroups.some(group => group.kind === 'person'
      && (Boolean(group.identity) || new Set(group.members.map(member => member.photoId)).size > 1));
    if(snapshotEdges.some(edge => edge.kind === 'person') || forbiddenPersonGroup) fail('PERSON_MATCHING_NOT_AUTHORIZED');
  }
  if(!sameScope(snapshot.scope, request.scope)) fail('CROSS_SCOPE');
  if(snapshot.authorizationRevision !== request.authorizationRevision) fail('AUTHORIZATION_CHANGED');
  if(snapshot.workflowStatus !== result.workflowStatus) fail('STAGE_A_RESULT_MISMATCH');
  if(snapshot.referencesHash !== digest(request.references) || snapshot.correctionsHash !== digest(request.corrections)) fail('STAGE_A_RESULT_MISMATCH');

  const contentIdByPhotoId = Object.fromEntries(request.photos.map(photo => [photo.photoId, raw.contentIdByPhotoId?.[photo.photoId] ?? photo.photoId]));
  if(new Set(Object.values(contentIdByPhotoId)).size !== request.photos.length) fail('DUPLICATE_ID_MAPPING');
  const trustedOriginalCaptureEvidenceIds = new Set(raw.trustedOriginalCaptureEvidenceIds ?? []);
  for(const evidenceId of trustedOriginalCaptureEvidenceIds) {
    const photo = request.photos.find(candidate => candidate.photoId === evidenceId);
    if(!photo?.active || !photo.exif?.originalCapture || !photo.exif.capturedAt) fail('INVALID_TEMPORAL_QUALIFIER');
  }
  const genericLabels = new Set((raw.placeKindPolicy?.genericLabels ?? []).map(normalizedLabel));
  const contents = request.photos.map(photo => ContentItemSchema.parse({
    contentId: contentIdByPhotoId[photo.photoId],
    scope: photo.scope,
    modality: 'photo',
    evidenceIds: unique([...(raw.evidenceIdsByPhotoId?.[photo.photoId] ?? [photo.photoId, ...(photo.textEvidence ?? []).map(evidence => evidence.evidenceId)])]),
    ...(photo.exif?.capturedAt && trustedOriginalCaptureEvidenceIds.has(photo.photoId) ? { capturedAt: photo.exif.capturedAt } : {}),
    lifecycle: photo.active ? 'active' : 'withdrawn'
  }));
  const contentByStagePhotoId = new Map(request.photos.map((photo, index) => [photo.photoId, contents[index]]));
  const photoById = new Map(request.photos.map(photo => [photo.photoId, photo]));
  const contentById = new Map(contents.map(content => [content.contentId, content]));
  const validatedObservations: Record<string, CachedObservation> = {};
  const observations: ContentObservation[] = [];
  const unresolvedTemporalObservations: UnresolvedTemporalObservation[] = [];
  const reviewItems: string[] = [];
  for(const [photoId, cached] of Object.entries(snapshot.observations)) {
    const content = contentByStagePhotoId.get(photoId);
    const photo = photoById.get(photoId);
    if(!content || content.lifecycle !== 'active') fail('STAGE_A_OBSERVATION_FOR_INACTIVE_CONTENT');
    if(!photo || cached.inputHash !== photoHash(photo) || cached.version !== snapshot.version) fail('STAGE_A_RESULT_MISMATCH');
    validateObservationProvenance(cached.value, photoId, content);
    const value = validateObservation(cached.value, photo);
    validatedObservations[photoId] = { ...cached, value };
    observations.push(...mapObservation(value, content, snapshotGroups, trustedOriginalCaptureEvidenceIds, genericLabels, unresolvedTemporalObservations, reviewItems));
  }

  for(const group of snapshotGroups) validateGroupMembers(group, validatedObservations);

  const retrievalCandidates: RetrievalCandidate[] = [];
  const explicitAssociations: AssociationCandidate[] = [];
  const existingPairs = new Set<string>();
  for(const unvalidatedEdge of snapshotEdges) {
    const edge = validateSnapshotEdge(unvalidatedEdge, request, validatedObservations, photoById);
    const left = contentByStagePhotoId.get(edge.left.photoId);
    const right = contentByStagePhotoId.get(edge.right.photoId);
    if(!left || !right || left.lifecycle !== 'active' || right.lifecycle !== 'active') fail('STAGE_A_EDGE_FOR_INACTIVE_CONTENT');
    const sourceEdgeId = digest(edge);
    const mappedEdge = remapEdge(edge, contentIdByPhotoId);
    if(mappedEdge.origin === 'user' && mappedEdge.kind === 'event' && mappedEdge.decision !== 'unknown') {
      explicitAssociations.push(explicitFromUserEventEdge(mappedEdge, sourceEdgeId, contentById, raw.createdAt));
      existingPairs.add(pairKey(mappedEdge.left.photoId, mappedEdge.right.photoId, 'same_event'));
      continue;
    }
    const candidate = retrievalFromEdge(mappedEdge, sourceEdgeId, request.scope, contentById, raw.createdAt);
    const key = pairKey(candidate.fromContentId, candidate.toContentId, candidate.relation);
    if(existingPairs.has(key)) fail('DUPLICATE_STAGE_A_EDGE');
    existingPairs.add(key);
    retrievalCandidates.push(candidate);
  }
  retrievalCandidates.push(...retrievalFromGroups(snapshotGroups.map(group => remapGroup(group, contentIdByPhotoId)), request.scope, contentById, existingPairs, raw.createdAt));

  return {
    contents,
    observations,
    retrievalCandidates,
    explicitAssociations,
    reviewItems: unique([
      ...snapshot.reviewItems,
      ...reviewItems,
      ...snapshotEdges.filter(edge => edge.decision === 'unknown').map(edge => `UNKNOWN_RELATION:${edge.kind}:${[endpointKey(edge.left), endpointKey(edge.right)].sort().join('/')}`),
      ...Object.values(validatedObservations).flatMap(cached => cached.value.conflicts.map(facet => `CONFLICT:${cached.value.photoId}:${facet}`))
    ]),
    unresolvedTemporalObservations,
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
      sourceGroupIds: snapshotGroups.map(group => group.groupId),
      sourceReviewItems: [...snapshot.reviewItems],
      idMappings: request.photos.map(photo => ({ stagePhotoId: photo.photoId, contentId: contentIdByPhotoId[photo.photoId] }))
    }
  };
}
