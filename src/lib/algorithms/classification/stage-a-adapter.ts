import { createHash } from 'node:crypto';
import type { Correction, Photo, Reference, Request, RetrievalHint, Scope, Budget } from './stage-a-contract';
import { RequestSchema, StageError, digest, photoHash } from './stage-a-contract';
import type { EvidenceRecord, SourceRef } from './types';
import type { AuthorizationSnapshot } from './stage-a-pipeline';
import type { AuthorizedImage, ImageResolver } from './stage-a-provider';

type ActiveImageEvidence = Extract<EvidenceRecord, { modality: 'image' }>;
type ActiveTextEvidence = Extract<EvidenceRecord, { modality: 'text' }>;
type ActiveTranscriptEvidence = Extract<EvidenceRecord, { modality: 'transcript' }>;
type DeletedImageTombstone = Extract<EvidenceRecord, { lifecycleState: 'deleted' }>;
type TextRecord = ActiveTextEvidence | ActiveTranscriptEvidence;

export interface TrustedTextEvidence {
  record: TextRecord;
  text: string;
}

export interface TrustedPhotoEvidence {
  image: ActiveImageEvidence | DeletedImageTombstone;
  imageBytes?: Uint8Array;
  ocrText?: string;
  textEvidence: TrustedTextEvidence[];
  priorPhoto?: Photo;
}

export interface TrustedStageACatalog {
  actorId: string;
  scope: Scope;
  authorizationRevision: string;
  contextRevision: string;
  authorityRef: string;
  allowPersonMatching: boolean;
  allowedEvidenceIds: string[];
  allowedConsentRefs: string[];
  evidence: EvidenceRecord[];
  photos: TrustedPhotoEvidence[];
  references: Reference[];
  corrections: Correction[];
}

export interface StageAAdapterOptions {
  runId: string;
  trigger: Request['trigger'];
  budget: Budget;
  retrievalHints?: RetrievalHint[];
}

export interface EvidenceAuditEntry {
  evidenceId: string;
  modality: 'image' | 'text' | 'transcript' | 'deleted';
  sourceRef?: SourceRef;
  sourceHash?: string;
  revision: number;
  ownerId?: string;
  contributorId?: string;
  consentRef?: string;
  lifecycleState: EvidenceRecord['lifecycleState'];
  boundPhotoId?: string;
}

export interface AdaptedStageAInput {
  request: Request;
  authorization: AuthorizationSnapshot;
  resolveImage: ImageResolver;
  audit: { actorId: string; authorityRef: string; evidence: EvidenceAuditEntry[] };
}

