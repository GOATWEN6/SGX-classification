import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ContentObservationSchema,
  SparseOrganizationResultSchema
} from './content-organization';
import {
  EvidenceBindingSchema,
  IngestionContentSchema,
  IngestionContextSchema,
  IngestionEnvelopeStructureSchema,
  IngestionScopeSchema,
  parseIngestionEnvelope,
  type IngestionEnvelope
} from './ingestion-contract';
import type { BuiltLabSubmission } from './lab-contract';
import { userExplicitAssociationForBinding } from './ingestion-organization-adapter';
import { CrossRoundAssociationCandidateSchema } from './cross-round-association';
import {
  CorrectionSchema,
  ReferenceSchema,
  digest,
  stable
} from './stage-a-contract';

export const LAB_JOB_VERSION_V2 = 'classification-lab-job.2' as const;
export const LAB_CONTENT_IDENTITY_VERSION = 'classification-lab-content-identity.1' as const;
export const LAB_RUN_IDENTITY_VERSION = 'classification-lab-run-identity.1' as const;
export const LAB_SEMANTIC_CONTEXT_VERSION = 'classification-lab-semantic-context.1' as const;
export const LAB_EXECUTION_RESULT_VERSION = 'classification-lab-execution-result.1' as const;
export const LAB_PRIVACY_EVENT_VERSION = 'classification-lab-privacy-event.1' as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const versionValue = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });
const imageMime = z.enum(['image/jpeg', 'image/png', 'image/webp']);
const assetMime = z.enum(['image/jpeg', 'image/png', 'image/webp', 'text/plain']);
const scope = z.object({ householdId: id, subjectId: id }).strict();
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;
const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort();
const utf8Hash = (value: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')}`;

function issue(ctx: z.RefinementCtx, message: string, path: Array<string | number> = []): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
}

function sameStable(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function requireCanonicalSet(values: string[], ctx: z.RefinementCtx, path: Array<string | number>, code: string): void {
  if(!sameStable(values, sortedUnique(values))) issue(ctx, code, path);
}

function validCalendarDate(value: string): boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}

export const LabPurposeSchema = z.enum([
  'classification',
  'album_organization',
  'search_candidate',
  'interview_candidate'
]);

export const LabExecutionProfileSchema = z.object({
  providerMode: z.enum(['deterministic', 'stage_a_mock', 'stage_a_real']),
  providerVersion: versionValue,
  modelVersion: versionValue,
  promptVersion: versionValue,
  guardVersion: versionValue,
  adapterVersion: versionValue,
  taxonomyVersion: versionValue,
  placeKindPolicyDigest: hash,
  scorerVersion: versionValue,
  configDigest: hash
}).strict();

export type LabExecutionProfile = z.infer<typeof LabExecutionProfileSchema>;

export const SemanticContextV1Schema = z.object({
  version: z.literal(LAB_SEMANTIC_CONTEXT_VERSION),
  referenceDate: z.string().refine(validCalendarDate, 'INVALID_REFERENCE_DATE'),
  timeZone: z.string().min(1).max(128).refine(validIanaTimeZone, 'INVALID_IANA_TIME_ZONE'),
  relativeTimePolicyVersion: versionValue
}).strict();

export type SemanticContextV1 = z.infer<typeof SemanticContextV1Schema>;

export const LabBudgetPolicySchema = z.object({
  maxRequests: z.number().int().min(0).max(1000),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxCostCny: z.number().nonnegative(),
  maxCandidatesPerContent: z.number().int().min(1).max(128),
  maxCallDurationMs: z.number().int().min(1).max(60_000)
}).strict();

export type LabBudgetPolicy = z.infer<typeof LabBudgetPolicySchema>;

const LabContentTargetSchema = z.union([
  z.literal('batch'),
  z.object({
    imageSlots: z.array(z.number().int().nonnegative()).max(5000)
      .refine(unique, 'DUPLICATE_IMAGE_SLOT')
  }).strict()
]);

const LabContentReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), slot: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('text'), modality: z.enum(['user_text', 'final_asr']) }).strict()
]);

const LabBindingIdentitySchema = z.object({
  sourceModality: z.enum(['user_text', 'final_asr']),
  target: z.union([
    z.literal('batch'),
    z.object({
      contents: z.array(LabContentReferenceSchema).min(1).max(5000)
    }).strict()
  ]),
  authority: z.enum(['user_explicit', 'ai_candidate']),
  state: z.enum(['active', 'withdrawn']),
  method: id,
  evidenceContents: z.array(LabContentReferenceSchema).min(1).max(64)
}).strict();

function bindingIdentityFingerprint(binding: z.infer<typeof LabBindingIdentitySchema>): string {
  return stable({
    sourceModality: binding.sourceModality,
    target: binding.target,
    authority: binding.authority
  });
}

export const ContentIdentityV1Schema = z.object({
  version: z.literal(LAB_CONTENT_IDENTITY_VERSION),
  scope,
  actorId: id,
  context: z.object({
    kind: z.enum(['album_upload', 'family_transfer']),
    senderId: id.optional(),
    recipientIds: z.array(id).max(100)
  }).strict(),
  images: z.array(z.object({
    slot: z.number().int().nonnegative(),
    sourceHash: hash,
    mimeType: imageMime,
    byteLength: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }).strict()).max(5000),
  texts: z.array(z.object({
    modality: z.enum(['user_text', 'final_asr']),
    normalizedText: z.string().min(1).max(65536),
    sourceHash: hash,
    target: LabContentTargetSchema
  }).strict()).max(2),
  bindings: z.array(LabBindingIdentitySchema).max(10000)
}).strict().superRefine((value, ctx) => {
  if(value.images.length + value.texts.length === 0) issue(ctx, 'EMPTY_CONTENT_IDENTITY');
  if(value.context.kind === 'album_upload' && (value.context.senderId || value.context.recipientIds.length)) {
    issue(ctx, 'ALBUM_UPLOAD_HAS_TRANSFER_PARTIES', ['context']);
  }
  if(value.context.kind === 'family_transfer' && (!value.context.senderId || value.context.recipientIds.length === 0)) {
    issue(ctx, 'FAMILY_TRANSFER_PARTIES_REQUIRED', ['context']);
  }
  requireCanonicalSet(value.context.recipientIds, ctx, ['context', 'recipientIds'], 'NON_CANONICAL_RECIPIENTS');
  const slots = value.images.map(image => image.slot);
  if(!unique(slots)) issue(ctx, 'DUPLICATE_IMAGE_SLOT', ['images']);
  if(slots.some((slot, index) => slot !== index)) issue(ctx, 'NON_CANONICAL_IMAGE_SLOTS', ['images']);
  const modalities = value.texts.map(text => text.modality);
  if(!unique(modalities)) issue(ctx, 'DUPLICATE_TEXT_MODALITY', ['texts']);
  for(const [index, text] of value.texts.entries()) {
    const normalized = text.normalizedText.normalize('NFKC').trim();
    if(normalized !== text.normalizedText) issue(ctx, 'NON_CANONICAL_TEXT', ['texts', index, 'normalizedText']);
    if(utf8Hash(normalized) !== text.sourceHash) issue(ctx, 'TEXT_SOURCE_HASH_MISMATCH', ['texts', index, 'sourceHash']);
    if(text.target !== 'batch') {
      const targets = text.target.imageSlots;
      if(!sameStable(targets, [...new Set(targets)].sort((left, right) => left - right))) {
        issue(ctx, 'NON_CANONICAL_IMAGE_TARGETS', ['texts', index, 'target', 'imageSlots']);
      }
      if(targets.some(slot => !slots.includes(slot))) {
        issue(ctx, 'TARGET_IMAGE_SLOT_NOT_FOUND', ['texts', index, 'target', 'imageSlots']);
      }
    }
  }
  const canonicalBindings = [...value.bindings].sort((left, right) => stable(left).localeCompare(stable(right)));
  if(!sameStable(value.bindings, canonicalBindings)) issue(ctx, 'NON_CANONICAL_BINDINGS', ['bindings']);
  const bindingFingerprints = new Set<string>();
  for(const [index, binding] of value.bindings.entries()) {
    const fingerprint = bindingIdentityFingerprint(binding);
    if(bindingFingerprints.has(fingerprint)) {
      issue(ctx, 'DUPLICATE_BINDING_SEMANTICS', ['bindings', index]);
    }
    bindingFingerprints.add(fingerprint);
    if(!modalities.includes(binding.sourceModality)) {
      issue(ctx, 'BINDING_SOURCE_MODALITY_NOT_FOUND', ['bindings', index, 'sourceModality']);
    }
    if(binding.target === 'batch') continue;
    const canonicalContents = [...binding.target.contents].sort((left, right) => stable(left).localeCompare(stable(right)));
    if(!sameStable(binding.target.contents, canonicalContents)) {
      issue(ctx, 'NON_CANONICAL_BINDING_TARGETS', ['bindings', index, 'target', 'contents']);
    }
    if(!unique(binding.target.contents.map(target => stable(target)))) {
      issue(ctx, 'DUPLICATE_BINDING_TARGET', ['bindings', index, 'target', 'contents']);
    }
    for(const [targetIndex, target] of binding.target.contents.entries()) {
      if(target.kind === 'image' && !slots.includes(target.slot)) {
        issue(ctx, 'BINDING_TARGET_IMAGE_NOT_FOUND', ['bindings', index, 'target', 'contents', targetIndex]);
      }
      if(target.kind === 'text' && !modalities.includes(target.modality)) {
        issue(ctx, 'BINDING_TARGET_TEXT_NOT_FOUND', ['bindings', index, 'target', 'contents', targetIndex]);
      }
      if(target.kind === 'text' && target.modality === binding.sourceModality) {
        issue(ctx, 'SELF_BINDING', ['bindings', index, 'target', 'contents', targetIndex]);
      }
    }
  }
  for(const [index, binding] of value.bindings.entries()) {
    const canonicalEvidence = [...binding.evidenceContents]
      .sort((left, right) => stable(left).localeCompare(stable(right)));
    if(!sameStable(binding.evidenceContents, canonicalEvidence)) {
      issue(ctx, 'NON_CANONICAL_BINDING_EVIDENCE', ['bindings', index, 'evidenceContents']);
    }
    if(!unique(binding.evidenceContents.map(reference => stable(reference)))) {
      issue(ctx, 'DUPLICATE_BINDING_EVIDENCE', ['bindings', index, 'evidenceContents']);
    }
    if(!binding.evidenceContents.some(reference => reference.kind === 'text'
      && reference.modality === binding.sourceModality)) {
      issue(ctx, 'BINDING_MISSING_SOURCE_EVIDENCE', ['bindings', index, 'evidenceContents']);
    }
    for(const [evidenceIndex, reference] of binding.evidenceContents.entries()) {
      if(reference.kind === 'image' && !slots.includes(reference.slot)) {
        issue(ctx, 'BINDING_EVIDENCE_IMAGE_NOT_FOUND', ['bindings', index, 'evidenceContents', evidenceIndex]);
      }
      if(reference.kind === 'text' && !modalities.includes(reference.modality)) {
        issue(ctx, 'BINDING_EVIDENCE_TEXT_NOT_FOUND', ['bindings', index, 'evidenceContents', evidenceIndex]);
      }
    }
  }
  for(const [index, text] of value.texts.entries()) {
    const authoritative = value.bindings.filter(binding => binding.sourceModality === text.modality
      && binding.authority === 'user_explicit'
      && binding.state === 'active');
    if(authoritative.length !== 1) issue(ctx, 'AUTHORITATIVE_BINDING_COUNT_INVALID', ['texts', index]);
    const binding = authoritative[0];
    if(!binding) continue;
    const target = binding.target === 'batch'
      ? 'batch' as const
      : binding.target.contents.every(item => item.kind === 'image')
        ? { imageSlots: binding.target.contents.map(item => item.kind === 'image' ? item.slot : -1) }
        : undefined;
    if(target === undefined || !sameStable(text.target, target)) {
      issue(ctx, 'TEXT_TARGET_BINDING_MISMATCH', ['texts', index, 'target']);
    }
  }
});

