import { createHash } from 'node:crypto';
import {
  ContentItemSchema,
  ContentObservationSchema,
  validateOrganizationInput,
  validateSparseAssociationInput,
  type AssociationCandidate,
  type ContentItem,
  type ContentObservation,
  type Scope
} from './content-organization';
import {
  adaptIngestionForOrganization,
  type BatchEvidenceBinding,
  type IngestionOrganizationOutput,
  type IngestionPayloads
} from './ingestion-organization-adapter';
import {
  type EvidenceBinding,
  type IngestionEnvelope
} from './ingestion-contract';
import {
  adaptTrustedStageACatalog,
  type AdaptedStageAInput,
  type TrustedStageACatalog,
  type TrustedTextEvidence
} from './stage-a-adapter';
import {
  adaptStageAForOrganization,
  type UnresolvedTemporalObservation
} from './stage-a-organization-adapter';
import { digest, type Budget, type Correction, type Reference, type Request, type RetrievalHint } from './stage-a-contract';
import type { StageResult } from './stage-a-pipeline';
import {
  HYBRID_CONTRACT_VERSION,
  HYBRID_SCHEMA_VERSION,
  type RetrievalCandidate
} from './hybrid-contract';
import type { EvidenceRecord } from './types';

export const STAGE_A_LAB_PLAN_VERSION = 'classification-lab-stage-a-plan.1';
export const STAGE_A_LAB_COMPOSITION_VERSION = 'classification-lab-stage-a-composition.1';

export interface StageALabAuthorization {
  actorId: string;
  authorityRef: string;
  scope: Scope;
  authorizationRevision: string;
  contextRevision: string;
  active: boolean;
  allowedEvidenceIds: readonly string[];
  allowedConsentRefs: readonly string[];
  allowedCorrectionIds: readonly string[];
  allowPersonMatching: boolean;
  personMatchingEvidenceIds?: readonly string[];
  personConsentRefsByEvidenceId?: Readonly<Record<string, string>>;
}

export interface PlaceKindPolicy {
  policyVersion: string;
  taxonomyVersion: string;
  genericLabels: readonly string[];
  policyDigest: `sha256:${string}`;
}

export interface StageALabPlanInput {
  envelope: IngestionEnvelope;
  payloads: IngestionPayloads;
  imageBytesByEvidenceId: Readonly<Record<string, Uint8Array>>;
  authorization: StageALabAuthorization;
  placeKindPolicy: PlaceKindPolicy;
  runId: string;
  trigger: Request['trigger'];
  budget: Budget;
  createdAt: string;
  references?: Reference[];
  corrections?: Correction[];
  trustedOriginalCaptureEvidenceIds?: readonly string[];
  derivedOcrTextByEvidenceId?: Readonly<Record<string, { sourceHash: `sha256:${string}`; text: string }>>;
  retrievalHints?: readonly RetrievalHint[];
}

export interface ImageRoute {
  contentId: string;
  evidenceId: string;
  stagePhotoId: string;
}

export interface TextRoute {
  bindingId: string;
  sourceContentId: string;
  evidenceId: string;
  modality: 'user_text' | 'final_asr';
  disposition: 'stage_a_single_image' | 'deferred_multi_image' | 'preserved_batch' | 'ai_candidate_only' | 'non_image_target';
  targetContentIds: string[];
}

export interface StageALabPlanAudit {
  adapterVersion: typeof STAGE_A_LAB_PLAN_VERSION;
  inputDigest: `sha256:${string}`;
  authorizationDigest: `sha256:${string}`;
  placeKindPolicyDigest: `sha256:${string}`;
  batchIsolation: true;
  skippedReason?: 'no_active_images';
  externalCalls: 0;
  credentialsRead: false;
  costCny: 0;
  idMappings: ImageRoute[];
  trustedOriginalCaptureEvidenceIds: string[];
  placeKindPolicy: { policyVersion: string; taxonomyVersion: string; genericLabels: string[] };
}

