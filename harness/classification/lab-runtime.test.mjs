import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const build = process.env.CLASSIFICATION_BUILD_DIR;
const { buildLabSubmission } = require(`${build}/src/lib/algorithms/classification/lab-contract.js`);
const { DeterministicLabProvider, createConfiguredLabProvider } = require(`${build}/src/lib/algorithms/classification/lab-provider.js`);
const { FileClassificationLabStore } = require(`${build}/src/lib/algorithms/classification/lab-store.js`);
const { requireLocalClassificationLab } = require(`${build}/src/lib/algorithms/classification/lab-http.js`);
const { submitClassificationLabJob, classificationLabCapabilities } = require(`${build}/src/lib/algorithms/classification/lab-service.js`);

function png(index, width = 4, height = 3) {
  const bytes = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(index, 24);
  return bytes;
}

function submission(patch = {}) {
  return {
    scope: { householdId: 'house_lab', subjectId: 'elder_lab' },
    actorId: 'elder_lab',
    contextKind: 'album_upload',
    recipientIds: [],
    images: [
      { filename: '老照片一.png', mimeType: 'image/png', bytes: png(1) },
      { filename: '老照片二.png', mimeType: 'image/png', bytes: png(2) }
    ],
    userText: '这是1985年在北京的同学聚会',
    finalAsr: '后来我们又在北京见面',
    userTextTargetIndexes: [0, 1],
    finalAsrTargetIndexes: null,
    submittedAt: '2026-09-27T12:00:00.000Z',
    ...patch
  };
}

test('lab BFF input becomes server-built v2 Evidence and deterministic story output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabStore(root);
  const job = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  assert.equal(job.status, 'succeeded');
  assert.equal(job.envelope.specVersion, '2.0.0');
  assert.equal(job.envelope.contractVersion, 'classification-ingestion.2');
  assert.equal(job.envelope.evidence.length, 4);
  assert.equal(job.metrics.modelRequests, 0);
  assert.equal(job.metrics.costCny, 0);
  assert.equal(job.result.provider.accuracyClaim, 'not_evaluated');
  assert.equal(job.result.provider.modelVersion, 'none');
  const joined = job.result.organization.stories.find(story => story.memberContentIds.length === 3);
  assert.ok(joined);
  assert.equal(joined.titleCandidate, '聚会');
  assert.ok(Object.values(job.originalTextByEvidenceId).includes('这是1985年在北京的同学聚会'));
  const image = job.envelope.evidence.find(item => item.lifecycleState !== 'deleted' && item.modality === 'image');
  const asset = await store.readAsset(job.jobId, image.evidenceId);
  assert.equal(asset.ref.mimeType, 'image/png');
  assert.deepEqual(asset.bytes, png(1));
});

test('identical local submission is idempotent and different subjects stay isolated', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabStore(root);
  const first = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  const replay = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  assert.equal(first.jobId, replay.jobId);
  assert.equal((await store.list()).length, 1);
  const other = await submitClassificationLabJob(submission({ scope: { householdId: 'house_lab', subjectId: 'elder_other' } }), store, new DeterministicLabProvider());
  assert.notEqual(first.jobId, other.jobId);
  assert.equal((await store.list()).length, 2);
});

test('family transfer receives frozen inbox policy while invalid media and bindings stop before storage', () => {
  const family = buildLabSubmission(submission({
    contextKind: 'family_transfer', actorId: 'daughter_lab', senderId: 'daughter_lab', recipientIds: ['elder_lab']
  }));
  assert.equal(family.envelope.reviewPolicy.remindAfterDays, 3);
  assert.equal(family.envelope.reviewPolicy.hideFromHomeAfterDays, 7);
  assert.throws(() => buildLabSubmission(submission({ images: [{ filename: 'bad.png', mimeType: 'image/png', bytes: Buffer.from('not an image') }] })), /MIME_SIGNATURE_OR_DIMENSIONS_MISMATCH/);
  assert.throws(() => buildLabSubmission(submission({ userTextTargetIndexes: [4] })), /TARGET_IMAGE_INDEX_OUT_OF_RANGE/);
  assert.throws(() => buildLabSubmission(submission({ images: [], userText: '', finalAsr: '', userTextTargetIndexes: null, finalAsrTargetIndexes: null })), /EMPTY_SUBMISSION/);
});

test('lab provider selection fails closed and capabilities do not claim model accuracy', () => {
  assert.equal(createConfiguredLabProvider('deterministic').mode, 'deterministic');
  assert.throws(() => createConfiguredLabProvider('qwen'), /REAL_PROVIDER_ADAPTER_NOT_CONFIGURED/);
  const capabilities = classificationLabCapabilities();
  assert.equal(capabilities.realProviderConfigured, false);
  assert.equal(capabilities.accuracyClaim, 'not_evaluated');
  assert.equal(capabilities.productionDatabase, false);
  assert.equal(capabilities.productionQueue, false);
});

test('lab HTTP gate is disabled by default, loopback-only and requires a mutation header', () => {
  const prior = process.env.CLASSIFICATION_LAB_ENABLED;
  delete process.env.CLASSIFICATION_LAB_ENABLED;
  assert.throws(() => requireLocalClassificationLab(new Request('http://127.0.0.1/api/classification-lab')), /CLASSIFICATION_LAB_DISABLED/);
  process.env.CLASSIFICATION_LAB_ENABLED = 'true';
  assert.throws(() => requireLocalClassificationLab(new Request('http://192.0.2.5/api/classification-lab')), /CLASSIFICATION_LAB_LOOPBACK_ONLY/);
  assert.throws(() => requireLocalClassificationLab(new Request('http://127.0.0.1/api/classification-lab'), true), /CLASSIFICATION_LAB_HEADER_REQUIRED/);
  assert.doesNotThrow(() => requireLocalClassificationLab(new Request('http://127.0.0.1/api/classification-lab', { headers: { 'x-sgx-classification-lab': '1', origin: 'http://localhost:3000' } }), true));
  if(prior === undefined) delete process.env.CLASSIFICATION_LAB_ENABLED; else process.env.CLASSIFICATION_LAB_ENABLED = prior;
});

test('lab store writes only bounded job and asset files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabStore(root);
  const job = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  const entries = await readdir(path.join(root, job.jobId));
  assert.deepEqual(entries.sort(), ['assets', 'job.json']);
});