const LabContentIdentityBuildTextSchema = z.object({
  modality: z.enum(['user_text', 'final_asr']),
  normalizedText: z.string().max(65536),
  sourceHash: hash.optional(),
  target: LabContentTargetSchema
}).strict();

export const LabContentIdentityBuildInputSchema = z.object({
  scope,
  actorId: id,
  context: z.object({
    kind: z.enum(['album_upload', 'family_transfer']),
    senderId: id.optional(),
    recipientIds: z.array(id).max(100).default([])
  }).strict(),
  images: z.array(z.object({
    slot: z.number().int().nonnegative(),
    sourceHash: hash,
    mimeType: imageMime,
    byteLength: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }).strict()).max(5000),
  texts: z.array(LabContentIdentityBuildTextSchema).max(2),
  bindings: z.array(LabBindingIdentitySchema).max(10000)
}).strict();

export type ContentIdentityV1 = z.infer<typeof ContentIdentityV1Schema>;
export type LabContentIdentityBuildInput = z.input<typeof LabContentIdentityBuildInputSchema>;

type LabBindingIdentity = z.infer<typeof LabBindingIdentitySchema>;

function bindingIdentitiesFromEnvelope(
  envelope: IngestionEnvelope,
  imageSlotByContent: ReadonlyMap<string, number>
): LabBindingIdentity[] {
  const contentById = new Map(envelope.contents.map(value => [value.contentId, value]));
  const contentIdByEvidence = new Map(envelope.contents.map(value => [value.evidenceId, value.contentId]));
  const referenceFor = (contentId: string): z.infer<typeof LabContentReferenceSchema> => {
    const content = contentById.get(contentId);
    if(!content) throw new Error('LAB_BINDING_TARGET_NOT_FOUND');
    if(content.modality === 'image') {
      const slot = imageSlotByContent.get(contentId);
      if(slot === undefined) throw new Error('LAB_BINDING_TARGET_IMAGE_NOT_FOUND');
      return { kind: 'image', slot };
    }
    return { kind: 'text', modality: content.modality };
  };
  return envelope.bindings.map(binding => {
    const source = contentById.get(binding.sourceContentId);
    if(!source || source.modality === 'image') throw new Error('LAB_BINDING_SOURCE_INVALID');
    return {
      sourceModality: source.modality,
      target: binding.target.kind === 'batch'
        ? 'batch' as const
        : { contents: binding.target.contentIds.map(referenceFor) },
      authority: binding.authority,
      state: binding.state,
      method: binding.method,
      evidenceContents: binding.evidenceRefs.map(evidenceId => {
        const contentId = contentIdByEvidence.get(evidenceId);
        if(!contentId) throw new Error('LAB_BINDING_EVIDENCE_NOT_FOUND');
        return referenceFor(contentId);
      })
    };
  });
}

function authoritativeImageTarget(
  envelope: IngestionEnvelope,
  sourceContentId: string,
  imageSlotByContent: ReadonlyMap<string, number>
): z.infer<typeof LabContentTargetSchema> {
  const binding = envelope.bindings.find(value => value.sourceContentId === sourceContentId
    && value.authority === 'user_explicit'
    && value.state === 'active');
  if(!binding) throw new Error('MISSING_LAB_TEXT_BINDING');
  if(binding.target.kind === 'batch') return 'batch';
  return { imageSlots: binding.target.contentIds.map(contentId => {
    const slot = imageSlotByContent.get(contentId);
    if(slot === undefined) throw new Error('LAB_TEXT_TARGET_NOT_IMAGE');
    return slot;
  }) };
}

function contentIdentityInputFromSubmission(raw: BuiltLabSubmission): LabContentIdentityBuildInput {
  const envelope = parseIngestionEnvelope(raw.envelope);
  const evidenceById = new Map(envelope.evidence.map(value => [value.evidenceId, value]));
  const imageContents = envelope.contents.filter(value => value.modality === 'image');
  const imageSlotByContent = new Map(imageContents.map((value, index) => [value.contentId, index]));
  const assetByEvidence = new Map(raw.assets.map(value => [value.evidenceId, value]));
  const images = imageContents.map((content, slot) => {
    const evidence = evidenceById.get(content.evidenceId);
    const asset = assetByEvidence.get(content.evidenceId);
    if(!evidence || evidence.lifecycleState === 'deleted' || evidence.modality !== 'image' || !asset) {
      throw new Error('LAB_IMAGE_EVIDENCE_INVALID');
    }
    const sourceHash = `sha256:${createHash('sha256').update(asset.bytes).digest('hex')}` as `sha256:${string}`;
    if(sourceHash !== evidence.sourceHash || asset.mimeType !== evidence.mimeType || asset.bytes.length !== evidence.byteLength) {
      throw new Error('LAB_IMAGE_ASSET_MISMATCH');
    }
    return {
      slot,
      sourceHash,
      mimeType: evidence.mimeType,
      byteLength: evidence.byteLength,
      width: evidence.dimensions.width,
      height: evidence.dimensions.height
    };
  });
  const texts = envelope.contents.filter(value => value.modality !== 'image').map(content => {
    if(content.modality === 'image') throw new Error('LAB_TEXT_CONTENT_MODALITY_INVALID');
    const normalizedText = raw.payloads.textByEvidenceId[content.evidenceId];
    if(normalizedText === undefined) throw new Error('MISSING_LAB_TEXT_PAYLOAD');
    const target = authoritativeImageTarget(envelope, content.contentId, imageSlotByContent);
    return { modality: content.modality, normalizedText, target };
  });
  return {
    scope: envelope.scope,
    actorId: envelope.actorId,
    context: envelope.context.kind === 'album_upload'
      ? { kind: 'album_upload', recipientIds: [] }
      : {
          kind: 'family_transfer',
          senderId: envelope.context.senderId,
          recipientIds: envelope.context.recipientIds ?? []
    },
    images,
    texts,
    bindings: bindingIdentitiesFromEnvelope(envelope, imageSlotByContent)
  };
}

function isBuiltLabSubmission(raw: LabContentIdentityBuildInput | ContentIdentityV1 | BuiltLabSubmission): raw is BuiltLabSubmission {
  return 'envelope' in raw && 'payloads' in raw && 'assets' in raw;
}

