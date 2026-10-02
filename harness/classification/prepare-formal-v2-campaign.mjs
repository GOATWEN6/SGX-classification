import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXPECTED_DATASET_DIGEST = 'sha256:2d18d96933f5c85454357eedee45cb185c9ad5eefac6f21e513ce0166ded0f2a';
export const FORMAL_MODEL = 'qwen3.7-flash-2026-07-15';
export const FORMAL_CAMPAIGN_ID = 'sgx_formal_v2_20261003_r4';
export const FORMAL_PROVIDER_REVIEW_REF = 'chat_2026_10_03_user_approved_150req_cny25_all_features_zero_retry';
export const CAMPAIGN_CAPS = Object.freeze({ maxRequests: 150, maxCostCny: 25, maxRetries: 0 });
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PERSON_TRUTH_PHOTO_IDS = Object.freeze([
  'SGX-V2-E016', 'SGX-V2-E017', 'SGX-V2-E018',
  'SGX-V2-H008', 'SGX-V2-H009', 'SGX-V2-H010',
]);

export const FORMAL_SUBMISSIONS = Object.freeze([
  { submissionId: 'E01', phase: 'exploration', context: 'album_upload', bundleIds: ['SGX-V2-E004', 'SGX-V2-E009', 'SGX-V2-E013', 'SGX-V2-E014', 'SGX-V2-E015'] },
  { submissionId: 'E02', phase: 'exploration', context: 'album_upload', bundleIds: ['SGX-SYN-E009'] },
  { submissionId: 'E03', phase: 'exploration', context: 'album_upload', bundleIds: ['SGX-SYN-E003', 'SGX-V2-E002'] },
  { submissionId: 'E04', phase: 'exploration', context: 'family_transfer', bundleIds: ['SGX-V2-E012', 'SGX-V2-E019'] },
  { submissionId: 'E05', phase: 'exploration', context: 'album_upload', bundleIds: ['SGX-SYN-E017', 'SGX-SYN-E023'] },
  { submissionId: 'E06', phase: 'exploration', context: 'family_transfer', bundleIds: ['SGX-V2-E006', 'SGX-V2-E010'] },
  { submissionId: 'E07', phase: 'exploration', context: 'album_upload', bundleIds: ['SGX-V2-E016', 'SGX-V2-E017'] },
  { submissionId: 'E08', phase: 'exploration', context: 'family_transfer', bundleIds: ['SGX-V2-E018', 'SGX-V2-E007'] },
  { submissionId: 'E09', phase: 'exploration', context: 'album_upload', bundleIds: ['SGX-V2-T001'] },
  { submissionId: 'E10', phase: 'exploration', context: 'family_transfer', bundleIds: ['SGX-V2-T003'] },
  { submissionId: 'E11', phase: 'exploration', context: 'album_upload', bundleIds: ['SGX-V2-A002'] },
  { submissionId: 'E12', phase: 'exploration', context: 'album_upload', bundleIds: ['SGX-V2-A003'] },
  { submissionId: 'V01', phase: 'validation', context: 'album_upload', bundleIds: ['SGX-SYN-H003', 'SGX-SYN-H001', 'SGX-V2-H008', 'SGX-V2-H009', 'SGX-V2-H010'] },
  { submissionId: 'V02', phase: 'validation', context: 'album_upload', bundleIds: ['SGX-SYN-H008'] },
  { submissionId: 'V03', phase: 'validation', context: 'family_transfer', bundleIds: ['SGX-V2-H001'] },
  { submissionId: 'V04', phase: 'validation', context: 'album_upload', bundleIds: ['SGX-V2-H002'] },
  { submissionId: 'V05', phase: 'validation', context: 'album_upload', bundleIds: ['SGX-V2-H005'] },
  { submissionId: 'V06', phase: 'validation', context: 'album_upload', bundleIds: ['SGX-V2-H006'] },
  { submissionId: 'V07', phase: 'validation', context: 'album_upload', bundleIds: ['SGX-V2-H007'] },
  { submissionId: 'V08', phase: 'validation', context: 'family_transfer', bundleIds: ['SGX-V2-H011'] },
]);

export const RELATION_ALLOWLIST = Object.freeze([
  ['R-E-001', 'exploration', 'SGX-V2-E013', 'SGX-V2-E014', 'same'],
  ['R-E-002', 'exploration', 'SGX-V2-E013', 'SGX-V2-E015', 'same'],
  ['R-E-003', 'exploration', 'SGX-V2-E014', 'SGX-V2-E015', 'same'],
  ['R-E-004', 'exploration', 'SGX-V2-E016', 'SGX-V2-E017', 'same'],
  ['R-E-005', 'exploration', 'SGX-V2-E016', 'SGX-V2-E018', 'same'],
  ['R-E-006', 'exploration', 'SGX-V2-E017', 'SGX-V2-E018', 'same'],
  ['R-E-007', 'exploration', 'SGX-V2-E009', 'SGX-V2-E013', 'different'],
  ['R-E-008', 'exploration', 'SGX-V2-E009', 'SGX-V2-E014', 'different'],
  ['R-E-009', 'exploration', 'SGX-V2-E009', 'SGX-V2-E015', 'different'],
  ['R-E-010', 'exploration', 'SGX-V2-E007', 'SGX-V2-E016', 'different'],
  ['R-E-011', 'exploration', 'SGX-V2-E007', 'SGX-V2-E017', 'different'],
  ['R-E-012', 'exploration', 'SGX-V2-E007', 'SGX-V2-E018', 'different'],
  ['R-E-013', 'exploration', 'SGX-SYN-E009', 'SGX-V2-E004', 'unknown'],
  ['R-V-001', 'validation', 'SGX-V2-H008', 'SGX-V2-H009', 'same'],
  ['R-V-002', 'validation', 'SGX-V2-H008', 'SGX-V2-H010', 'different'],
  ['R-V-003', 'validation', 'SGX-V2-H009', 'SGX-V2-H010', 'different'],
  ['R-V-004', 'validation', 'SGX-SYN-H001', 'SGX-V2-H008', 'different'],
  ['R-V-005', 'validation', 'SGX-SYN-H001', 'SGX-V2-H009', 'different'],
  ['R-V-006', 'validation', 'SGX-SYN-H001', 'SGX-V2-H010', 'different'],
  ['R-V-007', 'validation', 'SGX-SYN-H003', 'SGX-SYN-H001', 'unknown'],
  ['R-V-008', 'validation', 'SGX-SYN-H003', 'SGX-V2-H008', 'unknown'],
].map(([relationId, phase, leftBundleId, rightBundleId, truth]) => ({ relationId, phase, leftBundleId, rightBundleId, truth })));