export interface StageALabPlan {
  version: typeof STAGE_A_LAB_PLAN_VERSION;
  stageA?: AdaptedStageAInput;
  baseOrganization: IngestionOrganizationOutput;
  routes: { images: ImageRoute[]; texts: TextRoute[] };
  audit: StageALabPlanAudit;
}

export interface StageALabCompositionAudit {
  adapterVersion: typeof STAGE_A_LAB_COMPOSITION_VERSION;
  inputDigest: `sha256:${string}`;
  stageAExecuted: boolean;
  stageWorkflowStatus?: StageResult['workflowStatus'];
  externalCalls: 0;
  credentialsRead: false;
  costCny: 0;
  sourceStagePhotoIds: string[];
}

export interface StageALabCompositionOutput {
  contents: ContentItem[];
  observations: ContentObservation[];
  retrievalCandidates: RetrievalCandidate[];
  explicitAssociations: AssociationCandidate[];
  batchBindings: BatchEvidenceBinding[];
  reviewItems: string[];
  unresolvedTemporalObservations: UnresolvedTemporalObservation[];
  audit: StageALabCompositionAudit;
}

export class StageALabCompositionError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function fail(code: string): never { throw new StageALabCompositionError(code); }
function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values)].sort(); }
function sameScope(left: Scope, right: Scope): boolean {
  return left.householdId === right.householdId && left.subjectId === right.subjectId;
}
function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function isActive(record: EvidenceRecord): boolean { return record.lifecycleState === 'active'; }
function isTextRecord(record: EvidenceRecord): record is Extract<EvidenceRecord, { modality: 'text' | 'transcript' }> {
  return record.lifecycleState !== 'deleted' && (record.modality === 'text' || record.modality === 'transcript');
}
function isImageRecord(record: EvidenceRecord): record is Extract<EvidenceRecord, { modality: 'image' }> {
  return record.lifecycleState !== 'deleted' && record.modality === 'image';
}
function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
function normalizedGenericLabels(labels: readonly string[]): string[] {
  return uniqueSorted(labels.map(normalizedText).filter(Boolean));
}

export function computePlaceKindPolicyDigest(policy: Pick<PlaceKindPolicy, 'policyVersion' | 'taxonomyVersion' | 'genericLabels'>): `sha256:${string}` {
  return digest({
    policyVersion: policy.policyVersion,
    taxonomyVersion: policy.taxonomyVersion,
    genericLabels: normalizedGenericLabels(policy.genericLabels)
  }) as `sha256:${string}`;
}

function validateRawPartialAsr(envelope: IngestionEnvelope): void {
  for(const record of envelope.evidence as Array<Record<string, unknown>>) {
    if(record.modality === 'transcript' && (record.asr as { final?: unknown } | undefined)?.final !== true) fail('PARTIAL_ASR_NOT_ALLOWED');
  }
}

function validateAuthorization(envelope: IngestionEnvelope, authorization: StageALabAuthorization): void {
  if(!authorization.active) fail('INACTIVE_AUTHORIZATION');
  if(!authorization.actorId || !authorization.authorityRef || !authorization.authorizationRevision || !authorization.contextRevision) fail('NOT_AUTHORIZED');
  if(authorization.actorId !== envelope.actorId) fail('NOT_AUTHORIZED');
  if(!sameScope(authorization.scope, envelope.scope)) fail('CROSS_SCOPE');
  if(authorization.authorizationRevision !== envelope.authorizationRevision) fail('AUTHORIZATION_CHANGED');
  const allowedEvidence = new Set(authorization.allowedEvidenceIds);
  const allowedConsent = new Set(authorization.allowedConsentRefs);
  for(const record of envelope.evidence) {
    if(!isActive(record)) continue;
    if(!allowedEvidence.has(record.evidenceId) || ('consentRef' in record && !allowedConsent.has(record.consentRef))) fail('NOT_AUTHORIZED');
  }
  if(!authorization.allowPersonMatching
    && ((authorization.personMatchingEvidenceIds?.length ?? 0)
      || Object.keys(authorization.personConsentRefsByEvidenceId ?? {}).length)) {
    fail('PERSON_MATCHING_NOT_AUTHORIZED');
  }
  if(authorization.allowPersonMatching) {
    const matchingEvidence = new Set(authorization.personMatchingEvidenceIds ?? []);
    const personConsentRefs = authorization.personConsentRefsByEvidenceId ?? {};
    const activeImages = envelope.evidence.filter(record => isActive(record) && isImageRecord(record));
    if(activeImages.some(record => !matchingEvidence.has(record.evidenceId) || !personConsentRefs[record.evidenceId])) {
      fail('PERSON_CONSENT_MISSING');
    }
    if([...matchingEvidence].some(evidenceId => !activeImages.some(record => record.evidenceId === evidenceId))) {
      fail('NOT_AUTHORIZED');
    }
  }
}