export function buildLabContentIdentity(raw: LabContentIdentityBuildInput | ContentIdentityV1 | BuiltLabSubmission): ContentIdentityV1 {
  if(isBuiltLabSubmission(raw)) return buildLabContentIdentity(contentIdentityInputFromSubmission(raw));
  let value: z.infer<typeof LabContentIdentityBuildInputSchema>;
  if('version' in raw) {
    const parsed = ContentIdentityV1Schema.parse(raw);
    value = LabContentIdentityBuildInputSchema.parse({
      scope: parsed.scope,
      actorId: parsed.actorId,
      context: parsed.context,
      images: parsed.images,
      texts: parsed.texts,
      bindings: parsed.bindings
    });
  } else {
    value = LabContentIdentityBuildInputSchema.parse(raw);
  }
  const images = [...value.images].sort((left, right) => left.slot - right.slot)
    .map((image, slot) => ({ ...image, slot }));
  const texts = value.texts.map(text => {
    const normalizedText = text.normalizedText.normalize('NFKC').trim();
    if(!normalizedText) throw new Error('EMPTY_NORMALIZED_TEXT');
    const sourceHash = utf8Hash(normalizedText);
    if(text.sourceHash !== undefined && text.sourceHash !== sourceHash) throw new Error('TEXT_SOURCE_HASH_MISMATCH');
    const target = text.target === 'batch'
      ? 'batch' as const
      : { imageSlots: [...new Set(text.target.imageSlots)].sort((left, right) => left - right) };
    return { modality: text.modality, normalizedText, sourceHash, target };
  });
  const bindings = value.bindings.map(binding => ({
    ...binding,
    evidenceContents: [...binding.evidenceContents]
      .sort((left, right) => stable(left).localeCompare(stable(right))),
    target: binding.target === 'batch'
      ? 'batch' as const
      : {
          contents: [...binding.target.contents]
            .sort((left, right) => stable(left).localeCompare(stable(right)))
        }
  })).sort((left, right) => stable(left).localeCompare(stable(right)));
  return ContentIdentityV1Schema.parse({
    version: LAB_CONTENT_IDENTITY_VERSION,
    scope: value.scope,
    actorId: value.actorId,
    context: {
      kind: value.context.kind,
      ...(value.context.senderId ? { senderId: value.context.senderId } : {}),
      recipientIds: sortedUnique(value.context.recipientIds)
    },
    images,
    texts,
    bindings
  });
}

export function computeLabContentDigest(raw: LabContentIdentityBuildInput | ContentIdentityV1 | BuiltLabSubmission): `sha256:${string}` {
  return digest(buildLabContentIdentity(raw)) as `sha256:${string}`;
}

export function computeLabSemanticContextDigest(raw: SemanticContextV1): `sha256:${string}` {
  return digest(SemanticContextV1Schema.parse(raw)) as `sha256:${string}`;
}

export function computeLabBudgetPolicyDigest(raw: LabBudgetPolicy): `sha256:${string}` {
  return digest(LabBudgetPolicySchema.parse(raw)) as `sha256:${string}`;
}

export const LabRunIdentityV1Schema = z.object({
  version: z.literal(LAB_RUN_IDENTITY_VERSION),
  contentDigest: hash,
  attemptRevision: z.number().int().positive(),
  executionProfile: LabExecutionProfileSchema,
  authorizationGrantDigest: hash,
  authorizationRevision: id,
  contextRevision: id,
  semanticContextDigest: hash,
  budgetPolicyDigest: hash
}).strict();

export const LabRunIdentityBuildInputSchema = z.object({
  contentDigest: hash,
  attemptRevision: z.number().int().positive(),
  executionProfile: LabExecutionProfileSchema,
  authorizationGrantDigest: hash,
  authorizationRevision: id,
  contextRevision: id,
  semanticContext: SemanticContextV1Schema,
  budgetPolicy: LabBudgetPolicySchema
}).strict();

export type LabRunIdentityV1 = z.infer<typeof LabRunIdentityV1Schema>;
export type LabRunIdentityBuildInput = z.infer<typeof LabRunIdentityBuildInputSchema>;

export function buildLabRunIdentity(raw: LabRunIdentityBuildInput): LabRunIdentityV1 {
  const value = LabRunIdentityBuildInputSchema.parse(raw);
  return LabRunIdentityV1Schema.parse({
    version: LAB_RUN_IDENTITY_VERSION,
    contentDigest: value.contentDigest,
    attemptRevision: value.attemptRevision,
    executionProfile: value.executionProfile,
    authorizationGrantDigest: value.authorizationGrantDigest,
    authorizationRevision: value.authorizationRevision,
    contextRevision: value.contextRevision,
    semanticContextDigest: computeLabSemanticContextDigest(value.semanticContext),
    budgetPolicyDigest: computeLabBudgetPolicyDigest(value.budgetPolicy)
  });
}

export function computeLabRunIdentityDigest(raw: LabRunIdentityBuildInput | LabRunIdentityV1): `sha256:${string}` {
  const identity = 'version' in raw ? LabRunIdentityV1Schema.parse(raw) : buildLabRunIdentity(raw);
  return digest(identity) as `sha256:${string}`;
}

export interface LabRunIds {
  idempotencyKey: `sha256:${string}`;
  runId: string;
  jobId: string;
}

export function deriveLabRunIds(raw: `sha256:${string}` | LabRunIdentityBuildInput | LabRunIdentityV1): LabRunIds {
  const runIdentityDigest = typeof raw === 'string' ? hash.parse(raw) : computeLabRunIdentityDigest(raw);
  const idempotencyKey = digest(['classification-lab-run.2', runIdentityDigest]) as `sha256:${string}`;
  const runId = `lab_run_${idempotencyKey.slice(7, 31)}`;
  return { idempotencyKey, runId, jobId: runId };
}

export const TrustedLabGuardEvidenceSchema = z.object({
  evidenceId: id,
  revision: z.number().int().positive(),
  sourceHash: hash,
  consentRef: id,
  personConsentRef: id.optional(),
  lifecycleState: z.enum(['active', 'withdrawn', 'deleted'])
}).strict();

const TrustedLabGuardSnapshotInputStructureSchema = z.object({
  scope,
  actorId: id,
  authorityRef: id,
  purposes: z.array(LabPurposeSchema).min(1).max(4),
  authorizationRevision: id,
  contextRevision: id,
  active: z.boolean(),
  allowedConsentRefs: z.array(id).max(5000),
  allowedCorrectionIds: z.array(id).max(5000),
  allowPersonMatching: z.boolean(),
  personMatchingEvidenceIds: z.array(id).max(5000).optional(),
  personReferences: z.array(ReferenceSchema).max(100).optional(),
  personCorrections: z.array(CorrectionSchema).max(1000).optional(),
  evidence: z.array(TrustedLabGuardEvidenceSchema).min(1).max(5000)
}).strict();

function validateTrustedLabGuardPersonMatching(
  value: z.infer<typeof TrustedLabGuardSnapshotInputStructureSchema>,
  ctx: z.RefinementCtx
): void {
  const matchingEvidenceIds = value.personMatchingEvidenceIds ?? [];
  const references = value.personReferences ?? [];
  const personCorrections = (value.personCorrections ?? []).filter(correction => correction.kind === 'person');
  if(!unique(matchingEvidenceIds)) issue(ctx, 'DUPLICATE_PERSON_MATCHING_EVIDENCE', ['personMatchingEvidenceIds']);
  if(!value.allowPersonMatching && (matchingEvidenceIds.length || references.length || personCorrections.length)) {
    issue(ctx, 'PERSON_MATCHING_NOT_AUTHORIZED', ['allowPersonMatching']);
    return;
  }
  const evidenceById = new Map(value.evidence.map(evidence => [evidence.evidenceId, evidence]));
  for(const [index, evidenceId] of matchingEvidenceIds.entries()) {
    const evidence = evidenceById.get(evidenceId);
    if(!evidence || evidence.lifecycleState !== 'active' || !evidence.personConsentRef) {
      issue(ctx, 'PERSON_CONSENT_MISSING', ['personMatchingEvidenceIds', index]);
    }
  }
  const allowedMatchingEvidence = new Set(matchingEvidenceIds);
  for(const [index, reference] of references.entries()) {
    if(!allowedMatchingEvidence.has(reference.endpoint.photoId)) {
      issue(ctx, 'PERSON_CONSENT_MISSING', ['personReferences', index, 'endpoint', 'photoId']);
    }
  }
  for(const [index, correction] of (value.personCorrections ?? []).entries()) {
    if(!value.allowedCorrectionIds.includes(correction.correctionId)
      || correction.authorityRef !== value.authorityRef) {
      issue(ctx, 'PERSON_CORRECTION_NOT_AUTHORIZED', ['personCorrections', index]);
    }
    if(correction.kind === 'person'
      && (!allowedMatchingEvidence.has(correction.left.photoId)
        || !allowedMatchingEvidence.has(correction.right.photoId))) {
      issue(ctx, 'PERSON_CONSENT_MISSING', ['personCorrections', index]);
    }
  }
}

export const TrustedLabGuardSnapshotInputSchema = TrustedLabGuardSnapshotInputStructureSchema
  .superRefine(validateTrustedLabGuardPersonMatching);

export const TrustedLabGuardSnapshotSchema = TrustedLabGuardSnapshotInputStructureSchema
  .extend({ guardDigest: hash })
  .strict()
  .superRefine(validateTrustedLabGuardPersonMatching);

export type TrustedLabGuardSnapshotInput = z.infer<typeof TrustedLabGuardSnapshotInputSchema>;
export type TrustedLabGuardSnapshot = z.infer<typeof TrustedLabGuardSnapshotSchema>;

