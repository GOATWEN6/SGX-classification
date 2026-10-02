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
  const manifest = Buffer.from('{"batch":"one"}\n');
  const manifestPath = path.join(batchRoot, 'batch.json');
  const approvalPath = path.join(batchRoot, 'approval.json');
  await writeFile(manifestPath, manifest);
  await writeFile(approvalPath, '{}\n');
  const env = { CLASSIFICATION_LAB_DATA_DIR: root };
  const pointer = {
    version: REAL_BATCH_POINTER_VERSION,
    batchId: 'batch_1',
    manifestPath,
    approvalPath,
    outputPath: path.join(batchRoot, 'run'),
    manifestHash: digest(manifest),
    datasetRootDigest: `sha256:${'1'.repeat(64)}`,
    model: 'qwen3.7-flash-2026-07-15',
    maxRequests: 150,
    maxCostCny: 25,
    automaticRetries: 0,
    allowPersonMatching: true,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authorizationEvidenceRef: 'chat_test'
  };
  await mkdir(path.dirname(realBatchPointerPath(env)), { recursive: true });
  await writeFile(realBatchPointerPath(env), `${JSON.stringify(pointer)}\n`);
  return { root, env, pointer, manifestPath };
}

test('authorized real batch status binds an immutable local manifest and does not require a credential', async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const status = await getAuthorizedRealBatchStatus(value.env);
  assert.equal(status.configured, true);
  assert.equal(status.started, false);
  assert.equal(status.pointer.manifestHash, value.pointer.manifestHash);
  assert.equal(status.pointer.allowPersonMatching, true);
  assert.equal(status.pointer.maxRequests, 150);
  assert.equal(status.pointer.maxCostCny, 25);
  assert.equal('SGX_D4_API_KEY' in value.env, false);

  await writeFile(value.manifestPath, '{"batch":"changed"}\n');
  await assert.rejects(getAuthorizedRealBatchStatus(value.env), /REAL_BATCH_MANIFEST_CHANGED/);
});

test('authorized real batch execution fails closed before spawning when the credential is absent', async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(runAuthorizedRealBatch(value.env), /MODEL_NOT_CONFIGURED/);
});

test('authorized real batch rejects paths outside its configured data root', async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const bad = { ...value.pointer, manifestPath: path.join(tmpdir(), 'outside-batch.json') };
  await writeFile(realBatchPointerPath(value.env), `${JSON.stringify(bad)}\n`);
  await assert.rejects(getAuthorizedRealBatchStatus(value.env), /REAL_BATCH_PATH_FORBIDDEN/);
});