function textDisposition(binding: EvidenceBinding, envelope: IngestionEnvelope): TextRoute['disposition'] {
  if(binding.authority === 'ai_candidate') return 'ai_candidate_only';
  if(binding.target.kind === 'batch') return 'preserved_batch';
  const targets = binding.target.contentIds.map(contentId => envelope.contents.find(content => content.contentId === contentId));
  if(binding.state === 'active' && targets.length === 1 && targets[0]?.lifecycleState === 'active' && targets[0].modality === 'image') return 'stage_a_single_image';
  if(targets.length > 1 && targets.every(target => target?.modality === 'image')) return 'deferred_multi_image';
  return 'non_image_target';
}

function buildTextRoutes(envelope: IngestionEnvelope): TextRoute[] {
  const contentById = new Map(envelope.contents.map(content => [content.contentId, content]));
  return envelope.bindings.map(binding => {
    const source = contentById.get(binding.sourceContentId);
    if(!source || source.modality === 'image') fail('NOT_AUTHORIZED');
    return {
      bindingId: binding.bindingId,
      sourceContentId: source.contentId,
      evidenceId: source.evidenceId,
      modality: source.modality,
      disposition: textDisposition(binding, envelope),
      targetContentIds: binding.target.kind === 'contents' ? [...binding.target.contentIds] : []
    };
  });
}

function assertImageAssets(imageRoutes: ImageRoute[], assets: Readonly<Record<string, Uint8Array>>, envelope: IngestionEnvelope): void {
  const expected = new Set(imageRoutes.map(route => route.evidenceId));
  for(const evidenceId of Object.keys(assets)) if(!expected.has(evidenceId)) fail('FOREIGN_IMAGE_ASSET');
  const records = new Map(envelope.evidence.map(record => [record.evidenceId, record]));
  for(const route of imageRoutes) {
    const bytes = assets[route.evidenceId];
    if(!bytes?.length) fail('MISSING_IMAGE_ASSET');
    const record = records.get(route.evidenceId);
    if(!record || !isImageRecord(record)) fail('MISSING_IMAGE_ASSET');
    if(bytes.byteLength !== record.byteLength) fail('SOURCE_LENGTH_MISMATCH');
    if(hashBytes(bytes) !== record.sourceHash) fail('SOURCE_HASH_MISMATCH');
  }
}