function guardInput(raw: TrustedLabGuardSnapshotInput | TrustedLabGuardSnapshot): TrustedLabGuardSnapshotInput {
  const source = 'guardDigest' in raw
    ? (({ guardDigest: _guardDigest, ...rest }) => rest)(TrustedLabGuardSnapshotSchema.parse(raw))
    : TrustedLabGuardSnapshotInputSchema.parse(raw);
  const evidence = [...source.evidence].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if(!unique(evidence.map(value => value.evidenceId))) throw new Error('DUPLICATE_GUARD_EVIDENCE');
  return TrustedLabGuardSnapshotInputSchema.parse({
    ...source,
    purposes: sortedUnique(source.purposes) as z.infer<typeof LabPurposeSchema>[],
    allowedConsentRefs: sortedUnique(source.allowedConsentRefs),
    allowedCorrectionIds: sortedUnique(source.allowedCorrectionIds),
    ...(source.personMatchingEvidenceIds ? { personMatchingEvidenceIds: sortedUnique(source.personMatchingEvidenceIds) } : {}),
    ...(source.personReferences ? { personReferences: [...source.personReferences].sort((left, right) => left.personId.localeCompare(right.personId)) } : {}),
    ...(source.personCorrections ? { personCorrections: [...source.personCorrections].sort((left, right) => left.correctionId.localeCompare(right.correctionId)) } : {}),
    evidence
  });
}

function grantProjection(raw: TrustedLabGuardSnapshotInput | TrustedLabGuardSnapshot): unknown {
  const value = guardInput(raw);
  return {
    scope: value.scope,
    actorId: value.actorId,
    authorityRef: value.authorityRef,
    purposes: value.purposes,
    authorizationRevision: value.authorizationRevision,
    contextRevision: value.contextRevision,
    allowedConsentRefs: value.allowedConsentRefs,
    allowedCorrectionIds: value.allowedCorrectionIds,
    allowPersonMatching: value.allowPersonMatching,
    ...(value.personMatchingEvidenceIds ? { personMatchingEvidenceIds: value.personMatchingEvidenceIds } : {}),
    ...(value.personReferences ? { personReferences: value.personReferences } : {}),
    ...(value.personCorrections ? { personCorrections: value.personCorrections } : {}),
    evidence: value.evidence.map(({ lifecycleState: _lifecycleState, ...evidence }) => evidence)
  };
}

function guardProjection(raw: TrustedLabGuardSnapshotInput | TrustedLabGuardSnapshot): unknown {
  const value = guardInput(raw);
  return {
    ...grantProjection(value) as object,
    active: value.active,
    evidence: value.evidence
  };
}

export function computeLabGrantDigest(raw: TrustedLabGuardSnapshotInput | TrustedLabGuardSnapshot): `sha256:${string}` {
  return digest(grantProjection(raw)) as `sha256:${string}`;
}

export function computeLabGuardDigest(raw: TrustedLabGuardSnapshotInput | TrustedLabGuardSnapshot): `sha256:${string}` {
  return digest(guardProjection(raw)) as `sha256:${string}`;
}

export const computeGrantDigest = computeLabGrantDigest;
export const computeGuardDigest = computeLabGuardDigest;

export function parseTrustedLabGuardSnapshot(raw: unknown): TrustedLabGuardSnapshot {
  const value = TrustedLabGuardSnapshotSchema.parse(raw);
  if(computeLabGuardDigest(value) !== value.guardDigest) throw new Error('LAB_GUARD_DIGEST_MISMATCH');
  return value;
}

export function buildTrustedLabGuardSnapshot(raw: TrustedLabGuardSnapshotInput): TrustedLabGuardSnapshot {
  const normalized = guardInput(raw);
  return TrustedLabGuardSnapshotSchema.parse({ ...normalized, guardDigest: computeLabGuardDigest(normalized) });
}

export const BatchEvidenceBindingSchema = z.object({
  bindingId: id,
  sourceContentId: id,
  authority: z.enum(['user_explicit', 'ai_candidate']),
  state: z.enum(['active', 'withdrawn']),
  evidenceRefs: z.array(id).min(1).max(64).refine(unique, 'DUPLICATE_EVIDENCE_REF')
}).strict();

export type BatchEvidenceBinding = z.infer<typeof BatchEvidenceBindingSchema>;

/**
 * High-impact facts are never silently promoted from Provider output. E3b
 * carries only AI candidates; user-confirmed identity/relationship facts stay
 * in the separate review/Memory authority path.
 */
export const LabHighImpactClaimSchema = z.object({
  claimId: id,
  claimKind: z.enum(['person_identity', 'relationship', 'sensitive_fact', 'long_term_memory_fact']),
  impactLevel: z.literal('high'),
  authority: z.literal('ai_candidate'),
  value: z.string().min(1).max(512),
  contentIds: z.array(id).min(1).max(5000).refine(unique, 'DUPLICATE_CLAIM_CONTENT'),
  evidenceRefs: z.array(id).min(1).max(64).refine(unique, 'DUPLICATE_CLAIM_EVIDENCE'),
  reviewRequired: z.literal(true)
}).strict();

export type LabHighImpactClaim = z.infer<typeof LabHighImpactClaimSchema>;

const CanonicalOrganizationOutputShape = {
  organization: SparseOrganizationResultSchema,
  observations: z.array(ContentObservationSchema).max(30_000),
  batchBindings: z.array(BatchEvidenceBindingSchema).max(10_000),
  highImpactClaims: z.array(LabHighImpactClaimSchema).max(10_000),
  // Defaults preserve read compatibility for frozen pre-cross-round artifacts.
  // New executors always write this field explicitly.
  crossRoundAssociations: z.array(CrossRoundAssociationCandidateSchema).max(30_000).default([]),
  retrieval: z.object({
    candidateCount: z.number().int().nonnegative().max(30_000),
    comparisonCount: z.number().int().nonnegative(),
    maxCandidatesPerContent: z.number().int().min(1).max(128),
    scoreMeaning: z.literal('retrieval_heuristic_not_probability')
  }).strict()
};

export const DeterministicLabProviderResultSchema = z.object({
  ...CanonicalOrganizationOutputShape,
  provider: z.object({
    mode: z.literal('deterministic'),
    providerVersion: versionValue,
    modelVersion: z.literal('none'),
    promptVersion: z.literal('none'),
    evidenceStatus: z.literal('integration_baseline_only'),
    accuracyClaim: z.literal('not_evaluated')
  }).strict()
}).strict();

export const StageAMockLabProviderResultSchema = z.object({
  ...CanonicalOrganizationOutputShape,
  provider: z.object({
    mode: z.literal('stage_a_mock'),
    providerVersion: versionValue,
    modelVersion: versionValue,
    promptVersion: versionValue,
    evidenceStatus: z.literal('mock_transport'),
    accuracyClaim: z.literal('not_evaluated')
  }).strict()
}).strict();

export const StageARealLabProviderResultSchema = z.object({
  ...CanonicalOrganizationOutputShape,
  provider: z.object({
    mode: z.literal('stage_a_real'),
    providerVersion: versionValue,
    modelVersion: versionValue,
    promptVersion: versionValue,
    evidenceStatus: z.literal('real_api'),
    accuracyClaim: z.literal('not_evaluated')
  }).strict()
}).strict();

export const CanonicalLabProviderResultSchema = z.union([
  DeterministicLabProviderResultSchema,
  StageAMockLabProviderResultSchema,
  StageARealLabProviderResultSchema
]);

export type CanonicalLabProviderResult = z.infer<typeof CanonicalLabProviderResultSchema>;

const DeterministicExecutionResultSchema = z.object({
  version: z.literal(LAB_EXECUTION_RESULT_VERSION),
  workflowStatus: z.enum(['succeeded', 'needs_review']),
  profile: LabExecutionProfileSchema.extend({ providerMode: z.literal('deterministic') }).strict(),
  output: DeterministicLabProviderResultSchema
}).strict();

const StageAMockExecutionResultSchema = z.object({
  version: z.literal(LAB_EXECUTION_RESULT_VERSION),
  workflowStatus: z.enum(['succeeded', 'needs_review']),
  profile: LabExecutionProfileSchema.extend({ providerMode: z.literal('stage_a_mock') }).strict(),
  output: StageAMockLabProviderResultSchema
}).strict();

const StageARealExecutionResultSchema = z.object({
  version: z.literal(LAB_EXECUTION_RESULT_VERSION),
  workflowStatus: z.enum(['succeeded', 'needs_review']),
  profile: LabExecutionProfileSchema.extend({ providerMode: z.literal('stage_a_real') }).strict(),
  output: StageARealLabProviderResultSchema
}).strict();

export const LabExecutionResultSchema = z.union([
  DeterministicExecutionResultSchema,
  StageAMockExecutionResultSchema,
  StageARealExecutionResultSchema
]).superRefine((value, ctx) => {
  const provider = value.output.provider;
  if(provider.providerVersion !== value.profile.providerVersion) issue(ctx, 'PROVIDER_VERSION_MISMATCH', ['output', 'provider']);
  if(provider.modelVersion !== value.profile.modelVersion) issue(ctx, 'MODEL_VERSION_MISMATCH', ['output', 'provider']);
  if(provider.promptVersion !== value.profile.promptVersion) issue(ctx, 'PROMPT_VERSION_MISMATCH', ['output', 'provider']);
});