const EXPECTED_TOTALS = Object.freeze({
  submissions: 20,
  evidence: 53,
  images: 30,
  userText: 12,
  finalAsr: 11,
  singleImage: 8,
  twoImage: 6,
  fiveImage: 2,
  textOnly: 2,
  asrOnly: 2,
  albumUpload: 14,
  familyTransfer: 6,
  relationSame: 7,
  relationDifferent: 11,
  relationUnknown: 3,
  providerExtractCalls: 30,
  providerRelateCalls: 21,
  providerCalls: 51,
  deterministicEvaluations: 4,
  evaluationUnits: 55,
});

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const ensure = (condition, code) => { if(!condition) throw new Error(code); };
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const pairKey = (left, right) => [left, right].sort().join('|');
const phasePartition = phase => phase === 'exploration' ? 'exploration' : 'holdout';
const idPart = value => value.replace(/[^A-Za-z0-9_-]/g, '_');
const isWithin = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

function parseChecksums(bytes) {
  const entries = new Map();
  for(const line of bytes.toString('utf8').split(/\r?\n/)) {
    if(!line) continue;
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    ensure(match, 'INVALID_CHECKSUM_MANIFEST');
    ensure(!entries.has(match[2]), 'DUPLICATE_CHECKSUM_PATH');
    entries.set(match[2], `sha256:${match[1]}`);
  }
  return entries;
}

export function assertAcceptedDatasetMetadata({ ready, accepted, checksumBytes, readyBytes }) {
  ensure(ready?.schemaVersion === 'sgx-ready-for-acceptance.1' && ready.specVersion === '2.0.0', 'DATASET_READY_VERSION_MISMATCH');
  ensure(ready.datasetRootDigest === EXPECTED_DATASET_DIGEST, 'DATASET_DIGEST_MISMATCH');
  ensure(ready.checksumManifest?.path === 'checksums/SHA256SUMS', 'CHECKSUM_MANIFEST_PATH_MISMATCH');
  ensure(sha(checksumBytes) === EXPECTED_DATASET_DIGEST, 'CHECKSUM_MANIFEST_DIGEST_MISMATCH');
  ensure(accepted?.schemaVersion === 'sgx-synthetic-v2-accepted.1', 'ACCEPTANCE_VERSION_MISMATCH');
  ensure(accepted.datasetRootDigest === EXPECTED_DATASET_DIGEST, 'ACCEPTANCE_DIGEST_MISMATCH');
  ensure(accepted.controlDigests?.checksums === EXPECTED_DATASET_DIGEST, 'ACCEPTANCE_CHECKSUM_BINDING_MISMATCH');
  ensure(accepted.controlDigests?.ready === sha(readyBytes), 'ACCEPTANCE_READY_BINDING_MISMATCH');
  ensure(accepted.validOnlyWhileDigestMatches === true, 'ACCEPTANCE_NOT_DIGEST_BOUND');
}

function summarize(submissions, relations) {
  const modalities = submissions.flatMap(item => item.bundles.flatMap(bundle => bundle.modalities.filter(type => ['photo', 'user_text', 'final_asr'].includes(type))));
  const imageCounts = submissions.map(item => item.bundles.filter(bundle => bundle.modalities.includes('photo')).length);
  const counts = type => modalities.filter(value => value === type).length;
  const only = type => submissions.filter(item => item.bundles.length === 1
    && item.bundles[0].modalities.includes(type)
    && !item.bundles[0].modalities.includes('photo')
    && !item.bundles[0].modalities.includes(type === 'user_text' ? 'final_asr' : 'user_text')).length;
  return {
    submissions: submissions.length,
    evidence: counts('photo') + counts('user_text') + counts('final_asr'),
    images: counts('photo'),
    userText: counts('user_text'),
    finalAsr: counts('final_asr'),
    singleImage: imageCounts.filter(value => value === 1).length,
    twoImage: imageCounts.filter(value => value === 2).length,
    fiveImage: imageCounts.filter(value => value === 5).length,
    textOnly: only('user_text'),
    asrOnly: only('final_asr'),
    albumUpload: submissions.filter(item => item.context === 'album_upload').length,
    familyTransfer: submissions.filter(item => item.context === 'family_transfer').length,
    relationSame: relations.filter(item => item.truth === 'same').length,
    relationDifferent: relations.filter(item => item.truth === 'different').length,
    relationUnknown: relations.filter(item => item.truth === 'unknown').length,
    providerExtractCalls: counts('photo'),
    providerRelateCalls: relations.length,
    providerCalls: counts('photo') + relations.length,
    deterministicEvaluations: submissions.filter(item => item.executionMode === 'deterministic').length,
    evaluationUnits: counts('photo') + relations.length + submissions.filter(item => item.executionMode === 'deterministic').length,
  };
}

export function assertFormalCounts(summary) {
  for(const [key, expected] of Object.entries(EXPECTED_TOTALS)) ensure(summary[key] === expected, `FORMAL_COUNT_MISMATCH_${key}_${summary[key]}_${expected}`);
}

async function loadAcceptedDataset(datasetRoot, acceptancePath) {
  const readyPath = path.join(datasetRoot, 'READY_FOR_ACCEPTANCE.json');
  const checksumPath = path.join(datasetRoot, 'checksums', 'SHA256SUMS');
  const [readyBytes, acceptedBytes, checksumBytes] = await Promise.all([readFile(readyPath), readFile(acceptancePath), readFile(checksumPath)]);
  const ready = JSON.parse(readyBytes);
  const accepted = JSON.parse(acceptedBytes);
  assertAcceptedDatasetMetadata({ ready, accepted, checksumBytes, readyBytes });
  const checksums = parseChecksums(checksumBytes);
  const readVerified = async relativePath => {
    ensure(typeof relativePath === 'string' && relativePath.length > 0 && !path.isAbsolute(relativePath), 'INVALID_DATASET_PATH');
    const normalized = relativePath.replaceAll('\\', '/');
    ensure(!normalized.split('/').includes('..'), 'DATASET_PATH_ESCAPE');
    const expected = checksums.get(normalized);
    ensure(expected, `FILE_NOT_SEALED_${normalized}`);
    const bytes = await readFile(path.join(datasetRoot, normalized));
    ensure(sha(bytes) === expected, `SEALED_FILE_HASH_MISMATCH_${normalized}`);
    return bytes;
  };
  const [datasetIndexBytes, transformsBytes] = await Promise.all([
    readVerified('manifests/dataset.jsonl'),
    readVerified('manifests/image-transforms.jsonl'),
  ]);
  const records = new Map(datasetIndexBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).map(record => [record.bundleId, record]));
  const transforms = new Map(transformsBytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).map(record => [record.bundleId, record]));
  return { ready, accepted, checksums, readVerified, records, transforms };
}

function evidencePath(record, sourcePath) {
  if(sourcePath.startsWith('base-v1/')) return sourcePath;
  return record.inputPath.startsWith('base-v1/') ? `base-v1/${sourcePath}` : sourcePath;
}