function mapCorrection(
  correction: Correction,
  authorization: StageALabAuthorization,
  stagePhotoIdByContentId: Readonly<Record<string, string>>,
  stagePhotoIds: ReadonlySet<string>
): Correction {
  if(!authorization.allowedCorrectionIds.includes(correction.correctionId) || correction.authorityRef !== authorization.authorityRef) fail('NOT_AUTHORIZED');
  if(correction.kind === 'person' && !authorization.allowPersonMatching) fail('PERSON_MATCHING_NOT_AUTHORIZED');
  const mapPhotoId = (photoId: string): string => stagePhotoIdByContentId[photoId] ?? (stagePhotoIds.has(photoId) ? photoId : fail('NOT_AUTHORIZED'));
  const mapped = {
    ...correction,
    left: { ...correction.left, photoId: mapPhotoId(correction.left.photoId) },
    right: { ...correction.right, photoId: mapPhotoId(correction.right.photoId) }
  };
  if(mapped.kind === 'person') {
    const personConsentRefs = authorization.personConsentRefsByEvidenceId ?? {};
    if(!personConsentRefs[mapped.left.photoId] || !personConsentRefs[mapped.right.photoId]) fail('PERSON_CONSENT_MISSING');
  }
  return mapped;
}

function mapReference(
  reference: Reference,
  authorization: StageALabAuthorization,
  stagePhotoIdByContentId: Readonly<Record<string, string>>,
  stagePhotoIds: ReadonlySet<string>
): Reference {
  if(!authorization.allowPersonMatching) fail('PERSON_MATCHING_NOT_AUTHORIZED');
  const photoId = stagePhotoIdByContentId[reference.endpoint.photoId]
    ?? (stagePhotoIds.has(reference.endpoint.photoId) ? reference.endpoint.photoId : fail('NOT_AUTHORIZED'));
  if(!(authorization.personConsentRefsByEvidenceId ?? {})[photoId]) fail('PERSON_CONSENT_MISSING');
  return { ...reference, endpoint: { ...reference.endpoint, photoId } };
}