export const LabExecutionMetricsSchema = z.object({
  latencyMs: z.number().int().nonnegative(),
  modelRequests: z.number().int().nonnegative(),
  imageRequests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costCny: z.number().nonnegative()
}).strict();

export const LabExecutionOutcomeSchema = z.object({
  result: LabExecutionResultSchema,
  metrics: LabExecutionMetricsSchema
}).strict();

export type LabExecutionResult = z.infer<typeof LabExecutionResultSchema>;
export type LabExecutionMetrics = z.infer<typeof LabExecutionMetricsSchema>;
export type LabExecutionOutcome = z.infer<typeof LabExecutionOutcomeSchema>;

export function parseLabExecutionResult(raw: unknown, expectedProfile?: LabExecutionProfile): LabExecutionResult {
  const result = LabExecutionResultSchema.parse(raw);
  if(expectedProfile) {
    const profile = LabExecutionProfileSchema.parse(expectedProfile);
    if(!sameStable(result.profile, profile)) throw new Error('LAB_RUN_IDENTITY_MISMATCH');
  }
  return result;
}

export function parseLabExecutionOutcome(raw: unknown, expectedProfile?: LabExecutionProfile): LabExecutionOutcome {
  const outcome = LabExecutionOutcomeSchema.parse(raw);
  return { ...outcome, result: parseLabExecutionResult(outcome.result, expectedProfile) };
}

export const validateLabExecutionResult = parseLabExecutionResult;
export const validateLabExecutionOutcome = parseLabExecutionOutcome;

export function computeLabResultDigest(raw: LabExecutionResult): `sha256:${string}` {
  return digest(parseLabExecutionResult(raw)) as `sha256:${string}`;
}

export const LabJobStatusV2Schema = z.enum([
  'pending',
  'processing',
  'succeeded',
  'needs_review',
  'failed_retryable',
  'failed_terminal',
  'cancelled'
]);

export type LabJobStatusV2 = z.infer<typeof LabJobStatusV2Schema>;

export const LabTransitionReasonSchema = z.enum([
  'created',
  'claimed',
  'completed',
  'needs_review',
  'user',
  'authorization_revoked',
  'evidence_changed',
  'timeout',
  'interrupted',
  'provider_unavailable',
  'guard_unavailable',
  'invalid_output',
  'identity_mismatch',
  'LAB_JOB_CREATED',
  'LAB_JOB_CLAIMED',
  'LAB_RUN_SUCCEEDED',
  'LAB_RUN_NEEDS_REVIEW',
  'CANCELLED',
  'AUTHORIZATION_REVOKED',
  'AUTHORIZATION_CHANGED',
  'INACTIVE_EVIDENCE',
  'EVIDENCE_CHANGED',
  'INVALID_OUTPUT',
  'LAB_RUN_IDENTITY_MISMATCH',
  'LAB_RUN_TIMEOUT',
  'LAB_RUN_INTERRUPTED',
  'LAB_PROVIDER_UNAVAILABLE',
  'LAB_GUARD_UNAVAILABLE',
  'LAB_STORE_CORRUPT'
]);

export type LabTransitionReason = z.infer<typeof LabTransitionReasonSchema>;

export const LabTransitionV2Schema = z.object({
  from: z.union([z.literal('none'), LabJobStatusV2Schema]),
  to: LabJobStatusV2Schema,
  reason: LabTransitionReasonSchema,
  at: dateTime,
  revision: z.number().int().nonnegative(),
  runnerGeneration: id.optional()
}).strict();

export type LabTransitionV2 = z.infer<typeof LabTransitionV2Schema>;

export const LabActionKindV2Schema = z.enum([
  'accept_story',
  'reject_association',
  'remove_content',
  'split_content',
  'merge_stories',
  'delete_evidence',
  'revoke_authorization'
]);

export const LabActionV2Schema = z.object({
  actionId: id,
  kind: LabActionKindV2Schema,
  targetIds: z.array(id).min(1).max(100).refine(unique, 'DUPLICATE_ACTION_TARGET'),
  actorId: id,
  createdAt: dateTime
}).strict();

export const LabActionRequestV2Schema = z.object({
  actionId: id,
  kind: LabActionKindV2Schema,
  targetIds: z.array(id).min(1).max(100).refine(unique, 'DUPLICATE_ACTION_TARGET'),
  actorId: id,
  expectedRevision: z.number().int().nonnegative()
}).strict();

export type LabActionV2 = z.infer<typeof LabActionV2Schema>;
export type LabActionRequestV2 = z.infer<typeof LabActionRequestV2Schema>;

const PrivacyEventBaseShape = {
  version: z.literal(LAB_PRIVACY_EVENT_VERSION),
  eventId: id,
  authorityRef: id,
  scope,
  authorizationRevision: id,
  guardDigest: hash,
  occurredAt: dateTime
};

export const TrustedPrivacyControlEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...PrivacyEventBaseShape, kind: z.literal('authorization_revoked') }).strict(),
  z.object({
    ...PrivacyEventBaseShape,
    kind: z.literal('evidence_deleted'),
    evidenceIds: z.array(id).min(1).max(5000).refine(unique, 'DUPLICATE_EVIDENCE_ID')
  }).strict()
]);

export type TrustedPrivacyControlEvent = z.infer<typeof TrustedPrivacyControlEventSchema>;

export const LabAssetRefV2Schema = z.object({
  evidenceId: id,
  filename: z.string().min(1).max(160).refine(value => !/[\u0000-\u001f/\\]/.test(value), 'UNSAFE_ASSET_FILENAME'),
  mimeType: assetMime,
  byteLength: z.number().int().positive(),
  sourceHash: hash
}).strict();

export type LabAssetRefV2 = z.infer<typeof LabAssetRefV2Schema>;

export const LabJobAuthorizationV2Schema = z.object({
  actorId: id,
  authorityRef: id,
  authorizationRevision: id,
  contextRevision: id,
  grantDigest: hash,
  initialGuardDigest: hash,
  state: z.enum(['active', 'revoked']),
  revokedAt: dateTime.optional()
}).strict().superRefine((value, ctx) => {
  if(value.state === 'active' && value.revokedAt) issue(ctx, 'ACTIVE_AUTHORIZATION_HAS_REVOKED_AT', ['revokedAt']);
  if(value.state === 'revoked' && !value.revokedAt) issue(ctx, 'REVOKED_AUTHORIZATION_REQUIRES_REVOKED_AT', ['revokedAt']);
});

export const LabTerminationV2Schema = z.object({
  requestedAt: dateTime,
  reason: z.enum(['user', 'authorization_revoked', 'evidence_changed', 'timeout'])
}).strict();

export const LabJobErrorV2Schema = z.object({
  code: id,
  retryable: z.boolean()
}).strict();

const LabJobRecordV2StructureSchema = z.object({
  version: z.literal(LAB_JOB_VERSION_V2),
  revision: z.number().int().nonnegative(),
  jobId: id,
  runId: id,
  idempotencyKey: hash,
  contentDigest: hash,
  runIdentityDigest: hash,
  attemptRevision: z.number().int().positive(),
  status: LabJobStatusV2Schema,
  executionProfile: LabExecutionProfileSchema,
  semanticContext: SemanticContextV1Schema,
  budgetPolicy: LabBudgetPolicySchema,
  authorization: LabJobAuthorizationV2Schema,
  createdAt: dateTime,
  updatedAt: dateTime,
  startedAt: dateTime.optional(),
  finishedAt: dateTime.optional(),
  deadlineAt: dateTime,
  processingOwner: z.object({ runnerGeneration: id, claimedAt: dateTime }).strict().optional(),
  termination: LabTerminationV2Schema.optional(),
  envelope: z.unknown(),
  originalTextByEvidenceId: z.record(id, z.string().max(65536)),
  assetRefs: z.array(LabAssetRefV2Schema).max(5000),
  result: LabExecutionResultSchema.optional(),
  resultDigest: hash.optional(),
  metrics: LabExecutionMetricsSchema.optional(),
  error: LabJobErrorV2Schema.optional(),
  actions: z.array(LabActionV2Schema).max(10_000),
  privacyEvents: z.array(TrustedPrivacyControlEventSchema).max(10_000),
  transitions: z.array(LabTransitionV2Schema).min(1).max(10_000)
}).strict();

export interface LabJobRecordV2 extends Omit<z.infer<typeof LabJobRecordV2StructureSchema>, 'envelope'> {
  envelope: IngestionEnvelope;
}

const terminalStatuses = new Set<LabJobStatusV2>([
  'succeeded', 'needs_review', 'failed_retryable', 'failed_terminal', 'cancelled'
]);

const transitionTargets: Record<LabJobStatusV2 | 'none', ReadonlySet<LabJobStatusV2>> = {
  none: new Set(['pending']),
  pending: new Set(['processing', 'cancelled', 'failed_retryable', 'failed_terminal']),
  processing: new Set(['succeeded', 'needs_review', 'cancelled', 'failed_retryable', 'failed_terminal']),
  succeeded: new Set(),
  needs_review: new Set(),
  failed_retryable: new Set(),
  failed_terminal: new Set(),
  cancelled: new Set()
};

function epoch(value: string): number { return Date.parse(value); }

