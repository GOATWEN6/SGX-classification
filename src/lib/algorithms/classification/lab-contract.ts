import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EvidenceRecord } from './types';
import { digest } from './stage-a-contract';
import {
  INGESTION_CONTRACT_VERSION,
  INGESTION_SPEC_VERSION,
  parseIngestionEnvelope,
  type EvidenceBinding,
  type IngestionContent,
  type IngestionEnvelope
} from './ingestion-contract';
import { inspectImagePayload, type SupportedImageMime } from './media-inspection';

export const CLASSIFICATION_LAB_VERSION = 'classification-lab.1';
export const LAB_MAX_IMAGES = 20;
export const LAB_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const LAB_MAX_TOTAL_BYTES = 80 * 1024 * 1024;
export const LAB_MAX_TEXT_BYTES = 64 * 1024;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const dateTime = z.string().datetime({ offset: true });
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

export const LabSubmissionMetadataSchema = z.object({
  scope: z.object({ householdId: id, subjectId: id }).strict(),
  actorId: id,
  contextKind: z.enum(['album_upload', 'family_transfer']),
  senderId: id.optional(),
  recipientIds: z.array(id).max(100).refine(unique, 'DUPLICATE_RECIPIENT').default([]),
  userText: z.string().max(65536).optional(),
  finalAsr: z.string().max(65536).optional(),
  userTextTargetIndexes: z.array(z.number().int().nonnegative().max(LAB_MAX_IMAGES - 1)).max(LAB_MAX_IMAGES).refine(unique, 'DUPLICATE_TARGET').nullable().default(null),
  finalAsrTargetIndexes: z.array(z.number().int().nonnegative().max(LAB_MAX_IMAGES - 1)).max(LAB_MAX_IMAGES).refine(unique, 'DUPLICATE_TARGET').nullable().default(null),
  submittedAt: dateTime
}).strict().superRefine((value, ctx) => {
  if(value.contextKind === 'family_transfer' && (!value.senderId || !value.recipientIds.length)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FAMILY_TRANSFER_PARTIES_REQUIRED' });
  if(value.contextKind === 'album_upload' && (value.senderId || value.recipientIds.length)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ALBUM_UPLOAD_HAS_TRANSFER_PARTIES' });
  if(value.userTextTargetIndexes && !value.userText?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'USER_TEXT_TARGET_WITHOUT_TEXT' });
  if(value.finalAsrTargetIndexes && !value.finalAsr?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FINAL_ASR_TARGET_WITHOUT_TEXT' });
});

export interface LabImageUpload {
  filename: string;
  mimeType: SupportedImageMime;
  bytes: Buffer;
}

export interface LabSubmission extends z.input<typeof LabSubmissionMetadataSchema> {
  images: LabImageUpload[];
}

export interface LabAsset {
  evidenceId: string;
  filename: string;
  mimeType: SupportedImageMime | 'text/plain';
  bytes: Buffer;
}

export interface BuiltLabSubmission {
  jobId: string;
  idempotencyKey: string;
  envelope: IngestionEnvelope;
  payloads: { textByEvidenceId: Record<string, string> };
  assets: LabAsset[];
}

/**
 * Trusted service-side overrides used by the multi-round T1 harness. These
 * values must come from the server session store, never from browser metadata.
 */
export interface BuildLabSubmissionOptions {
  consentRef?: string;
  authorizationRevision?: string;
}

export class LabContractError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function fail(code: string): never { throw new LabContractError(code); }
function bytesHash(bytes: Buffer): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function bytesLength(text: string): number { return Buffer.byteLength(text, 'utf8'); }
function safeFilename(filename: string, fallback: string): string {
  const value = filename.normalize('NFKC').replace(/[\u0000-\u001f/\\]/g, '_').trim();
  return [...(value || fallback)].slice(0, 160).join('');
}

function bindingTarget(indexes: number[] | null, imageContents: IngestionContent[]): EvidenceBinding['target'] {
  if(indexes === null) return { kind: 'batch' };
  if(!indexes.length) fail('EMPTY_CONTENT_TARGET');
  const contentIds = indexes.map(index => imageContents[index]?.contentId);
  if(contentIds.some(value => !value)) fail('TARGET_IMAGE_INDEX_OUT_OF_RANGE');
  return { kind: 'contents', contentIds: contentIds as string[] };
}

export function buildLabSubmission(
  raw: LabSubmission,
  options: string | BuildLabSubmissionOptions = {}
): BuiltLabSubmission {
  const trusted = typeof options === 'string' ? { consentRef: options } : options;
  const consentRef = id.parse(trusted.consentRef ?? 'classification_lab_local_consent');
  const trustedAuthorizationRevision = trusted.authorizationRevision === undefined
    ? undefined
    : id.parse(trusted.authorizationRevision);
  const { images, ...metadataInput } = raw;
  const metadata = LabSubmissionMetadataSchema.parse(metadataInput);
  if(images.length > LAB_MAX_IMAGES) fail('TOO_MANY_IMAGES');
  const userText = metadata.userText?.normalize('NFKC').trim();
  const finalAsr = metadata.finalAsr?.normalize('NFKC').trim();
  if(!images.length && !userText && !finalAsr) fail('EMPTY_SUBMISSION');
  if(userText && bytesLength(userText) > LAB_MAX_TEXT_BYTES) fail('USER_TEXT_TOO_LARGE');
  if(finalAsr && bytesLength(finalAsr) > LAB_MAX_TEXT_BYTES) fail('FINAL_ASR_TOO_LARGE');
  if(images.some(image => !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType))) fail('UNSUPPORTED_IMAGE_TYPE');
  if(images.some(image => image.bytes.length <= 0 || image.bytes.length > LAB_MAX_IMAGE_BYTES)) fail('IMAGE_SIZE_LIMIT');
  const totalBytes = images.reduce((sum, image) => sum + image.bytes.length, 0) + (userText ? bytesLength(userText) : 0) + (finalAsr ? bytesLength(finalAsr) : 0);
  if(totalBytes > LAB_MAX_TOTAL_BYTES) fail('TOTAL_SIZE_LIMIT');

  const imageInputs = images.map((image, index) => {
    const dimensions = inspectImagePayload(image.bytes, image.mimeType);
    if(dimensions.width * dimensions.height > 40_000_000) fail('IMAGE_PIXEL_LIMIT');
    return { image, index, dimensions, sourceHash: bytesHash(image.bytes) };
  });
  const inputIdentity = {
    scope: metadata.scope,
    actorId: metadata.actorId,
    contextKind: metadata.contextKind,
    senderId: metadata.senderId,
    recipientIds: metadata.recipientIds,
    images: imageInputs.map(value => ({ sourceHash: value.sourceHash, mimeType: value.image.mimeType, filename: safeFilename(value.image.filename, `image-${value.index + 1}`) })),
    userText, finalAsr,
    userTextTargetIndexes: metadata.userTextTargetIndexes,
    finalAsrTargetIndexes: metadata.finalAsrTargetIndexes
  };
  const idempotencyKey = digest(inputIdentity);
  const key = idempotencyKey.slice(7, 31);
  const jobId = `lab_${key}`;
  const visibility = metadata.contextKind === 'family_transfer' ? 'household' : 'private';
  const evidence: EvidenceRecord[] = [];
  const contents: IngestionContent[] = [];
  const assets: LabAsset[] = [];
  const payloads: Record<string, string> = {};

  for(const value of imageInputs) {
    const suffix = `${String(value.index + 1).padStart(2, '0')}_${value.sourceHash.slice(7, 15)}`;
    const evidenceId = `evidence_image_${suffix}`;
    const contentId = `content_image_${suffix}`;
    evidence.push({
      evidenceId, subjectId: metadata.scope.subjectId, householdId: metadata.scope.householdId, schemaVersion: '1.0',
      ownerId: metadata.scope.subjectId, contributorId: metadata.actorId, consentRef, visibility,
      ingestedAt: metadata.submittedAt, lifecycleState: 'active', sourceRef: { kind: 'object', id: `lab_asset_${suffix}` },
      sourceHash: value.sourceHash, revision: 1, byteLength: value.image.bytes.length, modality: 'image', mimeType: value.image.mimeType,
      dimensions: value.dimensions
    });
    contents.push({ contentId, evidenceId, modality: 'image', lifecycleState: 'active' });
    assets.push({ evidenceId, filename: safeFilename(value.image.filename, `${evidenceId}.image`), mimeType: value.image.mimeType, bytes: value.image.bytes });
  }
  const imageContents = [...contents];
  const bindings: EvidenceBinding[] = [];
  const addText = (value: string, modality: 'user_text' | 'final_asr', targetIndexes: number[] | null) => {
    const bytes = Buffer.from(value, 'utf8');
    const sourceHash = bytesHash(bytes);
    const suffix = `${modality}_${sourceHash.slice(7, 15)}`;
    const evidenceId = `evidence_${suffix}`;
    const contentId = `content_${suffix}`;
    const common = {
      evidenceId, subjectId: metadata.scope.subjectId, householdId: metadata.scope.householdId, schemaVersion: '1.0',
      ownerId: metadata.actorId, contributorId: metadata.actorId, consentRef, visibility,
      ingestedAt: metadata.submittedAt, lifecycleState: 'active', sourceRef: { kind: modality === 'user_text' ? 'message' : 'object', id: `lab_asset_${suffix}` },
      sourceHash, revision: 1, byteLength: bytes.length
    } as const;
    evidence.push(modality === 'user_text'
      ? { ...common, modality: 'text', mimeType: 'text/plain' }
      : { ...common, modality: 'transcript', mimeType: 'text/plain', asr: { final: true, producerVersion: 'classification-lab-asr-input.1' } });
    contents.push({ contentId, evidenceId, modality, lifecycleState: 'active' });
    payloads[evidenceId] = value;
    assets.push({ evidenceId, filename: `${evidenceId}.txt`, mimeType: 'text/plain', bytes });
    const target = bindingTarget(targetIndexes, imageContents);
    const targetEvidence = target.kind === 'contents'
      ? target.contentIds.map(targetId => imageContents.find(content => content.contentId === targetId)!.evidenceId)
      : [];
    bindings.push({
      bindingId: `binding_${suffix}`, sourceContentId: contentId, target,
      authority: 'user_explicit', state: 'active',
      method: target.kind === 'batch' ? 'user-unspecified-batch.1' : 'user-selection.1',
      evidenceRefs: [evidenceId, ...targetEvidence], createdAt: metadata.submittedAt
    });
  };
  if(userText) addText(userText, 'user_text', metadata.userTextTargetIndexes);
  if(finalAsr) addText(finalAsr, 'final_asr', metadata.finalAsrTargetIndexes);

  const envelope = parseIngestionEnvelope({
    specVersion: INGESTION_SPEC_VERSION,
    contractVersion: INGESTION_CONTRACT_VERSION,
    ingestionId: `ingestion_${key}`,
    batchId: `batch_${key}`,
    scope: metadata.scope,
    actorId: metadata.actorId,
    context: metadata.contextKind === 'family_transfer'
      ? { kind: 'family_transfer', senderId: metadata.senderId, recipientIds: metadata.recipientIds }
      : { kind: 'album_upload' },
    authorizationRevision: trustedAuthorizationRevision ?? `lab_auth_${key}`,
    taxonomyVersion: 'classification-lab-taxonomy.1',
    purposes: ['classification', 'album_organization', 'search_candidate', 'interview_candidate'],
    evidence,
    contents,
    bindings,
    ...(metadata.contextKind === 'family_transfer' ? { reviewPolicy: { policyVersion: 'family-inbox.1', remindAfterDays: 3, hideFromHomeAfterDays: 7, highRiskRetention: 'until_resolved' } } : {}),
    createdAt: metadata.submittedAt
  });
  return { jobId, idempotencyKey, envelope, payloads: { textByEvidenceId: payloads }, assets };
}
