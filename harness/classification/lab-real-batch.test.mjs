import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  REAL_BATCH_POINTER_VERSION,
  getAuthorizedRealBatchStatus,
  realBatchPointerPath,
  runAuthorizedRealBatch
} = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/lab-real-batch.js`);

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-real-batch-'));
  const batchRoot = path.join(root, 'authorized-batches', 'batch_1');
  await mkdir(batchRoot, { recursive: true });
  const caps = {
    maxRequests: 31,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 100_000,
    maxCostCny: 5,
    maxDurationSeconds: 600,
    maxRetries: 0
  };
  const manifestValue = {
    batchId: 'batch_1',
    partition: 'exploration',
    provider: 'qwen',
    model: 'qwen3.7-flash-2026-07-15',
    datasetRootDigest: `sha256:${'1'.repeat(64)}`,
    caps
  };
  const manifest = Buffer.from(`${JSON.stringify(manifestValue)}\n`);
  const manifestPath = path.join(batchRoot, 'batch.json');
  const approvalPath = path.join(batchRoot, 'approval.json');
  await writeFile(manifestPath, manifest);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const approval = {
    version: 'sgx-eval-approval.2',
    campaignId: 'campaign_1',
    phase: 'exploration',
    batchId: 'batch_1',
    manifestHash: digest(manifest),
    datasetRootDigest: `sha256:${'1'.repeat(64)}`,
    approvedBy: 'fixture',
    authorizationEvidenceRef: 'chat_test',
    expiresAt,
    provider: 'qwen',
    model: 'qwen3.7-flash-2026-07-15',
    photoIds: ['photo_1'],
    caps,
    campaignCaps: { maxRequests: 150, maxCostCny: 25, maxRetries: 0 },
    allowExternalImages: true,
    allowPersonMatching: true
  };
  const approvalBytes = Buffer.from(`${JSON.stringify(approval)}\n`);
  await writeFile(approvalPath, approvalBytes);
  const env = { CLASSIFICATION_LAB_DATA_DIR: root, CLASSIFICATION_EVAL_ALLOW_EPHEMERAL_TEST_ROOT: '1' };
  const pointer = {
    version: REAL_BATCH_POINTER_VERSION,
    campaignId: 'campaign_1',
    phase: 'exploration',
    batchId: 'batch_1',
    manifestPath,
    approvalPath,
    outputPath: path.join(batchRoot, 'run'),
    manifestHash: digest(manifest),
    approvalHash: digest(approvalBytes),
    datasetRootDigest: `sha256:${'1'.repeat(64)}`,
    provider: 'qwen',
    model: 'qwen3.7-flash-2026-07-15',
    batchCaps: { maxRequests: 31, maxCostCny: 5, maxRetries: 0 },
    campaignCaps: { maxRequests: 150, maxCostCny: 25, maxRetries: 0 },
    allowPersonMatching: true,
    expiresAt,
    authorizationEvidenceRef: 'chat_test'
  };
  await mkdir(path.dirname(realBatchPointerPath(env)), { recursive: true });
  await writeFile(realBatchPointerPath(env), `${JSON.stringify(pointer)}\n`);
  return { root, env, pointer, manifestPath, approvalPath };
}

test('authorized real batch status binds an immutable local manifest and does not require a credential', async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const status = await getAuthorizedRealBatchStatus(value.env);
  assert.equal(status.configured, true);
  assert.equal(status.started, false);
  assert.equal(status.pointer.manifestHash, value.pointer.manifestHash);
  assert.equal(status.pointer.allowPersonMatching, true);
  assert.equal(status.pointer.batchCaps.maxRequests, 31);
  assert.equal(status.pointer.campaignCaps.maxRequests, 150);
  assert.equal(status.pointer.campaignCaps.maxCostCny, 25);
  assert.equal('SGX_D4_API_KEY' in value.env, false);

  await writeFile(value.manifestPath, '{"batch":"changed"}\n');
  await assert.rejects(getAuthorizedRealBatchStatus(value.env), /REAL_BATCH_MANIFEST_CHANGED/);
});

test('authorized real batch execution fails closed before spawning when the credential is absent', async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(runAuthorizedRealBatch(value.env), /MODEL_NOT_CONFIGURED/);
});

test('authorized real batch validates approval bytes and bindings before checking a credential', async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(value.approvalPath, '{"changed":true}\n');
  await assert.rejects(runAuthorizedRealBatch(value.env), /REAL_BATCH_APPROVAL_CHANGED/);
});

test('authorized real batch rejects paths outside its configured data root', async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const bad = { ...value.pointer, manifestPath: path.join(tmpdir(), 'outside-batch.json') };
  await writeFile(realBatchPointerPath(value.env), `${JSON.stringify(bad)}\n`);
  await assert.rejects(getAuthorizedRealBatchStatus(value.env), /REAL_BATCH_PATH_FORBIDDEN/);
});