function assertUniqueIds(values: Array<{ [key: string]: unknown }>, key: string, code: string): void {
  const keys = values.map(value => value[key]);
  if(new Set(keys).size !== keys.length) throw new Error(code);
}

function validateJobTimes(job: z.infer<typeof LabJobRecordV2StructureSchema>): void {
  const created = epoch(job.createdAt);
  const updated = epoch(job.updatedAt);
  if(updated < created) throw new Error('LAB_JOB_TIME_INVARIANT');
  const started = job.startedAt ? epoch(job.startedAt) : undefined;
  const finished = job.finishedAt ? epoch(job.finishedAt) : undefined;
  if(job.status === 'pending') {
    if(job.startedAt || job.finishedAt || job.processingOwner || job.termination) throw new Error('LAB_PENDING_TIME_INVARIANT');
    return;
  }
  if(job.status === 'processing') {
    if(started === undefined || !job.processingOwner || job.finishedAt || job.termination) throw new Error('LAB_PROCESSING_TIME_INVARIANT');
    if(created > started || started > updated || epoch(job.processingOwner.claimedAt) !== started) throw new Error('LAB_PROCESSING_TIME_INVARIANT');
    return;
  }
  if(finished === undefined) throw new Error('LAB_TERMINAL_FINISHED_AT_REQUIRED');
  if(updated < finished) throw new Error('LAB_TERMINAL_TIME_INVARIANT');
  if(started === undefined) {
    if(job.processingOwner || created > finished || updated !== finished) throw new Error('LAB_DIRECT_TERMINAL_TIME_INVARIANT');
  } else {
    if(!job.processingOwner || created > started || started > finished) throw new Error('LAB_PROCESSING_TERMINAL_TIME_INVARIANT');
  }
}

function validateTransitions(job: z.infer<typeof LabJobRecordV2StructureSchema>): void {
  let previousStatus: LabJobStatusV2 | 'none' = 'none';
  let previousRevision = -1;
  let previousAt = Number.NEGATIVE_INFINITY;
  for(const [index, transition] of job.transitions.entries()) {
    if(transition.from !== previousStatus) throw new Error('LAB_TRANSITION_CHAIN_INVALID');
    if(!transitionTargets[transition.from].has(transition.to)) throw new Error('LAB_TRANSITION_NOT_ALLOWED');
    if(index === 0 && transition.revision !== 0) throw new Error('LAB_CREATE_TRANSITION_REVISION_INVALID');
    if(index > 0 && transition.revision <= previousRevision) throw new Error('LAB_TRANSITION_REVISION_INVALID');
    if(transition.revision > job.revision) throw new Error('LAB_TRANSITION_REVISION_AHEAD');
    if(epoch(transition.at) < previousAt) throw new Error('LAB_TRANSITION_TIME_INVALID');
    if(transition.to === 'processing' && !transition.runnerGeneration) throw new Error('LAB_CLAIM_TRANSITION_RUNNER_REQUIRED');
    previousStatus = transition.to;
    previousRevision = transition.revision;
    previousAt = epoch(transition.at);
  }
  if(previousStatus !== job.status) throw new Error('LAB_TRANSITION_STATUS_MISMATCH');
}

function contentIdentityFromJob(
  job: z.infer<typeof LabJobRecordV2StructureSchema>,
  envelope: IngestionEnvelope
): ContentIdentityV1 {
  const evidenceById = new Map(envelope.evidence.map(value => [value.evidenceId, value]));
  const imageContents = envelope.contents.filter(value => value.modality === 'image');
  const imageSlotByContent = new Map(imageContents.map((value, index) => [value.contentId, index]));
  const images = imageContents.map((content, slot) => {
    const evidence = evidenceById.get(content.evidenceId);
    if(!evidence || evidence.lifecycleState === 'deleted' || evidence.modality !== 'image') throw new Error('LAB_IMAGE_EVIDENCE_INVALID');
    return {
      slot,
      sourceHash: evidence.sourceHash,
      mimeType: evidence.mimeType,
      byteLength: evidence.byteLength,
      width: evidence.dimensions.width,
      height: evidence.dimensions.height
    };
  });
  const texts = envelope.contents.filter(value => value.modality !== 'image').map(content => {
    if(content.modality === 'image') throw new Error('LAB_TEXT_CONTENT_MODALITY_INVALID');
    const normalizedText = job.originalTextByEvidenceId[content.evidenceId];
    if(normalizedText === undefined) throw new Error('MISSING_LAB_TEXT_PAYLOAD');
    const target = authoritativeImageTarget(envelope, content.contentId, imageSlotByContent);
    return {
      modality: content.modality,
      normalizedText,
      sourceHash: utf8Hash(normalizedText.normalize('NFKC').trim()),
      target
    };
  });
  return buildLabContentIdentity({
    scope: envelope.scope,
    actorId: envelope.actorId,
    context: envelope.context.kind === 'album_upload'
      ? { kind: 'album_upload', recipientIds: [] }
      : {
          kind: 'family_transfer',
          senderId: envelope.context.senderId,
          recipientIds: envelope.context.recipientIds ?? []
    },
    images,
    texts,
    bindings: bindingIdentitiesFromEnvelope(envelope, imageSlotByContent)
  });
}

function validateJobPayloads(job: z.infer<typeof LabJobRecordV2StructureSchema>, envelope: IngestionEnvelope): void {
  const evidenceById = new Map(envelope.evidence.map(value => [value.evidenceId, value]));
  assertUniqueIds(job.assetRefs, 'evidenceId', 'DUPLICATE_LAB_ASSET_REF');
  for(const ref of job.assetRefs) {
    const evidence = evidenceById.get(ref.evidenceId);
    if(!evidence || evidence.lifecycleState === 'deleted') throw new Error('FOREIGN_LAB_ASSET_REF');
    if(ref.sourceHash !== evidence.sourceHash || ref.byteLength !== evidence.byteLength || ref.mimeType !== evidence.mimeType) {
      throw new Error('LAB_ASSET_REF_MISMATCH');
    }
  }
  for(const [evidenceId, text] of Object.entries(job.originalTextByEvidenceId)) {
    const evidence = evidenceById.get(evidenceId);
    if(!evidence || evidence.lifecycleState === 'deleted' || evidence.modality === 'image') throw new Error('FOREIGN_LAB_TEXT_PAYLOAD');
    const normalized = text.normalize('NFKC').trim();
    if(normalized !== text || Buffer.byteLength(text, 'utf8') !== evidence.byteLength || utf8Hash(text) !== evidence.sourceHash) {
      throw new Error('LAB_TEXT_PAYLOAD_MISMATCH');
    }
  }
  const expectedContentDigest = computeLabContentDigest(contentIdentityFromJob(job, envelope));
  if(job.contentDigest !== expectedContentDigest) throw new Error('LAB_CONTENT_DIGEST_MISMATCH');
}

function requireUniqueStrings(values: string[], code: string): void {
  if(new Set(values).size !== values.length) throw new Error(code);
}

/**
 * Structural parsing is not enough for model/provider output. This gate binds
 * every returned reference to the immutable ingestion envelope so a provider
 * cannot manufacture foreign contents, Evidence, stories, or user-confirmed
 * facts while still satisfying the JSON shape.
 */
