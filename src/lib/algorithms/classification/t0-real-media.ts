import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseIngestionEnvelope, type IngestionEnvelope } from './ingestion-contract';
import { decodeUtf8Payload, inspectImagePayload } from './media-inspection';

export const T0_REAL_MEDIA_SPEC_VERSION = '2.0.0';
export const T0_REAL_MEDIA_CONTRACT_VERSION = 'classification-t0-real-media.1';
export const T0_TRUTH_CONTRACT_VERSION = 'classification-t0-truth.1';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });
const relativeFile = z.string().min(1).max(1024);
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

export const T0ScenarioTagSchema = z.enum([
  'single_image', 'multi_image', 'text_only', 'asr_only', 'image_text', 'image_asr', 'image_text_asr',
  'album_upload', 'family_transfer', 'batch_text', 'explicit_multi_binding', 'conflict', 'abstain',
  'old_photo', 'new_photo', 'near_duplicate', 'same_event', 'different_event_same_context',
  'withdrawal', 'sensitive_high_risk'
]);

export const T0_REQUIRED_SCENARIOS = [
  'single_image', 'multi_image', 'text_only', 'asr_only', 'image_text', 'image_asr', 'image_text_asr',
  'album_upload', 'family_transfer', 'batch_text', 'explicit_multi_binding', 'conflict', 'abstain',
  'old_photo', 'new_photo', 'near_duplicate', 'same_event', 'different_event_same_context',
  'withdrawal', 'sensitive_high_risk'
] as const;

export const T0SourceSchema = z.object({
  evidenceId: id,
  path: relativeFile,
  sourceHash: sha,
  byteLength: z.number().int().positive().max(20 * 1024 * 1024),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'text/plain']),
  consentRef: id,
  origin: z.literal('real_user_provided')
}).strict();

export const T0GroupSchema = z.object({
  groupId: id,
  partition: z.enum(['exploration', 't1_validation']),
  leakageGroup: id,
  envelopePath: relativeFile,
  sources: z.array(T0SourceSchema).max(5000).refine(values => unique(values.map(value => value.evidenceId)), 'DUPLICATE_SOURCE_EVIDENCE'),
  scenarioTags: z.array(T0ScenarioTagSchema).min(1).refine(unique, 'DUPLICATE_SCENARIO_TAG')
}).strict();

export const T0ManifestSchema = z.object({
  specVersion: z.literal(T0_REAL_MEDIA_SPEC_VERSION),
  contractVersion: z.literal(T0_REAL_MEDIA_CONTRACT_VERSION),
  datasetId: id,
  status: z.enum(['draft', 'frozen']),
  purpose: z.literal('t0_t1_calibration'),
  plannedGroups: z.number().int().min(30).max(50),
  personMatching: z.literal('disabled'),
  rawMediaPolicy: z.literal('outside_git'),
  requiredScenarioTags: z.array(T0ScenarioTagSchema).refine(unique, 'DUPLICATE_REQUIRED_SCENARIO'),
  truth: z.object({ path: relativeFile, sourceHash: sha }).strict(),
  groups: z.array(T0GroupSchema).min(1).max(50).refine(values => unique(values.map(value => value.groupId)), 'DUPLICATE_GROUP'),
  createdAt: dateTime
}).strict();

const facetTruth = z.object({
  time: z.array(z.string().min(1).max(256)).max(32),
  place: z.array(z.string().min(1).max(256)).max(32),
  event: z.array(z.string().min(1).max(256)).max(32),
  scene: z.array(z.string().min(1).max(256)).max(32),
  theme: z.array(z.string().min(1).max(256)).max(32)
}).strict();