function pairTruth(truth, otherBundleId) {
  return truth?.eventStoryTruth?.pairTruth?.[otherBundleId];
}

function eventIdentity(truth) {
  return truth?.eventStoryTruth?.eventInstanceId ?? truth?.eventGroupId ?? null;
}

function validateRelationTruth(relation, left, right) {
  ensure(left.record.scopeId === right.record.scopeId, `RELATION_CROSS_SCOPE_${relation.relationId}`);
  ensure(left.phase === relation.phase && right.phase === relation.phase, `RELATION_CROSS_PHASE_${relation.relationId}`);
  const declarations = [pairTruth(left.truth, right.bundleId), pairTruth(right.truth, left.bundleId)].filter(Boolean);
  ensure(declarations.every(value => value === relation.truth), `RELATION_TRUTH_CONTRADICTION_${relation.relationId}`);
  if(relation.truth === 'same' && declarations.length === 0) ensure(eventIdentity(left.truth) && eventIdentity(left.truth) === eventIdentity(right.truth), `SAME_RELATION_UNSUPPORTED_${relation.relationId}`);
  if(relation.truth === 'different' && declarations.length === 0) ensure(eventIdentity(left.truth) && eventIdentity(right.truth) && eventIdentity(left.truth) !== eventIdentity(right.truth), `DIFFERENT_RELATION_UNSUPPORTED_${relation.relationId}`);
}

function buildStagePhoto(bundle, image) {
  const textEvidence = bundle.evidence.filter(item => ['user_text', 'final_asr'].includes(item.type)).map(item => ({
    evidenceId: item.sourceRef,
    revision: 1,
    sourceHash: item.hash,
    source: item.type,
    text: item.text,
  }));
  return {
    photoId: bundle.bundleId,
    scope: { householdId: bundle.record.scopeId, subjectId: 'formal-v2-runtime-fixture' },
    revision: Number.isInteger(bundle.input.revision) && bundle.input.revision > 0 ? bundle.input.revision : 1,
    sourceRef: image.sourceRef,
    sourceHash: image.hash,
    mimeType: 'image/jpeg',
    caption: '',
    ...(textEvidence.length ? { textEvidence } : {}),
    active: true,
  };
}

function buildRunnerRequest(taskId, photos, deadlineAt, caps) {
  return {
    contractVersion: 'classification-stage-a.1',
    runId: `formal_v2_${idPart(taskId).toLowerCase()}`,
    scope: photos[0].scope,
    authorizationRevision: 'formal-v2-campaign-r1',
    trigger: 'upload',
    photos,
    references: [],
    corrections: [],
    budget: {
      maxRequests: caps.maxRequests,
      maxInputTokens: caps.maxInputTokens,
      maxOutputTokens: caps.maxOutputTokens,
      maxCostCny: caps.maxCostCny,
      deadlineAt,
      candidatesPerPhoto: 1,
      maxOutputPerRequest: 4096,
      stageOutputTokens: { extract: 4096, relate: 1024 },
      maxCallDurationMs: 60_000,
    },
  };
}

const label = value => ({ value, aliases: [] });
const knownFacet = value => ({ people: 'person' })[value] ?? value;
function truthValues(value) {
  if(Array.isArray(value)) return value;
  if(value && typeof value === 'object' && value.value != null) return [value];
  return [];
}
function buildRunnerTruthPhoto(bundle, photo, personEntry) {
  const story = bundle.truth.eventStoryTruth ?? {};
  const event = typeof story.event === 'string' && story.event !== 'unknown' ? [label(story.event)] : [];
  const scenes = Array.isArray(story.scene) ? story.scene.map(label) : [];
  const times = truthValues(story.time)
    .filter(item => item.value != null && item.precision && item.role)
    .map(item => label(`${item.role}:${item.precision}:${item.value}`));
  const places = truthValues(story.place).map(item => typeof item === 'string' ? item : item.value).filter(Boolean).map(label);
  const expectedUnknownFacets = [...new Set((story.unknownFacets ?? []).map(knownFacet).filter(item => ['person', 'time', 'place', 'event', 'scene'].includes(item)))];
  const expectedConflicts = [...new Set((story.conflicts ?? []).map(knownFacet).filter(item => ['person', 'time', 'place', 'event', 'scene'].includes(item)))];
  const rawEventInstance = eventIdentity(bundle.truth);
  return {
    photoId: bundle.bundleId,
    sourceHash: photo.sourceHash,
    facets: { time: times, place: places, event, scene: scenes },
    faces: personEntry?.faces ?? [],
    eventInstance: rawEventInstance ? idPart(rawEventInstance).slice(0, 128) : null,
    expectedUnknownFacets,
    expectedConflicts,
  };
}

function buildDeterministicSemanticTruth(bundle) {
  const story = bundle.truth.eventStoryTruth ?? {};
  const candidate = { person: [], time: [], place: [], event: [], scene: [] };
  const conflicted = { person: [], time: [], place: [], event: [], scene: [] };
  if(typeof story.event === 'string' && story.event !== 'unknown') candidate.event.push(story.event);
  for(const value of Array.isArray(story.scene) ? story.scene : []) candidate.scene.push(value);
  for(const value of truthValues(story.place)) {
    const normalized = typeof value === 'string' ? value : value.value;
    if(normalized) candidate.place.push(normalized);
  }
  for(const value of truthValues(story.time)) {
    if(value?.value == null) continue;
    const target = String(value.source ?? '').includes('retracted') ? conflicted.time : candidate.time;
    target.push(String(value.value));
  }
  let unknownFacets = [...new Set((story.unknownFacets ?? []).map(knownFacet))];
  let formalAdjudication = { basis: 'accepted_dataset_truth', reason: null };
  if(bundle.bundleId === 'SGX-V2-T003') {
    candidate.person.push('同事');
    candidate.event.push('欢送会');
    unknownFacets = unknownFacets.filter(facet => !['person', 'event'].includes(facet));
    formalAdjudication = {
      basis: 'explicit_text_semantics_overlay',
      reason: 'The text explicitly states a colleague farewell while negating only the user retirement interpretation; the accepted fixture unknown person/event fields describe identity uncertainty and must not erase the explicit role or event.',
    };
  }
  return {
    candidate,
    conflicted,
    unknownFacets,
    conflictFacets: [...new Set((story.conflicts ?? []).map(knownFacet))],
    forbiddenValues: bundle.bundleId === 'SGX-V2-T003' ? { event: ['退休'] } : {},
    formalAdjudication,
  };
}