function fail(code: string): never { throw new StageError(code); }
function hashBytes(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function byteLength(text: string): number { return Buffer.byteLength(text, 'utf8'); }
function asArray<T>(values: readonly T[]): T[] { return [...values]; }
function sameScope(record: EvidenceRecord, scope: Scope): boolean {
  return 'subjectId' in record && record.subjectId === scope.subjectId && record.householdId === scope.householdId;
}
function samePhotoScope(photo: Photo, scope: Scope): boolean {
  return photo.scope.householdId === scope.householdId && photo.scope.subjectId === scope.subjectId;
}
function isText(record: EvidenceRecord): record is TextRecord {
  return record.lifecycleState !== 'deleted' && (record.modality === 'text' || record.modality === 'transcript');
}
function isImage(record: EvidenceRecord): record is ActiveImageEvidence {
  return record.lifecycleState !== 'deleted' && record.modality === 'image';
}
function isDeleted(record: EvidenceRecord): record is DeletedImageTombstone {
  return record.lifecycleState === 'deleted';
}
function requireAllowed(record: EvidenceRecord, catalog: TrustedStageACatalog): void {
  if(!catalog.allowedEvidenceIds.includes(record.evidenceId))fail('NOT_AUTHORIZED');
  if(record.lifecycleState !== 'deleted' && !catalog.allowedConsentRefs.includes(record.consentRef))fail('NOT_AUTHORIZED');
}

function toPhoto(entry: TrustedPhotoEvidence, scope: Scope): { photo: Photo; bytes?: Uint8Array; audit: EvidenceAuditEntry[] } {
  const image = entry.image;
  if(!sameScope(image, scope))fail('CROSS_SCOPE');
  if(isDeleted(image)) {
    if(!entry.priorPhoto || entry.priorPhoto.photoId !== image.evidenceId || !samePhotoScope(entry.priorPhoto, scope))fail('DELETION_REQUIRES_PRIOR_PHOTO');
    if(entry.textEvidence.length)fail('INACTIVE_EVIDENCE');
    const photo = { ...entry.priorPhoto, active: false };
    return { photo, audit: [{ evidenceId: image.evidenceId, modality: 'deleted', revision: image.revision, lifecycleState: image.lifecycleState }] };
  }
  if(!isImage(image))fail('INVALID_EVIDENCE_BINDING');
  if(image.lifecycleState !== 'active')fail('INACTIVE_EVIDENCE');
  if(!entry.imageBytes?.length)fail('MISSING_EVIDENCE_PAYLOAD');
  if(entry.imageBytes.byteLength !== image.byteLength)fail('SOURCE_LENGTH_MISMATCH');
  if(hashBytes(entry.imageBytes) !== image.sourceHash)fail('SOURCE_HASH_MISMATCH');
  const textEvidence = entry.textEvidence.map(({record, text}) => {
    if(!isText(record))fail('INVALID_EVIDENCE_BINDING');
    if(!sameScope(record, scope))fail('CROSS_SCOPE');
    if(record.lifecycleState !== 'active')fail('INACTIVE_EVIDENCE');
    if(!text)fail('MISSING_EVIDENCE_PAYLOAD');
    if(byteLength(text) !== record.byteLength)fail('SOURCE_LENGTH_MISMATCH');
    if(hashBytes(Buffer.from(text, 'utf8')) !== record.sourceHash)fail('SOURCE_HASH_MISMATCH');
    if(record.modality === 'transcript' && !record.asr.final)fail('PARTIAL_ASR_NOT_ALLOWED');
    return { evidenceId: record.evidenceId, revision: record.revision, sourceHash: record.sourceHash, source: record.modality === 'transcript' ? 'final_asr' as const : 'user_text' as const, text };
  });
  const photo: Photo = {
    photoId: image.evidenceId,
    scope,
    revision: image.revision,
    sourceRef: image.evidenceId,
    sourceHash: image.sourceHash,
    mimeType: image.mimeType,
    caption: '',
    ...(entry.ocrText?.trim() ? { ocrText: entry.ocrText.trim() } : {}),
    textEvidence,
    ...(image.capturedAt ? { exif: { capturedAt: image.capturedAt, originalCapture: true } } : {}),
    active: true
  };
  const audit: EvidenceAuditEntry[] = [{ evidenceId: image.evidenceId, modality: image.modality, sourceRef: image.sourceRef, sourceHash: image.sourceHash, revision: image.revision, ownerId: image.ownerId, contributorId: image.contributorId, consentRef: image.consentRef, lifecycleState: image.lifecycleState }];
  for(const item of entry.textEvidence) {
    const record = item.record;
    audit.push({ evidenceId: record.evidenceId, modality: record.modality, sourceRef: record.sourceRef, sourceHash: record.sourceHash, revision: record.revision, ownerId: record.ownerId, contributorId: record.contributorId, consentRef: record.consentRef, lifecycleState: record.lifecycleState, boundPhotoId: image.evidenceId });
  }
  return { photo, bytes: entry.imageBytes, audit };
}

export function adaptTrustedStageACatalog(catalog: TrustedStageACatalog, options: StageAAdapterOptions): AdaptedStageAInput {
  if(!catalog.actorId || !catalog.authorityRef || !catalog.authorizationRevision || !catalog.contextRevision)fail('NOT_AUTHORIZED');
  const records = new Map<string, EvidenceRecord>();
  for(const record of catalog.evidence) {
    if(records.has(record.evidenceId))fail('INVALID_CONTRACT');
    records.set(record.evidenceId, record);
    if(!sameScope(record, catalog.scope))fail('CROSS_SCOPE');
    requireAllowed(record, catalog);
    if(record.lifecycleState === 'trashed' || record.lifecycleState === 'deletion_pending')fail('INACTIVE_EVIDENCE');
  }
  const entries = new Map<string, TrustedPhotoEvidence>();
  for(const entry of catalog.photos) {
    if(entries.has(entry.image.evidenceId))fail('DUPLICATE_EVIDENCE_BINDING');
    entries.set(entry.image.evidenceId, entry);
    if(!records.has(entry.image.evidenceId) || digest(records.get(entry.image.evidenceId)) !== digest(entry.image))fail('INVALID_EVIDENCE_BINDING');
  }
  const imageRecords = catalog.evidence.filter(record => isImage(record) || isDeleted(record));
  if(imageRecords.length !== entries.size || imageRecords.some(record => !entries.has(record.evidenceId)))fail('INCOMPLETE_EVIDENCE_CATALOG');
  const boundText = new Map<string, string>();
  for(const entry of catalog.photos) {
    for(const item of entry.textEvidence) {
      const record = records.get(item.record.evidenceId);
      if(!record || !isText(record) || digest(record) !== digest(item.record))fail('INVALID_EVIDENCE_BINDING');
      if(boundText.has(record.evidenceId))fail('DUPLICATE_EVIDENCE_BINDING');
      boundText.set(record.evidenceId, entry.image.evidenceId);
    }
  }
  const textRecords = catalog.evidence.filter(isText);
  if(textRecords.some(record => !boundText.has(record.evidenceId)))fail('UNBOUND_TEXT_EVIDENCE');
  const built = catalog.photos.map(entry => toPhoto(entry, catalog.scope));
  const photos = built.map(item => item.photo);
  const activePhotos = photos.filter(photo => photo.active);
  const versions = Object.fromEntries(activePhotos.map(photo => [photo.photoId, photoHash(photo)]));
  const authorization: AuthorizationSnapshot = {
    scope: catalog.scope,
    authorizationRevision: catalog.authorizationRevision,
    allowedPhotoIds: activePhotos.map(photo => photo.photoId),
    allowPersonMatching: catalog.allowPersonMatching,
    photoVersions: versions,
    contextRevision: catalog.contextRevision,
    reviewContextHash: digest([catalog.references, catalog.corrections]),
    active: true
  };
  const request: Request = RequestSchema.parse({ contractVersion: 'classification-stage-a.1', runId: options.runId, scope: catalog.scope, authorizationRevision: catalog.authorizationRevision, trigger: options.trigger, photos, references: asArray(catalog.references), corrections: asArray(catalog.corrections), ...(options.retrievalHints?.length ? { retrievalHints: asArray(options.retrievalHints) } : {}), budget: options.budget });
  const bytesByPhoto = new Map(built.flatMap(item => item.bytes ? [[item.photo.photoId, item.bytes] as const] : []));
  const resolveImage: ImageResolver = async (photo, signal) => {
    if(signal.aborted)fail('CANCELLED');
    const bytes = bytesByPhoto.get(photo.photoId);
    if(!photo.active || !bytes)fail('NOT_AUTHORIZED');
    if(hashBytes(bytes) !== photo.sourceHash)fail('SOURCE_HASH_MISMATCH');
    return { bytes: new Uint8Array(bytes), mimeType: photo.mimeType } satisfies AuthorizedImage;
  };
  return { request, authorization, resolveImage, audit: { actorId: catalog.actorId, authorityRef: catalog.authorityRef, evidence: built.flatMap(item => item.audit) } };
}