export const T0TruthSchema = z.object({
  specVersion: z.literal(T0_REAL_MEDIA_SPEC_VERSION),
  contractVersion: z.literal(T0_TRUTH_CONTRACT_VERSION),
  datasetId: id,
  reviewedBy: z.string().min(1).max(256),
  frozenAt: dateTime,
  groups: z.array(z.object({
    groupId: id,
    contents: z.array(z.object({
      contentId: id,
      evidenceId: id,
      sourceHash: sha.optional(),
      expectedStoryKey: id,
      expectedAction: z.enum(['auto_organize', 'needs_review', 'abstain']),
      riskLevel: z.enum(['low', 'medium', 'high']),
      facets: facetTruth
    }).strict()).min(1).max(5000).refine(values => unique(values.map(value => value.contentId)), 'DUPLICATE_TRUTH_CONTENT')
  }).strict()).min(1).max(50).refine(values => unique(values.map(value => value.groupId)), 'DUPLICATE_TRUTH_GROUP')
}).strict();

export type T0Manifest = z.infer<typeof T0ManifestSchema>;
export type T0Truth = z.infer<typeof T0TruthSchema>;

export interface T0PreflightGroup {
  groupId: string;
  envelope: IngestionEnvelope;
  payloads: Record<string, Buffer>;
}

export interface T0PreflightResult {
  ready: boolean;
  blockers: string[];
  manifestHash: string;
  truthHash: string;
  manifest: T0Manifest;
  truth: T0Truth;
  root: string;
  groups: T0PreflightGroup[];
  summary: {
    status: 'offline_preflight_only';
    credentialsRead: false;
    externalCalls: 0;
    groups: number;
    images: number;
    userTexts: number;
    finalAsr: number;
    albumUploads: number;
    familyTransfers: number;
    totalBytes: number;
    missingScenarioTags: string[];
    partitions: Record<'exploration' | 't1_validation', number>;
  };
}

export class T0PreflightError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function fail(code: string): never { throw new T0PreflightError(code); }
function ensure(ok: unknown, code: string): asserts ok { if(!ok) fail(code); }
function hash(bytes: Buffer): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

async function safeFile(root: string, relativePath: string): Promise<string> {
  ensure(!path.isAbsolute(relativePath), 'ABSOLUTE_SOURCE_PATH');
  const resolved = path.resolve(root, relativePath);
  ensure(resolved.startsWith(`${root}${path.sep}`), 'SOURCE_PATH_ESCAPE');
  const info = await lstat(resolved);
  ensure(info.isFile() && !info.isSymbolicLink(), 'SOURCE_NOT_REGULAR_FILE');
  const canonical = await realpath(resolved);
  ensure(canonical.startsWith(`${root}${path.sep}`), 'SOURCE_SYMLINK_ESCAPE');
  return canonical;
}

function verifyPayload(bytes: Buffer, mimeType: T0Manifest['groups'][number]['sources'][number]['mimeType']): { width: number; height: number } | undefined {
  if(mimeType === 'text/plain') {
    decodeUtf8Payload(bytes);
    return undefined;
  }
  return inspectImagePayload(bytes, mimeType);
}

function validateStructuralScenarioTags(group: T0Manifest['groups'][number], envelope: IngestionEnvelope): void {
  const active = envelope.contents.filter(content => content.lifecycleState === 'active');
  const count = (modality: 'image' | 'user_text' | 'final_asr') => active.filter(content => content.modality === modality).length;
  const images = count('image'); const texts = count('user_text'); const asr = count('final_asr');
  const tags = new Set(group.scenarioTags);
  if(tags.has('single_image')) ensure(images === 1, 'SCENARIO_TAG_MISMATCH');
  if(tags.has('multi_image')) ensure(images >= 2, 'SCENARIO_TAG_MISMATCH');
  if(tags.has('text_only')) ensure(texts > 0 && images === 0 && asr === 0, 'SCENARIO_TAG_MISMATCH');
  if(tags.has('asr_only')) ensure(asr > 0 && images === 0 && texts === 0, 'SCENARIO_TAG_MISMATCH');
  if(tags.has('image_text')) ensure(images > 0 && texts > 0, 'SCENARIO_TAG_MISMATCH');
  if(tags.has('image_asr')) ensure(images > 0 && asr > 0, 'SCENARIO_TAG_MISMATCH');
  if(tags.has('image_text_asr')) ensure(images > 0 && texts > 0 && asr > 0, 'SCENARIO_TAG_MISMATCH');
  if(tags.has('album_upload')) ensure(envelope.context.kind === 'album_upload', 'SCENARIO_TAG_MISMATCH');
  if(tags.has('family_transfer')) ensure(envelope.context.kind === 'family_transfer', 'SCENARIO_TAG_MISMATCH');
  if(tags.has('batch_text')) ensure(envelope.bindings.some(binding => binding.target.kind === 'batch' && envelope.contents.find(content => content.contentId === binding.sourceContentId)?.modality === 'user_text'), 'SCENARIO_TAG_MISMATCH');
  if(tags.has('explicit_multi_binding')) ensure(envelope.bindings.some(binding => binding.authority === 'user_explicit' && binding.target.kind === 'contents' && binding.target.contentIds.length > 1), 'SCENARIO_TAG_MISMATCH');
  if(tags.has('withdrawal')) ensure(envelope.contents.some(content => content.lifecycleState === 'withdrawn'), 'SCENARIO_TAG_MISMATCH');
}