export function validateLabExecutionResultAgainstEnvelope(
  raw: unknown,
  envelopeInput: IngestionEnvelope,
  expectedProfile?: LabExecutionProfile
): LabExecutionResult {
  const envelope = parseIngestionEnvelope(envelopeInput);
  const result = parseLabExecutionResult(raw, expectedProfile);
  if(!sameStable(result.output.organization.scope, envelope.scope)) throw new Error('LAB_RESULT_SCOPE_MISMATCH');

  const contentById = new Map(envelope.contents
    .filter(content => content.lifecycleState === 'active')
    .map(content => [content.contentId, content]));
  const evidenceIds = new Set(envelope.evidence
    .filter(evidence => evidence.lifecycleState !== 'deleted')
    .map(evidence => evidence.evidenceId));
  const evidenceForContents = (contentIds: string[]): Set<string> => {
    const values = new Set<string>();
    for(const contentId of contentIds) {
      const content = contentById.get(contentId);
      if(!content) throw new Error('FOREIGN_RESULT_CONTENT');
      values.add(content.evidenceId);
    }
    return values;
  };

  for(const observation of result.output.observations) {
    const content = contentById.get(observation.contentId);
    if(!content || observation.evidenceId !== content.evidenceId) throw new Error('FOREIGN_RESULT_OBSERVATION');
    if(!observation.supports.some(support => support.evidenceId === observation.evidenceId)) {
      throw new Error('RESULT_PRIMARY_SUPPORT_MISSING');
    }
    if(observation.supports.some(support => support.evidenceId !== content.evidenceId)) {
      throw new Error('FOREIGN_RESULT_SUPPORT');
    }
  }

  const storyIds = new Set<string>();
  const storyEvidence = new Map<string, Set<string>>();
  const storyMembership = new Set<string>();
  const facetObservationNames = {
    people: 'person',
    times: 'time',
    places: 'place',
    themes: 'theme'
  } as const;
  const normalizeFacetValue = (value: string): string => value.normalize('NFKC').trim();
  for(const story of result.output.organization.stories) {
    if(storyIds.has(story.storyId)) throw new Error('DUPLICATE_RESULT_STORY');
    storyIds.add(story.storyId);
    if(!sameStable(story.scope, envelope.scope)) throw new Error('CROSS_SCOPE_RESULT_STORY');
    requireUniqueStrings(story.memberContentIds, 'DUPLICATE_RESULT_STORY_MEMBER');
    if(story.state === 'user_confirmed' || story.state === 'withdrawn') {
      throw new Error('PROVIDER_CANNOT_CONFIRM_STORY');
    }
    const allowed = evidenceForContents(story.memberContentIds);
    for(const contentId of story.memberContentIds) {
      if(storyMembership.has(contentId)) throw new Error('CONTENT_IN_MULTIPLE_RESULT_STORIES');
      storyMembership.add(contentId);
    }
    if([...story.titleSupports, ...story.summarySupports].some(ref => !allowed.has(ref))) {
      throw new Error('FOREIGN_RESULT_STORY_SUPPORT');
    }
    for(const [storyFacet, observationFacet] of Object.entries(facetObservationNames) as Array<
      [keyof typeof facetObservationNames, typeof facetObservationNames[keyof typeof facetObservationNames]]
    >) {
      const supported = new Set(result.output.observations
        .filter(observation => story.memberContentIds.includes(observation.contentId)
          && observation.facet === observationFacet
          && observation.state === 'candidate')
        .flatMap(observation => [observation.rawValue, observation.normalizedValue]
          .filter((value): value is string => value !== undefined)
          .map(normalizeFacetValue)));
      if(story.facets[storyFacet].some(value => !supported.has(normalizeFacetValue(value)))) {
        throw new Error('RESULT_STORY_FACET_WITHOUT_OBSERVATION');
      }
    }
    storyEvidence.set(story.storyId, allowed);
  }
  if(storyMembership.size !== contentById.size
    || [...contentById.keys()].some(contentId => !storyMembership.has(contentId))) {
    throw new Error('RESULT_STORY_COVERAGE_INCOMPLETE');
  }

  const expectedUserAssociations = envelope.bindings
    .filter(binding => binding.authority === 'user_explicit' && binding.target.kind === 'contents')
    .flatMap(binding => binding.target.kind === 'contents'
      ? binding.target.contentIds.map(targetContentId =>
          userExplicitAssociationForBinding(binding, targetContentId, envelope))
      : []);
  const expectedUserAssociationById = new Map(expectedUserAssociations
    .map(association => [association.associationId, association]));
  const returnedUserAssociationIds = new Set<string>();
  const associationIds = new Set<string>();
  for(const association of result.output.organization.associations) {
    if(associationIds.has(association.associationId)) throw new Error('DUPLICATE_RESULT_ASSOCIATION');
    associationIds.add(association.associationId);
    const allowed = evidenceForContents([association.fromContentId]);
    if(association.toContentId) {
      for(const ref of evidenceForContents([association.toContentId])) allowed.add(ref);
    } else if(association.toStoryId) {
      const target = storyEvidence.get(association.toStoryId);
      if(!target) throw new Error('FOREIGN_RESULT_ASSOCIATION_STORY');
      for(const ref of target) allowed.add(ref);
    }
    if(association.evidenceRefs.some(ref => !allowed.has(ref) || !evidenceIds.has(ref))) {
      throw new Error('FOREIGN_RESULT_ASSOCIATION_EVIDENCE');
    }
    if(association.source === 'user_explicit') {
      const expected = expectedUserAssociationById.get(association.associationId);
      if(!expected || !sameStable(expected, association)) {
        throw new Error('UNTRUSTED_USER_CONFIRMED_ASSOCIATION');
      }
      returnedUserAssociationIds.add(association.associationId);
    } else if(association.status === 'rejected') {
      throw new Error('PROVIDER_CANNOT_REJECT_ASSOCIATION');
    }
  }
  if(returnedUserAssociationIds.size !== expectedUserAssociations.length
    || expectedUserAssociations.some(association => !returnedUserAssociationIds.has(association.associationId))) {
    throw new Error('RESULT_USER_ASSOCIATION_COVERAGE_INCOMPLETE');
  }

  const crossRoundAssociationIds = new Set<string>();
  for(const association of result.output.crossRoundAssociations) {
    if(crossRoundAssociationIds.has(association.associationId)) {
      throw new Error('DUPLICATE_CROSS_ROUND_ASSOCIATION');
    }
    crossRoundAssociationIds.add(association.associationId);
    if(!sameStable(association.scope, envelope.scope)) throw new Error('CROSS_SCOPE_CROSS_ROUND_ASSOCIATION');
    if(association.authorizationRevision !== envelope.authorizationRevision) {
      throw new Error('STALE_CROSS_ROUND_ASSOCIATION');
    }
    const source = contentById.get(association.sourceContentId);
    if(!source || source.evidenceId !== association.sourceEvidenceId) {
      throw new Error('FOREIGN_CROSS_ROUND_SOURCE');
    }
    const allowed = evidenceForContents([association.sourceContentId]);
    if(association.currentEvidenceRefs.some(ref => !allowed.has(ref) || !evidenceIds.has(ref))) {
      throw new Error('FOREIGN_CROSS_ROUND_CURRENT_EVIDENCE');
    }
    if(association.historicalEvidenceRefs.some(ref => evidenceIds.has(ref))) {
      throw new Error('CROSS_ROUND_HISTORY_REFERENCES_CURRENT_EVIDENCE');
    }
  }

  const bindingIds = new Set<string>();
  for(const binding of result.output.batchBindings) {
    if(bindingIds.has(binding.bindingId)) throw new Error('DUPLICATE_RESULT_BATCH_BINDING');
    bindingIds.add(binding.bindingId);
    const source = contentById.get(binding.sourceContentId);
    const original = envelope.bindings.find(value => value.bindingId === binding.bindingId
      && value.target.kind === 'batch');
    if(!source || source.modality === 'image' || !original
      || original.sourceContentId !== binding.sourceContentId
      || original.authority !== binding.authority
      || original.state !== binding.state
      || !sameStable(original.evidenceRefs, binding.evidenceRefs)
      || binding.evidenceRefs.some(ref => !evidenceIds.has(ref))) {
      throw new Error('FOREIGN_RESULT_BATCH_BINDING');
    }
  }
  const expectedBatchBindingIds = envelope.bindings
    .filter(binding => binding.target.kind === 'batch')
    .map(binding => binding.bindingId);
  if(bindingIds.size !== expectedBatchBindingIds.length
    || expectedBatchBindingIds.some(bindingId => !bindingIds.has(bindingId))) {
    throw new Error('RESULT_BATCH_BINDING_COVERAGE_INCOMPLETE');
  }

  const claimIds = new Set<string>();
  for(const claim of result.output.highImpactClaims) {
    if(claimIds.has(claim.claimId)) throw new Error('DUPLICATE_RESULT_HIGH_IMPACT_CLAIM');
    claimIds.add(claim.claimId);
    const allowed = evidenceForContents(claim.contentIds);
    if(claim.evidenceRefs.some(ref => !allowed.has(ref) || !evidenceIds.has(ref))) {
      throw new Error('FOREIGN_RESULT_HIGH_IMPACT_CLAIM_EVIDENCE');
    }
  }

  const decisions = result.output.organization.decisionResults;
  requireUniqueStrings(decisions.map(value => value.resultId), 'DUPLICATE_RESULT_DECISION');
  requireUniqueStrings(decisions.map(value => value.candidateId), 'DUPLICATE_RESULT_CANDIDATE_DECISION');
  const retrieval = result.output.retrieval;
  const audit = result.output.organization.retrievalAudit;
  if(retrieval.candidateCount !== audit.candidateCount
    || retrieval.maxCandidatesPerContent !== audit.maxCandidatesPerContent
    || audit.evaluatedCount + audit.skippedPersonOnlyCount > audit.candidateCount
    || decisions.length > audit.candidateCount) throw new Error('RESULT_RETRIEVAL_AUDIT_MISMATCH');
  for(const item of result.output.organization.reviewItems) {
    const match = /^(?:NEEDS_REVIEW|CONFLICT):(.+)$/.exec(item);
    if(match && !associationIds.has(match[1])) throw new Error('FOREIGN_RESULT_REVIEW_ITEM');
  }
  return result;
}