export function buildStageALabPlan(input: StageALabPlanInput): StageALabPlan {
  validateRawPartialAsr(input.envelope);
  const baseOrganization = adaptIngestionForOrganization(input.envelope, input.payloads);
  const envelope = baseOrganization.envelope;
  validateAuthorization(envelope, input.authorization);
  if(input.references?.length && !input.authorization.allowPersonMatching) fail('PERSON_MATCHING_NOT_AUTHORIZED');
  const inputCorrections = input.corrections ?? [];
  if(new Set(inputCorrections.map(correction => correction.correctionId)).size !== inputCorrections.length) fail('DUPLICATE_CORRECTION');
  for(const correction of inputCorrections) {
    if(!input.authorization.allowedCorrectionIds.includes(correction.correctionId) || correction.authorityRef !== input.authorization.authorityRef) fail('NOT_AUTHORIZED');
  }

  if(input.placeKindPolicy.taxonomyVersion !== envelope.taxonomyVersion) fail('PLACE_KIND_POLICY_MISMATCH');
  const computedPolicyDigest = computePlaceKindPolicyDigest(input.placeKindPolicy);
  if(computedPolicyDigest !== input.placeKindPolicy.policyDigest) fail('PLACE_KIND_POLICY_DIGEST_MISMATCH');

  const evidenceById = new Map(envelope.evidence.map(record => [record.evidenceId, record]));
  const imageRoutes: ImageRoute[] = envelope.contents
    .filter(content => content.lifecycleState === 'active' && content.modality === 'image')
    .map(content => ({ contentId: content.contentId, evidenceId: content.evidenceId, stagePhotoId: content.evidenceId }));
  if(new Set(imageRoutes.map(route => route.contentId)).size !== imageRoutes.length || new Set(imageRoutes.map(route => route.stagePhotoId)).size !== imageRoutes.length) fail('DUPLICATE_ID_MAPPING');
  assertImageAssets(imageRoutes, input.imageBytesByEvidenceId, envelope);

  const textRoutes = buildTextRoutes(envelope);
  const activeSingleImageRoutes = textRoutes.filter(route => route.disposition === 'stage_a_single_image');
  const textRoutesByTarget = new Map<string, TextRoute[]>();
  for(const route of activeSingleImageRoutes) {
    const target = route.targetContentIds[0];
    textRoutesByTarget.set(target, [...(textRoutesByTarget.get(target) ?? []), route]);
  }

  const trustedOriginalCaptureEvidenceIds = uniqueSorted(input.trustedOriginalCaptureEvidenceIds ?? []);
  const activeImageIds = new Set(imageRoutes.map(route => route.evidenceId));
  if(trustedOriginalCaptureEvidenceIds.some(evidenceId => !activeImageIds.has(evidenceId))) fail('NOT_AUTHORIZED');
  for(const evidenceId of trustedOriginalCaptureEvidenceIds) {
    const record = evidenceById.get(evidenceId);
    if(!record || !isImageRecord(record) || !record.capturedAt) fail('INVALID_TEMPORAL_QUALIFIER');
  }
  const derivedOcrTextByEvidenceId = input.derivedOcrTextByEvidenceId ?? {};
  for(const [evidenceId, derived] of Object.entries(derivedOcrTextByEvidenceId)) {
    const record = evidenceById.get(evidenceId);
    if(!activeImageIds.has(evidenceId) || !record || !isImageRecord(record)) fail('NOT_AUTHORIZED');
    if(derived.sourceHash !== record.sourceHash) fail('SOURCE_HASH_MISMATCH');
    if(!derived.text.trim() || derived.text.length > 16000) fail('INVALID_EVIDENCE_BINDING');
  }
  const retrievalHints = [...(input.retrievalHints ?? [])];
  const hintKeys = new Set<string>();
  for(const hint of retrievalHints) {
    if(!activeImageIds.has(hint.leftPhotoId) || !activeImageIds.has(hint.rightPhotoId)) fail('NOT_AUTHORIZED');
    const key = [hint.kind, ...[hint.leftPhotoId, hint.rightPhotoId].sort(), hint.modelId, hint.modelRevision].join('/');
    if(hintKeys.has(key)) fail('DUPLICATE_RETRIEVAL_HINT');
    hintKeys.add(key);
  }

  let stageA: AdaptedStageAInput | undefined;
  if(imageRoutes.length) {
    const routedEvidence = new Set<string>();
    const stagePhotos = imageRoutes.map(route => {
      const record = evidenceById.get(route.evidenceId);
      if(!record || !isImageRecord(record)) fail('MISSING_IMAGE_ASSET');
      const image = trustedOriginalCaptureEvidenceIds.includes(record.evidenceId)
        ? record
        : ({ ...record, capturedAt: undefined } as typeof record);
      routedEvidence.add(image.evidenceId);
      const textEvidence: TrustedTextEvidence[] = (textRoutesByTarget.get(route.contentId) ?? []).map(textRoute => {
        const textRecord = evidenceById.get(textRoute.evidenceId);
        if(!textRecord || !isTextRecord(textRecord) || !isActive(textRecord)) fail('INACTIVE_EVIDENCE');
        const text = input.payloads.textByEvidenceId[textRoute.evidenceId];
        if(text === undefined) fail('NOT_AUTHORIZED');
        routedEvidence.add(textRecord.evidenceId);
        return { record: textRecord, text };
      });
      return {
        image,
        imageBytes: input.imageBytesByEvidenceId[route.evidenceId],
        ...(derivedOcrTextByEvidenceId[route.evidenceId]?.text.trim()
          ? { ocrText: derivedOcrTextByEvidenceId[route.evidenceId].text.trim() }
          : {}),
        textEvidence
      };
    });
    const stagePhotoIdByContentId = Object.fromEntries(imageRoutes.map(route => [route.contentId, route.stagePhotoId]));
    const stagePhotoIds = new Set(imageRoutes.map(route => route.stagePhotoId));
    const references = (input.references ?? []).map(reference => mapReference(reference, input.authorization, stagePhotoIdByContentId, stagePhotoIds));
    const corrections = inputCorrections.map(correction => mapCorrection(correction, input.authorization, stagePhotoIdByContentId, stagePhotoIds));
    const catalog: TrustedStageACatalog = {
      actorId: input.authorization.actorId,
      scope: envelope.scope,
      authorizationRevision: input.authorization.authorizationRevision,
      contextRevision: input.authorization.contextRevision,
      authorityRef: input.authorization.authorityRef,
      allowPersonMatching: input.authorization.allowPersonMatching,
      allowedEvidenceIds: [...input.authorization.allowedEvidenceIds],
      allowedConsentRefs: [...input.authorization.allowedConsentRefs],
      evidence: envelope.evidence.filter(record => routedEvidence.has(record.evidenceId)).map(record => {
        if(isImageRecord(record) && !trustedOriginalCaptureEvidenceIds.includes(record.evidenceId)) return { ...record, capturedAt: undefined } as typeof record;
        return record;
      }),
      photos: stagePhotos,
      references,
      corrections
    };
    stageA = adaptTrustedStageACatalog(catalog, {
      runId: input.runId,
      trigger: input.trigger,
      budget: input.budget,
      ...(retrievalHints.length ? { retrievalHints } : {})
    });
  }

  const normalizedAuthorization = {
    actorId: input.authorization.actorId,
    authorityRef: input.authorization.authorityRef,
    scope: input.authorization.scope,
    authorizationRevision: input.authorization.authorizationRevision,
    contextRevision: input.authorization.contextRevision,
    active: input.authorization.active,
    allowedEvidenceIds: uniqueSorted(input.authorization.allowedEvidenceIds),
    allowedConsentRefs: uniqueSorted(input.authorization.allowedConsentRefs),
    allowedCorrectionIds: uniqueSorted(input.authorization.allowedCorrectionIds),
    allowPersonMatching: input.authorization.allowPersonMatching,
    personMatchingEvidenceIds: uniqueSorted(input.authorization.personMatchingEvidenceIds ?? []),
    personConsentRefsByEvidenceId: Object.fromEntries(Object.entries(input.authorization.personConsentRefsByEvidenceId ?? {})
      .sort(([left], [right]) => left.localeCompare(right)))
  };
  const authorizationDigest = digest(normalizedAuthorization) as `sha256:${string}`;
  const payloadHashes = Object.entries(input.payloads.textByEvidenceId).sort(([left], [right]) => left.localeCompare(right)).map(([evidenceId, text]) => [evidenceId, hashBytes(Buffer.from(text, 'utf8'))]);
  const imageHashes = Object.entries(input.imageBytesByEvidenceId).sort(([left], [right]) => left.localeCompare(right)).map(([evidenceId, bytes]) => [evidenceId, hashBytes(bytes)]);
  const inputDigest = digest({
    version: STAGE_A_LAB_PLAN_VERSION,
    envelope,
    authorization: normalizedAuthorization,
    payloadHashes,
    imageHashes,
    routes: { images: imageRoutes, texts: textRoutes },
    taxonomyVersion: envelope.taxonomyVersion,
    placeKindPolicyDigest: computedPolicyDigest,
    trustedOriginalCaptureEvidenceIds,
    runId: input.runId,
    trigger: input.trigger,
    budget: input.budget,
    createdAt: input.createdAt,
    references: input.references ?? [],
    corrections: input.corrections ?? [],
    derivedOcrTextByEvidenceId,
    retrievalHints
  }) as `sha256:${string}`;

  return {
    version: STAGE_A_LAB_PLAN_VERSION,
    ...(stageA ? { stageA } : {}),
    baseOrganization,
    routes: { images: imageRoutes, texts: textRoutes },
    audit: {
      adapterVersion: STAGE_A_LAB_PLAN_VERSION,
      inputDigest,
      authorizationDigest,
      placeKindPolicyDigest: computedPolicyDigest,
      batchIsolation: true,
      ...(!stageA ? { skippedReason: 'no_active_images' as const } : {}),
      externalCalls: 0,
      credentialsRead: false,
      costCny: 0,
      idMappings: imageRoutes.map(route => ({ ...route })),
      trustedOriginalCaptureEvidenceIds,
      placeKindPolicy: {
        policyVersion: input.placeKindPolicy.policyVersion,
        taxonomyVersion: input.placeKindPolicy.taxonomyVersion,
        genericLabels: normalizedGenericLabels(input.placeKindPolicy.genericLabels)
      }
    }
  };
}