/** Offline-only validation. It never reads credentials, calls a provider or changes media. */
export async function preflightT0RealMedia(manifestPath: string): Promise<T0PreflightResult> {
  const absoluteManifest = path.resolve(manifestPath);
  const root = await realpath(path.dirname(absoluteManifest));
  const manifestBytes = await readFile(await safeFile(root, path.basename(absoluteManifest)));
  const manifest = T0ManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const truthBytes = await readFile(await safeFile(root, manifest.truth.path));
  ensure(hash(truthBytes) === manifest.truth.sourceHash, 'TRUTH_HASH_MISMATCH');
  const truth = T0TruthSchema.parse(JSON.parse(truthBytes.toString('utf8')));
  ensure(truth.datasetId === manifest.datasetId, 'TRUTH_DATASET_MISMATCH');

  const blockers: string[] = [];
  if(manifest.status !== 'frozen') blockers.push('MANIFEST_DRAFT');
  if(manifest.groups.length !== manifest.plannedGroups) blockers.push('PLANNED_GROUP_COUNT_MISMATCH');
  if(/^pending/i.test(truth.reviewedBy.trim())) blockers.push('TRUTH_REVIEW_PENDING');
  const requiredScenarios = new Set(T0_REQUIRED_SCENARIOS);
  if(manifest.status === 'frozen' && (manifest.requiredScenarioTags.length !== requiredScenarios.size || manifest.requiredScenarioTags.some(tag => !requiredScenarios.has(tag)))) {
    blockers.push('REQUIRED_SCENARIO_MATRIX_INCOMPLETE');
  }

  const truthByGroup = new Map(truth.groups.map(group => [group.groupId, group]));
  ensure(truthByGroup.size === manifest.groups.length && manifest.groups.every(group => truthByGroup.has(group.groupId)), 'TRUTH_GROUP_SET_MISMATCH');
  const partitionByLeakage = new Map<string, string>();
  const leakageByHash = new Map<string, string>();
  const scenarioCoverage = new Set<string>();
  const groups: T0PreflightGroup[] = [];
  let images = 0; let userTexts = 0; let finalAsr = 0; let albumUploads = 0; let familyTransfers = 0; let totalBytes = 0;
  const partitions = { exploration: 0, t1_validation: 0 };

  for(const group of manifest.groups) {
    partitions[group.partition] += 1;
    group.scenarioTags.forEach(tag => scenarioCoverage.add(tag));
    const previousPartition = partitionByLeakage.get(group.leakageGroup);
    ensure(!previousPartition || previousPartition === group.partition, 'LEAKAGE_GROUP_CROSSES_PARTITION');
    partitionByLeakage.set(group.leakageGroup, group.partition);
    const envelopeBytes = await readFile(await safeFile(root, group.envelopePath));
    const envelope = parseIngestionEnvelope(JSON.parse(envelopeBytes.toString('utf8')));
    ensure(envelope.batchId === group.groupId, 'GROUP_BATCH_ID_MISMATCH');
    validateStructuralScenarioTags(group, envelope);
    if(envelope.context.kind === 'album_upload') albumUploads += 1; else familyTransfers += 1;

    const recordsWithPayload = envelope.evidence.filter(record => record.lifecycleState !== 'deleted');
    ensure(group.sources.length === recordsWithPayload.length, 'SOURCE_SET_MISMATCH');
    const sourceByEvidence = new Map(group.sources.map(source => [source.evidenceId, source]));
    const payloads: Record<string, Buffer> = {};
    for(const record of recordsWithPayload) {
      const source = sourceByEvidence.get(record.evidenceId);
      ensure(source, 'SOURCE_SET_MISMATCH');
      ensure(source.sourceHash === record.sourceHash && source.byteLength === record.byteLength && source.mimeType === record.mimeType && source.consentRef === record.consentRef, 'SOURCE_METADATA_MISMATCH');
      const priorLeakage = leakageByHash.get(source.sourceHash);
      ensure(!priorLeakage || priorLeakage === group.leakageGroup, 'DUPLICATE_SOURCE_CROSSES_LEAKAGE_GROUP');
      leakageByHash.set(source.sourceHash, group.leakageGroup);
      const bytes = await readFile(await safeFile(root, source.path));
      ensure(bytes.length === source.byteLength, 'SOURCE_LENGTH_MISMATCH');
      ensure(hash(bytes) === source.sourceHash, 'SOURCE_HASH_MISMATCH');
      const dimensions = verifyPayload(bytes, source.mimeType);
      if(record.modality === 'image') {
        images += 1;
        ensure(dimensions?.width === record.dimensions.width && dimensions.height === record.dimensions.height, 'IMAGE_DIMENSIONS_MISMATCH');
      } else if(record.modality === 'text') userTexts += 1;
      else finalAsr += 1;
      totalBytes += bytes.length;
      payloads[record.evidenceId] = bytes;
    }
    ensure(group.sources.every(source => recordsWithPayload.some(record => record.evidenceId === source.evidenceId)), 'SOURCE_SET_MISMATCH');

    const groupTruth = truthByGroup.get(group.groupId)!;
    ensure(groupTruth.contents.length === envelope.contents.length, 'TRUTH_CONTENT_SET_MISMATCH');
    const truthByContent = new Map(groupTruth.contents.map(content => [content.contentId, content]));
    for(const content of envelope.contents) {
      const item = truthByContent.get(content.contentId);
      ensure(item && item.evidenceId === content.evidenceId, 'TRUTH_CONTENT_SET_MISMATCH');
      const record = envelope.evidence.find(value => value.evidenceId === content.evidenceId)!;
      if(record.lifecycleState === 'deleted') ensure(item.sourceHash === undefined, 'DELETED_TRUTH_HAS_SOURCE_HASH');
      else ensure(item.sourceHash === record.sourceHash, 'TRUTH_SOURCE_MISMATCH');
    }
    groups.push({ groupId: group.groupId, envelope, payloads });
  }

  const missingScenarioTags = manifest.requiredScenarioTags.filter(tag => !scenarioCoverage.has(tag));
  if(missingScenarioTags.length) blockers.push('SCENARIO_COVERAGE_MISSING');
  if(images === 0 || userTexts === 0 || finalAsr === 0 || albumUploads === 0 || familyTransfers === 0) blockers.push('MODALITY_OR_CONTEXT_COVERAGE_MISSING');
  if(!truth.groups.some(group => group.contents.some(content => content.expectedAction === 'needs_review' && content.riskLevel === 'high'))) blockers.push('HIGH_RISK_REVIEW_TRUTH_MISSING');
  if(!truth.groups.some(group => group.contents.some(content => content.expectedAction === 'abstain'))) blockers.push('ABSTAIN_TRUTH_MISSING');

  return {
    ready: blockers.length === 0,
    blockers,
    manifestHash: hash(manifestBytes),
    truthHash: hash(truthBytes),
    manifest,
    truth,
    root,
    groups,
    summary: {
      status: 'offline_preflight_only', credentialsRead: false, externalCalls: 0,
      groups: manifest.groups.length, images, userTexts, finalAsr, albumUploads, familyTransfers, totalBytes,
      missingScenarioTags,
      partitions
    }
  };
}