function phaseRunnerCaps(phase) {
  return phase === 'exploration'
    ? { maxRequests: 31, maxInputTokens: 5_000_000, maxOutputTokens: 87_040, maxCostCny: 15, maxDurationSeconds: 1800, maxRetries: 0 }
    : { maxRequests: 20, maxInputTokens: 4_000_000, maxOutputTokens: 57_344, maxCostCny: 10, maxDurationSeconds: 1800, maxRetries: 0 };
}

function validatePersonOverlay(raw, bundles) {
  if(raw === undefined || raw === null) return undefined;
  ensure(raw?.version === 'sgx-formal-v2-person-overlay.1', 'PERSON_OVERLAY_VERSION_MISMATCH');
  ensure(raw.datasetRootDigest === EXPECTED_DATASET_DIGEST, 'PERSON_OVERLAY_DATASET_MISMATCH');
  ensure(Array.isArray(raw.entries), 'PERSON_OVERLAY_ENTRIES_REQUIRED');
  ensure(!/(?:displayName|relativeName|kinship|relationship|storyMemory|longTermMemory|name)/i.test(JSON.stringify(raw)), 'PERSON_OVERLAY_PII_FIELD');
  const entries = new Map();
  const faceIds = new Set();
  for(const entry of raw.entries) {
    ensure(PERSON_TRUTH_PHOTO_IDS.includes(entry?.photoId), `PERSON_OVERLAY_UNAPPROVED_PHOTO_${entry?.photoId}`);
    ensure(!entries.has(entry.photoId), `PERSON_OVERLAY_DUPLICATE_PHOTO_${entry.photoId}`);
    const bundle = bundles.get(entry.photoId);
    ensure(bundle?.image && entry.sourceHash === bundle.image.hash, `PERSON_OVERLAY_SOURCE_MISMATCH_${entry.photoId}`);
    ensure(Array.isArray(entry.faces) && entry.faces.length > 0, `PERSON_OVERLAY_FACES_REQUIRED_${entry.photoId}`);
    const faces = entry.faces.map(face => {
      ensure(typeof face?.faceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(face.faceId), `PERSON_OVERLAY_FACE_ID_${entry.photoId}`);
      ensure(typeof face?.personId === 'string' && /^anon-[A-Za-z0-9._:-]{1,122}$/.test(face.personId), `PERSON_OVERLAY_PERSON_ID_${entry.photoId}`);
      ensure(!faceIds.has(face.faceId), `PERSON_OVERLAY_DUPLICATE_FACE_${face.faceId}`);
      faceIds.add(face.faceId);
      const box = face.box;
      ensure(box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])), `PERSON_OVERLAY_BOX_${face.faceId}`);
      ensure(box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1, `PERSON_OVERLAY_BOX_${face.faceId}`);
      return { faceId: face.faceId, personId: face.personId, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
    });
    entries.set(entry.photoId, { photoId: entry.photoId, sourceHash: entry.sourceHash, faces });
  }
  ensure(PERSON_TRUTH_PHOTO_IDS.every(photoId => entries.has(photoId)), 'PERSON_OVERLAY_REQUIRED_PHOTOS_MISSING');
  ensure(entries.get('SGX-V2-E016').faces.length === 1 && entries.get('SGX-V2-E017').faces.length === 1 && entries.get('SGX-V2-E018').faces.length === 1, 'PERSON_OVERLAY_EXPLORATION_FACE_COUNT');
  ensure(entries.get('SGX-V2-H008').faces.length === 2 && entries.get('SGX-V2-H009').faces.length === 2 && entries.get('SGX-V2-H010').faces.length === 2, 'PERSON_OVERLAY_VALIDATION_FACE_COUNT');
  const eIds = PERSON_TRUTH_PHOTO_IDS.slice(0, 3).map(photoId => entries.get(photoId).faces[0].personId);
  ensure(new Set(eIds).size === 1, 'PERSON_OVERLAY_EXPLORATION_IDENTITY_MISMATCH');
  const h008 = entries.get('SGX-V2-H008').faces.map(face => face.personId);
  const h009 = entries.get('SGX-V2-H009').faces.map(face => face.personId);
  const h010 = new Set(entries.get('SGX-V2-H010').faces.map(face => face.personId));
  ensure(h008.length === h009.length && h008.every(personId => h009.includes(personId)), 'PERSON_OVERLAY_VALIDATION_SAME_MISMATCH');
  ensure([...h010].every(personId => !h008.includes(personId)), 'PERSON_OVERLAY_VALIDATION_DIFFERENT_MISMATCH');
  return {
    version: raw.version,
    datasetRootDigest: raw.datasetRootDigest,
    generatedAt: raw.generatedAt,
    reviewedBy: raw.reviewedBy,
    detector: raw.detector,
    entries: [...entries.values()],
    claimBoundary: raw.claimBoundary ?? 'anonymous_synthetic_person_truth_only',
  };
}