function mergeImageEvidence(contents: ContentItem[], routes: StageALabPlan['routes']): ContentItem[] {
  const routedByContent = new Map<string, string[]>();
  for(const route of routes.texts.filter(item => item.disposition === 'stage_a_single_image')) {
    const target = route.targetContentIds[0];
    routedByContent.set(target, [...(routedByContent.get(target) ?? []), route.evidenceId]);
  }
  return contents.map(content => ContentItemSchema.parse({
    ...content,
    evidenceIds: uniqueSorted([...content.evidenceIds, ...(routedByContent.get(content.contentId) ?? [])])
  }));
}

function ensureUniqueIds(values: readonly string[], code: string): void {
  if(new Set(values).size !== values.length) fail(code);
}

export function composeStageALabResult(input: {
  plan: StageALabPlan;
  stageResult?: StageResult;
  textObservations?: ContentObservation[];
  createdAt: string;
}): StageALabCompositionOutput {
  if(input.plan.version !== STAGE_A_LAB_PLAN_VERSION) fail('STAGE_A_RESULT_MISMATCH');
  const hasStage = Boolean(input.plan.stageA);
  if(hasStage !== Boolean(input.stageResult)) fail('STAGE_A_RESULT_MISMATCH');
  if(input.stageResult && !input.stageResult.snapshot) fail('STAGE_A_SNAPSHOT_REQUIRED');

  let contents = mergeImageEvidence(input.plan.baseOrganization.contents, input.plan.routes);
  const textContentById = new Map(input.plan.baseOrganization.contents
    .filter(content => content.lifecycle === 'active' && (content.modality === 'user_text' || content.modality === 'final_asr'))
    .map(content => [content.contentId, content]));
  const textObservations = (input.textObservations ?? []).map(observation => {
    const content = textContentById.get(observation.contentId);
    if(!content) fail('FOREIGN_TEXT_OBSERVATION');
    const parsed = ContentObservationSchema.parse(observation);
    const expectedSource = content.modality === 'final_asr' ? 'final_asr' : 'user_text';
    const originalText = content.originalText ? normalizedText(content.originalText) : '';
    if(!content.evidenceIds.includes(parsed.evidenceId)
      || !originalText
      || parsed.supports.some(support => {
        const quote = support.quote ? normalizedText(support.quote) : '';
        return support.sourceType !== expectedSource
          || !content.evidenceIds.includes(support.evidenceId)
          || !quote
          || !originalText.includes(quote);
      })) fail('FOREIGN_TEXT_OBSERVATION');
    return parsed;
  });
  let stageObservations: ContentObservation[] = [];
  let stageRetrievalCandidates: RetrievalCandidate[] = [];
  let stageExplicitAssociations: AssociationCandidate[] = [];
  let stageReviewItems: string[] = [];
  let unresolvedTemporalObservations: UnresolvedTemporalObservation[] = [];
  let sourceStagePhotoIds: string[] = [];

  if(input.plan.stageA && input.stageResult) {
    const contentIdByPhotoId = Object.fromEntries(input.plan.routes.images.map(route => [route.stagePhotoId, route.contentId]));
    const evidenceIdsByPhotoId = Object.fromEntries(input.plan.routes.images.map(route => [
      route.stagePhotoId,
      contents.find(content => content.contentId === route.contentId)?.evidenceIds ?? fail('DUPLICATE_ID_MAPPING')
    ]));
    const expectedContextHash = digest([
      input.plan.stageA.request.photos,
      input.plan.stageA.request.references,
      input.plan.stageA.request.corrections,
      digest(input.plan.stageA.authorization),
      input.stageResult.providerVersion
    ]);
    const stage = adaptStageAForOrganization({
      request: input.plan.stageA.request,
      result: input.stageResult,
      createdAt: input.createdAt,
      expectedContextHash,
      allowPersonMatching: input.plan.stageA.authorization.allowPersonMatching,
      contentIdByPhotoId,
      evidenceIdsByPhotoId,
      trustedOriginalCaptureEvidenceIds: input.plan.audit.trustedOriginalCaptureEvidenceIds,
      placeKindPolicy: { genericLabels: input.plan.audit.placeKindPolicy.genericLabels }
    });
    stageObservations = stage.observations;
    stageRetrievalCandidates = stage.retrievalCandidates;
    stageExplicitAssociations = stage.explicitAssociations;
    stageReviewItems = stage.reviewItems;
    unresolvedTemporalObservations = stage.unresolvedTemporalObservations;
    sourceStagePhotoIds = stage.audit.idMappings.map(mapping => mapping.stagePhotoId);
    const stageContentById = new Map(stage.contents.map(content => [content.contentId, content]));
    contents = contents.map(content => {
      const stageContent = stageContentById.get(content.contentId);
      return stageContent?.capturedAt ? ContentItemSchema.parse({ ...content, capturedAt: stageContent.capturedAt }) : content;
    });
  }

  const observations = [...textObservations, ...stageObservations].sort((left, right) =>
    left.contentId.localeCompare(right.contentId) || left.facet.localeCompare(right.facet) || digest(left).localeCompare(digest(right)));
  const retrievalCandidates = [...input.plan.baseOrganization.retrievalCandidates, ...stageRetrievalCandidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const explicitAssociations = [...input.plan.baseOrganization.explicitAssociations, ...stageExplicitAssociations].sort((left, right) => left.associationId.localeCompare(right.associationId));
  ensureUniqueIds(retrievalCandidates.map(candidate => candidate.candidateId), 'DUPLICATE_ID_MAPPING');
  ensureUniqueIds(explicitAssociations.map(association => association.associationId), 'DUPLICATE_ID_MAPPING');
  validateOrganizationInput({
    scope: input.plan.baseOrganization.envelope.scope,
    contents,
    observations,
    explicitAssociations,
    createdAt: input.createdAt,
    config: {}
  });
  validateSparseAssociationInput({
    schemaVersion: HYBRID_SCHEMA_VERSION,
    contractVersion: HYBRID_CONTRACT_VERSION,
    scope: input.plan.baseOrganization.envelope.scope,
    contents,
    observations,
    retrievalCandidates,
    explicitAssociations,
    decisionPolicy: {
      schemaVersion: HYBRID_SCHEMA_VERSION,
      contractVersion: HYBRID_CONTRACT_VERSION,
      policyVersion: 'classification-lab-stage-a-composition-validation.1',
      mode: 'shadow',
      decisionMode: 'evidence_rules',
      calibrated: false,
      maxCandidatesPerContent: 128,
      riskPolicyVersion: 'impact-risk.1',
      createdAt: input.createdAt
    },
    createdAt: input.createdAt
  });

  return {
    contents,
    observations,
    retrievalCandidates,
    explicitAssociations,
    batchBindings: input.plan.baseOrganization.batchBindings.map(binding => ({ ...binding, evidenceRefs: [...binding.evidenceRefs] })),
    reviewItems: uniqueSorted(stageReviewItems),
    unresolvedTemporalObservations: unresolvedTemporalObservations.sort((left, right) => left.observationId.localeCompare(right.observationId)),
    audit: {
      adapterVersion: STAGE_A_LAB_COMPOSITION_VERSION,
      inputDigest: input.plan.audit.inputDigest,
      stageAExecuted: hasStage,
      ...(input.stageResult ? { stageWorkflowStatus: input.stageResult.workflowStatus } : {}),
      externalCalls: 0,
      credentialsRead: false,
      costCny: 0,
      sourceStagePhotoIds
    }
  };
}