function validateJobOutcome(job: z.infer<typeof LabJobRecordV2StructureSchema>, envelope: IngestionEnvelope): void {
  const success = job.status === 'succeeded' || job.status === 'needs_review';
  if(success) {
    if(!job.result || !job.resultDigest || !job.metrics || job.error || job.termination) throw new Error('LAB_SUCCESS_OUTCOME_INCOMPLETE');
    const result = validateLabExecutionResultAgainstEnvelope(job.result, envelope, job.executionProfile);
    if(result.workflowStatus !== job.status) throw new Error('LAB_WORKFLOW_STATUS_MISMATCH');
    if(computeLabResultDigest(result) !== job.resultDigest) throw new Error('LAB_RESULT_DIGEST_MISMATCH');
    if(!sameStable(result.output.organization.scope, envelope.scope)) throw new Error('LAB_RESULT_SCOPE_MISMATCH');
    return;
  }
  if(job.result || job.resultDigest || job.metrics) throw new Error('LAB_FAILURE_HAS_SUCCESS_RESULT');
  if(job.status === 'pending' || job.status === 'processing') {
    if(job.error || job.metrics) throw new Error('LAB_ACTIVE_JOB_HAS_OUTCOME');
    return;
  }
  if(!job.error) throw new Error('LAB_TERMINAL_ERROR_REQUIRED');
  const disposition = mapLabExecutionError(job.error.code);
  if(disposition.kind !== 'persist'
    || disposition.status !== job.status
    || disposition.retryable !== job.error.retryable) throw new Error('LAB_FAILURE_DISPOSITION_MISMATCH');
  const expectedTermination = job.error.code === 'LAB_RUN_TIMEOUT' ? 'timeout'
    : job.error.code === 'CANCELLED' ? 'user'
      : ['AUTHORIZATION_REVOKED', 'AUTHORIZATION_CHANGED'].includes(job.error.code) ? 'authorization_revoked'
        : ['INACTIVE_EVIDENCE', 'EVIDENCE_CHANGED'].includes(job.error.code) ? 'evidence_changed'
          : undefined;
  if(expectedTermination ? job.termination?.reason !== expectedTermination : job.termination !== undefined) {
    throw new Error('LAB_FAILURE_TERMINATION_MISMATCH');
  }
  const lastReason = job.transitions.at(-1)?.reason;
  const expectedReason = LabTransitionReasonSchema.safeParse(job.error.code).success
    ? job.error.code
    : job.status === 'failed_retryable' ? 'LAB_PROVIDER_UNAVAILABLE'
      : job.status === 'cancelled' ? 'CANCELLED'
        : 'INVALID_OUTPUT';
  if(lastReason !== expectedReason) throw new Error('LAB_FAILURE_TRANSITION_REASON_MISMATCH');
}

export function parseLabJobV2(raw: unknown): LabJobRecordV2 {
  const job = LabJobRecordV2StructureSchema.parse(raw);
  const envelope = parseIngestionEnvelope(job.envelope);
  const ids = deriveLabRunIds(job.runIdentityDigest as `sha256:${string}`);
  if(job.idempotencyKey !== ids.idempotencyKey || job.runId !== ids.runId || job.jobId !== ids.jobId) {
    throw new Error('LAB_JOB_IDENTITY_MISMATCH');
  }
  if(job.authorization.actorId !== envelope.actorId || job.authorization.authorizationRevision !== envelope.authorizationRevision) {
    throw new Error('LAB_AUTHORIZATION_ENVELOPE_MISMATCH');
  }
  const expectedRunIdentityDigest = computeLabRunIdentityDigest(buildLabRunIdentity({
    contentDigest: job.contentDigest as `sha256:${string}`,
    attemptRevision: job.attemptRevision,
    executionProfile: job.executionProfile,
    authorizationGrantDigest: job.authorization.grantDigest as `sha256:${string}`,
    authorizationRevision: job.authorization.authorizationRevision,
    contextRevision: job.authorization.contextRevision,
    semanticContext: job.semanticContext,
    budgetPolicy: job.budgetPolicy
  }));
  if(job.runIdentityDigest !== expectedRunIdentityDigest) throw new Error('LAB_RUN_IDENTITY_MISMATCH');
  if(job.authorization.state === 'revoked' && job.authorization.revokedAt && epoch(job.updatedAt) < epoch(job.authorization.revokedAt)) {
    throw new Error('LAB_AUTHORIZATION_TIME_INVARIANT');
  }
  assertUniqueIds(job.actions, 'actionId', 'DUPLICATE_LAB_ACTION');
  assertUniqueIds(job.privacyEvents, 'eventId', 'DUPLICATE_LAB_PRIVACY_EVENT');
  validateJobTimes(job);
  validateTransitions(job);
  validateJobPayloads(job, envelope);
  validateJobOutcome(job, envelope);
  return { ...job, envelope } as LabJobRecordV2;
}

export const LabJobRecordV2Schema = z.unknown().transform((raw, ctx): LabJobRecordV2 => {
  try {
    return parseLabJobV2(raw);
  } catch(error) {
    issue(ctx, error instanceof Error ? error.message : 'INVALID_LAB_JOB_V2');
    return z.NEVER;
  }
});

const LabProductEvidenceCommonShape = {
  evidenceId: id,
  subjectId: id,
  householdId: id,
  schemaVersion: z.literal('1.0'),
  ownerId: id,
  contributorId: id,
  circleId: id.optional(),
  consentRef: id,
  visibility: z.enum(['private', 'household', 'circle']),
  visibilityAuthorityRef: id.optional(),
  ingestedAt: dateTime,
  capturedAt: dateTime.optional(),
  lifecycleState: z.enum(['active', 'trashed', 'deletion_pending']),
  sourceRef: z.object({ kind: z.enum(['object', 'message']), id }).strict(),
  sourceHash: hash,
  revision: z.number().int().positive(),
  byteLength: z.number().int().positive()
};

export const LabProductEvidenceSchema = z.discriminatedUnion('modality', [
  z.object({
    ...LabProductEvidenceCommonShape,
    modality: z.literal('image'),
    mimeType: imageMime,
    dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict()
  }).strict(),
  z.object({
    ...LabProductEvidenceCommonShape,
    modality: z.literal('text'),
    mimeType: z.literal('text/plain')
  }).strict(),
  z.object({
    ...LabProductEvidenceCommonShape,
    modality: z.literal('transcript'),
    mimeType: z.literal('text/plain'),
    asr: z.object({
      final: z.literal(true),
      producerVersion: z.string().min(1),
      confidence: z.number().min(0).max(1).optional()
    }).strict()
  }).strict()
]);

export const LabProductEnvelopeSchema = IngestionEnvelopeStructureSchema.omit({
  scope: true,
  context: true,
  evidence: true,
  contents: true,
  bindings: true
}).extend({
  scope: IngestionScopeSchema,
  context: IngestionContextSchema,
  evidence: z.array(LabProductEvidenceSchema).min(1).max(5000),
  contents: z.array(IngestionContentSchema).min(1).max(5000),
  bindings: z.array(EvidenceBindingSchema).max(10_000)
}).strict();

export const LabProductJobViewSchema = z.object({
  version: z.literal(LAB_JOB_VERSION_V2),
  revision: z.number().int().nonnegative(),
  jobId: id,
  runId: id,
  status: LabJobStatusV2Schema,
  createdAt: dateTime,
  updatedAt: dateTime,
  finishedAt: dateTime.optional(),
  authorizationState: z.enum(['active', 'revoked']),
  envelope: LabProductEnvelopeSchema,
  originalTextByEvidenceId: z.record(id, z.string().max(65536)),
  assetRefs: z.array(LabAssetRefV2Schema).max(5000),
  result: LabExecutionResultSchema.optional(),
  metrics: LabExecutionMetricsSchema.optional(),
  error: z.object({ code: id }).strict().optional(),
  actionCount: z.number().int().nonnegative(),
  redacted: z.literal(false)
}).strict();

export type LabProductJobView = z.infer<typeof LabProductJobViewSchema>;

export const LabRedactedJobShellSchema = z.object({
  version: z.literal(LAB_JOB_VERSION_V2),
  jobId: id,
  status: LabJobStatusV2Schema,
  createdAt: dateTime,
  updatedAt: dateTime,
  error: z.object({ code: id }).strict().optional(),
  redacted: z.literal(true)
}).strict();

export type LabRedactedJobShell = z.infer<typeof LabRedactedJobShellSchema>;

export const LabFailureDispositionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('persist'),
    status: z.enum(['cancelled', 'failed_retryable', 'failed_terminal']),
    retryable: z.boolean(),
    code: id
  }).strict(),
  z.object({ kind: z.literal('no_write'), code: z.literal('STALE_RESULT') }).strict(),
  z.object({
    kind: z.literal('throw'),
    code: z.enum(['LAB_STORE_WRITE_FAILED', 'LAB_STORE_CORRUPT'])
  }).strict()
]);

export type LabFailureDisposition = z.infer<typeof LabFailureDispositionSchema>;

export function mapLabExecutionError(code: string): LabFailureDisposition {
  if(code === 'STALE_RESULT') return { kind: 'no_write', code };
  if(code === 'LAB_STORE_WRITE_FAILED' || code === 'LAB_STORE_CORRUPT') return { kind: 'throw', code };
  if(code === 'CANCELLED' || code === 'AUTHORIZATION_REVOKED' || code === 'AUTHORIZATION_CHANGED' || code === 'INACTIVE_EVIDENCE' || code === 'EVIDENCE_CHANGED') {
    return { kind: 'persist', status: 'cancelled', retryable: false, code };
  }
  if(code === 'LAB_RUN_TIMEOUT' || code === 'LAB_PROVIDER_UNAVAILABLE' || code === 'LAB_GUARD_UNAVAILABLE' || code === 'LAB_RUN_INTERRUPTED'
    || code === 'DOWNLOAD_FAILED' || code === 'FEATURE_SERVICE_UNAVAILABLE' || code === 'OCR_FAILED'
    || code === 'EMBEDDING_FAILED' || code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_RATE_LIMITED'
    || code === 'RESULT_UPLOAD_FAILED' || code === 'HISTORY_INDEX_FAILED' || code === 'INTERNAL_ERROR') {
    return { kind: 'persist', status: 'failed_retryable', retryable: true, code };
  }
  return { kind: 'persist', status: 'failed_terminal', retryable: false, code: id.parse(code) };
}

export const mapLabFailure = mapLabExecutionError;