export async function prepareFormalV2Campaign({
  dataset,
  acceptance,
  out,
  personOverlay,
  campaignId = FORMAL_CAMPAIGN_ID,
  providerUseReviewRef = FORMAL_PROVIDER_REVIEW_REF,
  sourceRevision,
  now = new Date(),
  allowEphemeralOutputForTest = false,
}) {
  const datasetRoot = path.resolve(dataset);
  const acceptancePath = path.resolve(acceptance);
  const outRoot = path.resolve(out);
  ensure(now instanceof Date && Number.isFinite(now.getTime()), 'INVALID_NOW');
  ensure(/^sgx_formal_v2_[A-Za-z0-9_-]{1,96}$/.test(campaignId), 'INVALID_CAMPAIGN_ID');
  ensure(typeof providerUseReviewRef === 'string' && providerUseReviewRef.length > 0, 'PROVIDER_REVIEW_REF_REQUIRED');
  ensure(sourceRevision?.version === 'sgx-formal-source-revision.1'
    && /^[a-f0-9]{40}$/.test(sourceRevision.gitCommit)
    && sourceRevision.trackedTreeClean === true
    && sourceRevision.generatorVersion === 'sgx-formal-v2-generator.1', 'SOURCE_REVISION_REQUIRED');
  ensure(!isWithin(datasetRoot, outRoot), 'OUTPUT_INSIDE_ACCEPTED_DATASET');
  if(!allowEphemeralOutputForTest) {
    const temporaryRoots = [...new Set([tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].map(value => path.resolve(value)))];
    ensure(!temporaryRoots.some(root => isWithin(root, outRoot)), 'PERSISTENT_OUTPUT_REQUIRED');
  }
  try { await stat(outRoot); throw new Error('OUTPUT_EXISTS'); }
  catch(error) { if(error?.code !== 'ENOENT') throw error; }

  const loaded = await loadAcceptedDataset(datasetRoot, acceptancePath);
  const wanted = [...new Set(FORMAL_SUBMISSIONS.flatMap(item => item.bundleIds))];
  ensure(wanted.length === 34, 'BUNDLE_MATRIX_DUPLICATE');
  const bundles = new Map();
  for(const bundleId of wanted) {
    const record = loaded.records.get(bundleId);
    ensure(record, `BUNDLE_NOT_FOUND_${bundleId}`);
    const [inputBytes, truthBytes] = await Promise.all([loaded.readVerified(record.inputPath), loaded.readVerified(record.truthPath)]);
    const input = JSON.parse(inputBytes);
    const truth = JSON.parse(truthBytes);
    ensure(input.bundleId === bundleId && truth.bundleId === bundleId && input.scopeId === record.scopeId && truth.scopeId === record.scopeId, `BUNDLE_IDENTITY_MISMATCH_${bundleId}`);
    ensure(JSON.stringify([...input.modalities].sort()) === JSON.stringify([...record.modalities].sort()), `BUNDLE_MODALITIES_MISMATCH_${bundleId}`);
    const evidence = [];
    for(const source of input.evidence.filter(item => item.status === 'active' && ['user_text', 'final_asr'].includes(item.type))) {
      const relativePath = evidencePath(record, source.path);
      const bytes = await loaded.readVerified(relativePath);
      ensure(sha(bytes) === `sha256:${source.sha256}` && bytes.length === source.bytes, `EVIDENCE_HASH_MISMATCH_${bundleId}_${source.type}`);
      const expectedText = source.type === 'user_text' ? input.user_original_text : input.final_asr_transcript;
      ensure(typeof expectedText === 'string' && expectedText.trim().length > 0 && bytes.toString('utf8').trim() === expectedText.trim(), `EVIDENCE_TEXT_MISMATCH_${bundleId}_${source.type}`);
      evidence.push({ type: source.type, sourceRef: source.sourceRef, sourcePath: relativePath, hash: sha(bytes), text: expectedText });
    }
    let image = null;
    if(record.modalities.includes('photo')) {
      const transform = loaded.transforms.get(bundleId);
      ensure(transform?.derived?.path, `IMAGE_TRANSFORM_MISSING_${bundleId}`);
      const bytes = await loaded.readVerified(transform.derived.path);
      ensure(sha(bytes) === `sha256:${transform.derived.sha256}` && bytes.length === transform.derived.bytes && bytes.length <= 1024 * 1024, `DERIVED_IMAGE_INVALID_${bundleId}`);
      const source = input.evidence.find(item => item.status === 'active' && item.type === 'photo');
      ensure(source?.sourceRef, `PHOTO_SOURCE_MISSING_${bundleId}`);
      image = { sourceRef: source.sourceRef, sourcePath: transform.derived.path, hash: sha(bytes), bytes };
    }
    bundles.set(bundleId, { bundleId, record, input, truth, evidence, image, inputHash: sha(inputBytes), truthHash: sha(truthBytes) });
  }

  const submissions = FORMAL_SUBMISSIONS.map(spec => {
    const selected = spec.bundleIds.map(bundleId => bundles.get(bundleId));
    const imageCount = selected.filter(bundle => bundle.image).length;
    ensure(selected.every(bundle => spec.phase === 'exploration'
      ? ['exploration', 'content_organization'].includes(bundle.record.split)
      : bundle.record.split === 'holdout'), `SUBMISSION_PARTITION_MISMATCH_${spec.submissionId}`);
    ensure(new Set(selected.map(bundle => bundle.record.scopeId)).size === 1, `SUBMISSION_CROSS_SCOPE_${spec.submissionId}`);
    const executionMode = imageCount === 0 ? 'deterministic' : 'provider';
    if(executionMode === 'deterministic') ensure(selected.length === 1 && (selected[0].record.modalities.includes('user_text') !== selected[0].record.modalities.includes('final_asr')), `INVALID_DETERMINISTIC_SUBMISSION_${spec.submissionId}`);
    return {
      ...spec,
      partition: phasePartition(spec.phase),
      executionMode,
      imageShape: imageCount === 0 ? (selected[0].record.modalities.includes('user_text') ? 'text_only' : 'asr_only') : `${imageCount}_image`,
      bundles: selected.map(bundle => ({
        bundleId: bundle.bundleId,
        sourceSet: bundle.record.sourceSet,
        sourceSplit: bundle.record.split,
        scopeId: bundle.record.scopeId,
        modalities: bundle.record.modalities,
        inputPath: bundle.record.inputPath,
        inputHash: bundle.inputHash,
        truthPath: bundle.record.truthPath,
        truthHash: bundle.truthHash,
        evidence: [
          ...(bundle.image ? [{ type: 'photo', sourceRef: bundle.image.sourceRef, sourcePath: bundle.image.sourcePath, outputPath: `images/${bundle.bundleId}.jpg`, hash: bundle.image.hash }] : []),
          ...bundle.evidence.map(item => ({ type: item.type, sourceRef: item.sourceRef, sourcePath: item.sourcePath, hash: item.hash })),
        ],
      })),
    };
  });

  const bundlePhase = new Map(submissions.flatMap(item => item.bundleIds.map(bundleId => [bundleId, item.phase])));
  const relationKeys = new Set();
  const relations = RELATION_ALLOWLIST.map(relation => {
    const left = bundles.get(relation.leftBundleId);
    const right = bundles.get(relation.rightBundleId);
    ensure(left?.image && right?.image, `RELATION_IMAGE_MISSING_${relation.relationId}`);
    left.phase = bundlePhase.get(left.bundleId);
    right.phase = bundlePhase.get(right.bundleId);
    const key = pairKey(left.bundleId, right.bundleId);
    ensure(!relationKeys.has(key), `DUPLICATE_RELATION_PAIR_${relation.relationId}`);
    relationKeys.add(key);
    validateRelationTruth(relation, left, right);
    return {
      ...relation,
      kind: 'event',
      scopeId: left.record.scopeId,
      selectionMode: 'explicit_allowlist_only',
      truthBasis: relation.truth === 'unknown' ? 'independent_pair_review' : (pairTruth(left.truth, right.bundleId) || pairTruth(right.truth, left.bundleId) ? 'dataset_pair_truth' : 'independent_pair_review_with_event_identity'),
    };
  });

  const summary = summarize(submissions, relations);
  assertFormalCounts(summary);
  const validatedPersonOverlay = validatePersonOverlay(personOverlay, bundles);
  const personEntries = new Map((validatedPersonOverlay?.entries ?? []).map(entry => [entry.photoId, entry]));
  const personOverlayReady = Boolean(validatedPersonOverlay);
  const phases = {};
  for(const phase of ['exploration', 'validation']) {
    const phaseSubmissions = submissions.filter(item => item.phase === phase);
    const phaseRelations = relations.filter(item => item.phase === phase);
    const phaseSummary = summarize(phaseSubmissions, phaseRelations);
    phases[phase] = {
      version: 'sgx-formal-v2-phase-plan.1',
      campaignId,
      phase,
      partition: phasePartition(phase),
      status: !personOverlayReady ? 'blocked_pending_person_overlay' : (phase === 'exploration' ? 'frozen_pending_bound_approval' : 'sealed_until_exploration_freeze'),
      datasetRootDigest: EXPECTED_DATASET_DIGEST,
      relationSelection: { mode: 'explicit_allowlist_only', allPairsExpansion: false },
      submissions: phaseSubmissions,
      relationAllowlist: phaseRelations,
      planned: phaseSummary,
      freezePolicy: phase === 'exploration'
        ? { afterRun: ['provider_outputs', 'deterministic_outputs', 'promptVersion', 'guardVersion', 'adapterVersion', 'truth', 'matrix'], validationMayOpenAfter: ['exploration_report_frozen', 'versions_frozen', 'campaign_ledger_committed'] }
        : { opensOnlyAfter: ['exploration_report_frozen', 'versions_frozen', 'campaign_ledger_committed'], afterOpen: ['truth', 'promptVersion', 'guardVersion', 'adapterVersion', 'taxonomy', 'matrix'], failureDisposition: 'record_for_next_version_do_not_patch_in_place' },
    };
  }
  ensure(phases.exploration.planned.submissions === 12 && phases.exploration.planned.images === 18 && phases.exploration.planned.providerCalls === 31 && phases.exploration.planned.deterministicEvaluations === 4, 'EXPLORATION_PLAN_MISMATCH');
  ensure(phases.validation.planned.submissions === 8 && phases.validation.planned.images === 12 && phases.validation.planned.providerCalls === 20 && phases.validation.planned.deterministicEvaluations === 0, 'VALIDATION_PLAN_MISMATCH');

  const generatedAt = now.toISOString();
  const deadlineAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
  const runner = {};
  for(const phase of ['exploration', 'validation']) {
    const phaseBundles = [...new Set(submissions.filter(item => item.phase === phase).flatMap(item => item.bundleIds))]
      .map(bundleId => bundles.get(bundleId)).filter(bundle => bundle.image);
    const photos = phaseBundles.map(bundle => buildStagePhoto(bundle, bundle.image));
    const stagePhotoById = new Map(photos.map(photo => [photo.photoId, photo]));
    const caps = phaseRunnerCaps(phase);
    const scopeIds = [...new Set(phaseBundles.map(bundle => bundle.record.scopeId))].sort();
    const tasks = scopeIds.map(scopeId => {
      const taskPhotos = phaseBundles.filter(bundle => bundle.record.scopeId === scopeId).map(bundle => stagePhotoById.get(bundle.bundleId));
      const taskRelations = relations.filter(item => item.phase === phase && item.scopeId === scopeId);
      const taskId = `${phase}_${idPart(scopeId)}`;
      return {
        taskId,
        request: buildRunnerRequest(taskId, taskPhotos, deadlineAt, caps),
        evaluatePhotoIds: taskPhotos.map(photo => photo.photoId),
        expectedUnchangedPhotoIds: [],
        relationPairs: taskRelations.map(item => [item.leftBundleId, item.rightBundleId]),
        evaluation: {
          facets: taskPhotos.some(photo => personEntries.has(photo.photoId)) ? ['person', 'time', 'place', 'event', 'scene'] : ['time', 'place', 'event', 'scene'],
          personPairs: taskRelations.some(item => personEntries.has(item.leftBundleId) && personEntries.has(item.rightBundleId)),
          eventPairs: true,
          identityCandidates: false,
        },
      };
    });
    const truth = {
      version: 'sgx-truth.1',
      reviewedBy: `accepted-dataset:${EXPECTED_DATASET_DIGEST}`,
      photos: phaseBundles.map(bundle => buildRunnerTruthPhoto(bundle, stagePhotoById.get(bundle.bundleId), personEntries.get(bundle.bundleId))),
      taskOverrides: [],
    };
    const truthBytes = jsonBytes(truth);
    const manifest = {
      version: 'sgx-eval.1',
      batchId: `sgx_formal_v2_${phase}_${campaignId.replace(/^sgx_formal_v2_/, '')}`,
      status: personOverlayReady ? 'ready' : 'draft',
      partition: phasePartition(phase),
      provider: 'qwen',
      model: FORMAL_MODEL,
      datasetRootDigest: EXPECTED_DATASET_DIGEST,
      providerUseReviewRef,
      sourceRevision,
      prices: {
        inputCnyPerMillion: 1.2,
        outputCnyPerMillion: 4.8,
        source: 'https://help.aliyun.com/zh/model-studio/model-pricing',
        checkedAt: generatedAt,
      },
      caps,
      truth: { path: `../truth/${phase}.json`, sha256: sha(truthBytes) },
      photos: phaseBundles.map(bundle => {
        const photo = stagePhotoById.get(bundle.bundleId);
        const rawLeakageGroup = bundle.truth.eventStoryTruth?.leakageGroup ?? bundle.truth.eventGroupId ?? bundle.bundleId;
        return {
          photo,
          path: `../images/${bundle.bundleId}.jpg`,
          split: phasePartition(phase),
          leakageGroup: idPart(rawLeakageGroup).slice(0, 128),
          externalConsentRef: bundle.input.consentRef ?? `accepted-synthetic:${EXPECTED_DATASET_DIGEST}`,
          personConsentRef: `person-consent:${campaignId}:${phase}:${bundle.bundleId}`,
        };
      }),
      tasks,
    };
    runner[phase] = { manifest, manifestBytes: jsonBytes(manifest), truth, truthBytes };
  }
  ensure(runner.exploration.manifest.tasks.reduce((count, task) => count + task.request.photos.length + task.relationPairs.length, 0) === 31, 'EXPLORATION_RUNNER_CALL_PLAN_MISMATCH');
  ensure(runner.validation.manifest.tasks.reduce((count, task) => count + task.request.photos.length + task.relationPairs.length, 0) === 20, 'VALIDATION_RUNNER_CALL_PLAN_MISMATCH');
  ensure(runner.exploration.manifest.caps.maxCostCny + runner.validation.manifest.caps.maxCostCny === CAMPAIGN_CAPS.maxCostCny, 'PHASE_COST_RESERVATION_MISMATCH');

  const deterministicPlan = {
    version: 'sgx-formal-v2-deterministic-plan.2',
    campaignId,
    status: 'ready_offline',
    providerCalls: 0,
    tasks: submissions.filter(item => item.executionMode === 'deterministic').map(item => {
      const bundle = bundles.get(item.bundleIds[0]);
      return {
        taskId: `deterministic_${item.submissionId.toLowerCase()}`,
        submissionId: item.submissionId,
        phase: item.phase,
        context: item.context,
        bundleId: bundle.bundleId,
        scope: { householdId: bundle.record.scopeId, subjectId: bundle.input.subjectId },
        inputMode: item.imageShape,
        providerCalls: 0,
        fixture: {
          contentOrganizationFixture: bundle.input.contentOrganizationFixture,
          stageAEligibility: bundle.input.stageAEligibility,
          evidence: bundle.evidence.map(evidence => ({
            type: evidence.type,
            sourceRef: evidence.sourceRef,
            sourcePath: evidence.sourcePath,
            sourceHash: evidence.hash,
            textHash: sha(Buffer.from(evidence.text, 'utf8')),
            text: evidence.text,
          })),
        },
        assertions: [
          'exactly_one_active_user_text_or_final_asr',
          'source_hash_and_text_preserved',
          'content_organization_fixture_true',
          'stage_a_provider_not_called',
        ],
        expected: {
          resultStatus: bundle.truth.expected?.resultStatus,
          workflowStatus: bundle.truth.expected?.workflowStatus,
          boundaryTags: bundle.truth.boundaryTags ?? [],
          semantic: buildDeterministicSemanticTruth(bundle),
        },
      };
    }),
  };
  ensure(deterministicPlan.tasks.length === 4 && deterministicPlan.tasks.every(task => task.fixture.contentOrganizationFixture === true && task.fixture.stageAEligibility === false && task.fixture.evidence.length === 1), 'DETERMINISTIC_PLAN_INVALID');
  const schemaGap = {
    version: 'sgx-formal-v2-runner-schema-gap.1',
    status: 'provider_manifests_executable',
    currentRunner: 'sgx-eval.1',
    minimalGaps: [
      { code: 'ZERO_IMAGE_DETERMINISTIC_TASK_UNSUPPORTED', currentBehavior: 'sgx-eval.1 requires photos and evaluatePhotoIds to be non-empty', requiredField: 'executionMode=deterministic with user_text or final_asr evidence' },
      { code: 'TERNARY_RELATION_TRUTH_UNSUPPORTED_BY_BUILTIN_SCORE', currentBehavior: 'sgx-truth.1 eventInstance scoring is binary same/different', requiredField: 'score the 3 unknown pairs against phase relationAllowlist truth; raw provider execution remains supported' },
    ],
    supportedNow: ['task.relationPairs is passed as exclusive relationPairAllowlist', '31-call exploration provider manifest', '20-call validation provider manifest'],
    safetyRule: 'Execute only manifest task.relationPairs; never replace them with retrievalHints or all-pairs expansion. Keep deterministic tasks outside the provider runner.',
  };
  const personOverlayArtifact = validatedPersonOverlay ?? {
    version: 'sgx-formal-v2-person-overlay.1',
    datasetRootDigest: EXPECTED_DATASET_DIGEST,
    status: 'pending_detector_materialization',
    persistence: 'required_under_campaign_root',
    prohibitedFields: ['name', 'relationship', 'memory'],
    requiredPhotoIds: PERSON_TRUTH_PHOTO_IDS,
    entries: [],
    claimBoundary: 'anonymous_synthetic_person_truth_only',
  };

  const phaseBytes = Object.fromEntries(Object.entries(phases).map(([key, value]) => [key, jsonBytes(value)]));
  const deterministicBytes = jsonBytes(deterministicPlan);
  const gapBytes = jsonBytes(schemaGap);
  const overlayBytes = jsonBytes(personOverlayArtifact);
  const campaign = {
    version: 'sgx-formal-v2-campaign.1',
    campaignId,
    generatedAt,
    sourceRevision,
    status: personOverlayReady ? 'prepared_offline_pending_bound_approval' : 'blocked_pending_person_overlay',
    dataset: {
      datasetId: loaded.ready.datasetId,
      releaseId: loaded.ready.releaseId,
      specVersion: loaded.ready.specVersion,
      datasetRootDigest: EXPECTED_DATASET_DIGEST,
      acceptanceSchemaVersion: loaded.accepted.schemaVersion,
      acceptanceRunId: loaded.accepted.runId,
      validOnlyWhileDigestMatches: true,
    },
    provider: { provider: 'qwen', model: FORMAL_MODEL, callsPlanned: 51, automaticRetries: 0, allowPersonMatching: true },
    pricingProvenance: {
      source: 'https://help.aliyun.com/zh/model-studio/model-pricing',
      inputCnyPerMillion: 1.2,
      outputCnyPerMillion: 4.8,
      inheritedFromRepositoryFixture: 'harness/classification/prepare-v2-product-functional-eval.mjs',
      externalRecheckPerformedByGenerator: false,
      executionRequirement: 'bind approval only while the manifest pricing timestamp remains current and the inherited rate is independently reviewed',
    },
    caps: CAMPAIGN_CAPS,
    totals: summary,
    accounting: { providerCalls: { extract: 30, relate: 21, total: 51 }, deterministicEvaluations: 4, totalEvaluationUnits: 55, deterministicDoesNotConsumeProviderAllowance: true },
    phases: {
      exploration: { path: 'phases/exploration.json', hash: sha(phaseBytes.exploration), status: phases.exploration.status, providerManifestPath: 'manifests/exploration.json', providerManifestHash: sha(runner.exploration.manifestBytes), providerCalls: 31, reservedMaxCostCny: 15 },
      validation: { path: 'phases/validation.json', hash: sha(phaseBytes.validation), status: phases.validation.status, providerManifestPath: 'manifests/validation.json', providerManifestHash: sha(runner.validation.manifestBytes), providerCalls: 20, reservedMaxCostCny: 10 },
    },
    relationSelection: { mode: 'explicit_allowlist_only', relationCount: 21, allPairsExpansion: false },
    providerRunner: { version: 'sgx-eval.1', executableWithCurrentRunner: personOverlayReady, requiresBoundApprovalAndPointer: true },
    deterministicPlan: { path: 'deterministic-plan.json', hash: sha(deterministicBytes), executableOffline: true, providerCalls: 0 },
    runnerSchemaGap: { path: 'RUNNER_SCHEMA_GAP.json', hash: sha(gapBytes) },
    personOverlay: { path: 'fixtures/person-overlay.json', hash: sha(overlayBytes), ready: personOverlayReady, persistence: 'required_under_campaign_root' },
    stopConditions: {
      global: ['authorization_changed_or_expired', 'campaign_budget_or_request_cap_reached', 'model_or_version_mismatch', 'scope_isolation_failure', 'campaign_ledger_uncertain'],
      caseLocal: ['schema_or_guard_failure', 'invalid_output', 'provider_case_error'],
      retryPolicy: 'zero_automatic_retries',
    },
    claimBoundary: 'Synthetic accepted fixtures only; this plan and any later result do not prove real-family accuracy, identity reliability, product readiness, SLA, or user benefit.',
  };
  const campaignBytes = jsonBytes(campaign);
  const authorizationRequest = {
    version: 'sgx-formal-v2-authorization-request.1',
    campaignId: campaign.campaignId,
    campaignHash: sha(campaignBytes),
    datasetRootDigest: EXPECTED_DATASET_DIGEST,
    provider: 'qwen',
    model: FORMAL_MODEL,
    planned: summary,
    caps: CAMPAIGN_CAPS,
    allowPersonMatching: true,
    providerUseReviewRef,
    sourceRevision,
    personOverlayHash: sha(overlayBytes),
    phases: {
      exploration: { batchId: runner.exploration.manifest.batchId, manifestPath: 'manifests/exploration.json', manifestHash: sha(runner.exploration.manifestBytes), caps: runner.exploration.manifest.caps },
      validation: { batchId: runner.validation.manifest.batchId, manifestPath: 'manifests/validation.json', manifestHash: sha(runner.validation.manifestBytes), caps: runner.validation.manifest.caps },
    },
    requestedExpiresAt: deadlineAt,
    requiresBoundApprovalBeforeExternalCalls: true,
    externalCallsMadeByGenerator: 0,
    credentialsReadByGenerator: false,
  };

  const parent = path.dirname(outRoot);
  await mkdir(parent, { recursive: true });
  const tempRoot = path.join(parent, `.${path.basename(outRoot)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(path.join(tempRoot, 'images'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(tempRoot, 'phases'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(tempRoot, 'fixtures'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(tempRoot, 'manifests'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(tempRoot, 'truth'), { recursive: true, mode: 0o700 });
    for(const bundle of bundles.values()) if(bundle.image) await copyFile(path.join(datasetRoot, bundle.image.sourcePath), path.join(tempRoot, 'images', `${bundle.bundleId}.jpg`));
    const outputs = new Map([
      ['phases/exploration.json', phaseBytes.exploration],
      ['phases/validation.json', phaseBytes.validation],
      ['manifests/exploration.json', runner.exploration.manifestBytes],
      ['manifests/validation.json', runner.validation.manifestBytes],
      ['truth/exploration.json', runner.exploration.truthBytes],
      ['truth/validation.json', runner.validation.truthBytes],
      ['deterministic-plan.json', deterministicBytes],
      ['RUNNER_SCHEMA_GAP.json', gapBytes],
      ['fixtures/person-overlay.json', overlayBytes],
      ['campaign.json', campaignBytes],
      ['AUTHORIZATION_REQUEST.json', jsonBytes(authorizationRequest)],
    ]);
    for(const [relativePath, bytes] of outputs) await writeFile(path.join(tempRoot, relativePath), bytes, { mode: 0o600, flag: 'wx' });
    const generatedFiles = [];
    for(const [relativePath, bytes] of outputs) generatedFiles.push({ path: relativePath, sha256: sha(bytes) });
    for(const bundle of bundles.values()) if(bundle.image) generatedFiles.push({ path: `images/${bundle.bundleId}.jpg`, sha256: bundle.image.hash });
    generatedFiles.sort((a, b) => a.path.localeCompare(b.path));
    await writeFile(path.join(tempRoot, 'MANIFEST.sha256.json'), jsonBytes({ version: 'sgx-formal-v2-generated-files.1', campaignHash: sha(campaignBytes), files: generatedFiles }), { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(tempRoot, 'README.md'), [
      '# SGX formal v2 campaign',
      '',
      `- Accepted dataset: ${EXPECTED_DATASET_DIGEST}`,
      '- Frozen denominator: 20 product submissions, 53 evidence items, 51 provider calls, and 4 deterministic evaluations.',
      '- Relation scheduling is an explicit 21-pair allowlist. All-pairs expansion is forbidden.',
      '- Exploration is 31 provider calls plus 4 deterministic evaluations. Validation remains sealed until exploration artifacts and versions are frozen.',
      '- `manifests/exploration.json` and `manifests/validation.json` are executable `sgx-eval.1` provider manifests after exact approval/pointer binding.',
      '- The 4 zero-image cases are isolated in `deterministic-plan.json`; they make no provider calls.',
      '- Built-in relation scoring is binary, so the 3 frozen `unknown` pairs must be scored from the phase allowlist ledger.',
      personOverlayReady
        ? '- Person matching is enabled with a frozen anonymous detector overlay. No name or relationship is present.'
        : '- Provider execution is blocked until the anonymous detector overlay is materialized and the campaign is regenerated.',
      '- This generator reads no credentials and makes no external calls.',
      '',
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    await rename(tempRoot, outRoot);
  } catch(error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  return { out: outRoot, campaignHash: sha(campaignBytes), datasetRootDigest: EXPECTED_DATASET_DIGEST, summary, runnerExecutable: personOverlayReady, personOverlayReady, credentialsRead: false, externalCalls: 0 };
}

function parseArgs(argv) {
  const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  return {
    dataset: option('--dataset'),
    acceptance: option('--acceptance'),
    out: option('--out'),
    personOverlay: option('--person-overlay'),
    campaignId: option('--campaign-id'),
    providerUseReviewRef: option('--provider-review-ref'),
    now: option('--now'),
    help: argv.includes('--help'),
  };
}

export function readCurrentSourceRevision() {
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const trackedStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  ensure(!trackedStatus, 'TRACKED_WORKTREE_DIRTY');
  return {
    version: 'sgx-formal-source-revision.1',
    gitCommit,
    trackedTreeClean: true,
    generatorVersion: 'sgx-formal-v2-generator.1',
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if(args.help || !args.dataset || !args.acceptance || !args.out || !args.campaignId || !args.providerUseReviewRef) {
    console.log([
      '准备 SGX formal v2 campaign（只读验收数据、不读凭据、不联网）：',
      'node harness/classification/prepare-formal-v2-campaign.mjs \\',
      '  --dataset /absolute/accepted-dataset-root \\',
      '  --acceptance /absolute/ACCEPTED.json \\',
      '  --out /absolute/new-output-dir \\',
      '  --campaign-id sgx_formal_v2_YYYYMMDD_rN \\',
      '  --provider-review-ref chat_authorization_reference \\',
      '  [--person-overlay /absolute/person-overlay.json] [--now 2026-10-03T00:00:00+08:00]',
    ].join('\n'));
    return args.help ? 0 : 2;
  }
  const now = args.now ? new Date(args.now) : new Date();
  const personOverlay = args.personOverlay ? JSON.parse(await readFile(path.resolve(args.personOverlay), 'utf8')) : undefined;
  const result = await prepareFormalV2Campaign({
    dataset: args.dataset,
    acceptance: args.acceptance,
    out: args.out,
    personOverlay,
    campaignId: args.campaignId,
    providerUseReviewRef: args.providerUseReviewRef,
    sourceRevision: readCurrentSourceRevision(),
    now,
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if(invokedAsScript) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
