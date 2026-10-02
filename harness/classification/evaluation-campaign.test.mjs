import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const campaign = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/evaluation-campaign.js`);

const digest = char => `sha256:${char.repeat(64)}`;
const future = () => new Date(Date.now() + 60_000).toISOString();

function boundFixture(overrides = {}) {
  const datasetRootDigest = overrides.datasetRootDigest ?? digest('2');
  const manifest = {
    batchId: overrides.batchId ?? 'exploration_1',
    partition: overrides.phase === 'validation' ? 'holdout' : 'exploration',
    provider: 'qwen',
    model: 'qwen3.7-flash-2026-07-15',
    datasetRootDigest,
    caps: {
      maxRequests: overrides.maxRequests ?? 31,
      maxCostCny: overrides.maxCostCny ?? 5,
      maxRetries: 0,
    },
  };
  const manifestHash = overrides.manifestHash ?? digest('1');
  const approval = {
    version: 'sgx-eval-approval.2',
    campaignId: overrides.campaignId ?? 'campaign_1',
    phase: overrides.phase ?? 'exploration',
    batchId: manifest.batchId,
    manifestHash,
    datasetRootDigest,
    approvedBy: 'fixture',
    authorizationEvidenceRef: 'chat_fixture',
    expiresAt: future(),
    provider: manifest.provider,
    model: manifest.model,
    photoIds: ['photo_1'],
    caps: {
      ...manifest.caps,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 100_000,
      maxDurationSeconds: 600,
    },
    campaignCaps: { maxRequests: 150, maxCostCny: 25, maxRetries: 0 },
    allowExternalImages: true,
    allowPersonMatching: true,
  };
  const approvalBytes = Buffer.from(`${JSON.stringify(approval)}\n`);
  const pointer = {
    version: campaign.EVALUATION_CAMPAIGN_POINTER_VERSION,
    campaignId: approval.campaignId,
    phase: approval.phase,
    batchId: approval.batchId,
    manifestPath: '/data/batch.json',
    approvalPath: '/data/approval.json',
    outputPath: '/data/run',
    manifestHash,
    approvalHash: campaign.sha256Bytes(approvalBytes),
    datasetRootDigest: approval.datasetRootDigest,
    provider: approval.provider,
    model: approval.model,
    batchCaps: {
      maxRequests: approval.caps.maxRequests,
      maxCostCny: approval.caps.maxCostCny,
      maxRetries: 0,
    },
    campaignCaps: approval.campaignCaps,
    allowPersonMatching: approval.allowPersonMatching,
    expiresAt: approval.expiresAt,
    authorizationEvidenceRef: approval.authorizationEvidenceRef,
  };
  return { manifest, manifestHash, approval, approvalBytes, pointer };
}

async function dataRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-campaign-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, env: { CLASSIFICATION_LAB_DATA_DIR: root, CLASSIFICATION_EVAL_ALLOW_EPHEMERAL_TEST_ROOT: '1' } };
}

test('campaign binding cross-checks manifest, approval bytes, model, caps and authorization', () => {
  const value = boundFixture();
  const valid = campaign.validateCampaignBindings(value);
  assert.equal(valid.pointer.campaignId, 'campaign_1');
  assert.equal(valid.approval.version, 'sgx-eval-approval.2');

  assert.throws(() => campaign.validateCampaignBindings({
    ...value,
    approvalBytes: Buffer.from('{}\n'),
  }), /REAL_BATCH_APPROVAL_CHANGED/);
  assert.throws(() => campaign.validateCampaignBindings({
    ...value,
    pointer: { ...value.pointer, model: 'changed-model' },
  }), /APPROVAL_MODEL_MISMATCH/);
  assert.throws(() => campaign.validateCampaignBindings({
    ...value,
    pointer: { ...value.pointer, authorizationEvidenceRef: 'other' },
  }), /AUTHORIZATION_EVIDENCE_MISMATCH/);
  assert.throws(() => campaign.validateCampaignBindings({
    ...value,
    manifest: { ...value.manifest, datasetRootDigest: digest('9') },
  }), /CAMPAIGN_DATASET_MISMATCH/);
});

test('formal campaign requires an explicit non-temporary data root outside test mode', async () => {
  const value = boundFixture();
  await assert.rejects(
    campaign.beginCampaignBatch({ env: {}, pointer: value.pointer, runIds: ['run_missing_root'] }),
    /PERSISTENT_DATA_ROOT_REQUIRED/,
  );
  await assert.rejects(
    campaign.beginCampaignBatch({ env: { CLASSIFICATION_LAB_DATA_DIR: tmpdir() }, pointer: value.pointer, runIds: ['run_tmp_root'] }),
    /PERSISTENT_DATA_ROOT_REQUIRED/,
  );
});

test('exploration and validation share one cumulative campaign budget', async t => {
  const { env } = await dataRoot(t);
  const exploration = boundFixture();
  const first = await campaign.beginCampaignBatch({ env, pointer: exploration.pointer, runIds: ['run_1'] });
  await campaign.finishCampaignBatch({ reservation: first, status: 'completed', actualRequests: 20, actualCostCny: 1.25 });

  const validation = boundFixture({
    phase: 'validation',
    batchId: 'validation_1',
    manifestHash: digest('3'),
    maxRequests: 20,
    maxCostCny: 5,
  });
  const second = await campaign.beginCampaignBatch({ env, pointer: validation.pointer, runIds: ['run_2'] });
  const ledger = await campaign.finishCampaignBatch({ reservation: second, status: 'completed', actualRequests: 18, actualCostCny: 1.5 });
  assert.deepEqual(campaign.accountedCampaignUsage(ledger), { requests: 38, costMicroCny: 2_750_000 });
  assert.equal(ledger.batches.length, 2);
  assert.equal(ledger.batches[1].phase, 'validation');
});

test('campaign rejects the 151st reserved call before a new batch starts', async t => {
  const { env } = await dataRoot(t);
  const firstValue = boundFixture({ maxRequests: 150, maxCostCny: 20 });
  const first = await campaign.beginCampaignBatch({ env, pointer: firstValue.pointer, runIds: ['run_1'] });
  await campaign.finishCampaignBatch({ reservation: first, status: 'completed', actualRequests: 150, actualCostCny: 20 });
  const next = boundFixture({ batchId: 'exploration_2', manifestHash: digest('4'), maxRequests: 1, maxCostCny: 1 });
  await assert.rejects(campaign.beginCampaignBatch({ env, pointer: next.pointer, runIds: ['run_2'] }), /CAMPAIGN_BUDGET_EXHAUSTED/);
});

test('a live or crashed reservation blocks concurrent batches and keeps its full budget', async t => {
  const { root, env } = await dataRoot(t);
  const value = boundFixture();
  await campaign.beginCampaignBatch({ env, pointer: value.pointer, runIds: ['run_1'] });
  const next = boundFixture({ batchId: 'exploration_2', manifestHash: digest('5') });
  await assert.rejects(campaign.beginCampaignBatch({ env, pointer: next.pointer, runIds: ['run_2'] }), /CAMPAIGN_LOCKED_OR_UNCERTAIN/);
  const ledger = JSON.parse(await readFile(path.join(root, 'real-batch', 'campaigns', 'campaign_1', 'campaign-ledger.json'), 'utf8'));
  assert.deepEqual(campaign.accountedCampaignUsage(ledger), { requests: 31, costMicroCny: 5_000_000 });
});

test('halted overrun accounting never understates observed usage', async t => {
  const { env } = await dataRoot(t);
  const value = boundFixture({ maxRequests: 1, maxCostCny: 1 });
  const reservation = await campaign.beginCampaignBatch({ env, pointer: value.pointer, runIds: ['run_overrun'] });
  const ledger = await campaign.finishCampaignBatch({
    reservation,
    status: 'completed',
    actualRequests: 2,
    actualCostCny: 1.25,
  });
  assert.equal(ledger.state, 'halted');
  assert.equal(ledger.batches[0].stopReason, 'CAMPAIGN_RESERVATION_OVERRUN');
  assert.deepEqual(campaign.accountedCampaignUsage(ledger), { requests: 2, costMicroCny: 1_250_000 });
});

test('validation requires completed exploration and may run only once', async t => {
  const { env } = await dataRoot(t);
  const validation = boundFixture({ phase: 'validation', batchId: 'validation_1', manifestHash: digest('6'), maxRequests: 20 });
  await assert.rejects(campaign.beginCampaignBatch({ env, pointer: validation.pointer, runIds: ['run_v'] }), /VALIDATION_REQUIRES_EXPLORATION/);

  const exploration = boundFixture();
  const first = await campaign.beginCampaignBatch({ env, pointer: exploration.pointer, runIds: ['run_e'] });
  await campaign.finishCampaignBatch({ reservation: first, status: 'completed', actualRequests: 1, actualCostCny: 0.1 });
  const accepted = await campaign.beginCampaignBatch({ env, pointer: validation.pointer, runIds: ['run_v'] });
  await campaign.finishCampaignBatch({ reservation: accepted, status: 'completed', actualRequests: 1, actualCostCny: 0.1 });

  const second = boundFixture({ phase: 'validation', batchId: 'validation_2', manifestHash: digest('7'), maxRequests: 20 });
  await assert.rejects(campaign.beginCampaignBatch({ env, pointer: second.pointer, runIds: ['run_v2'] }), /DUPLICATE_VALIDATION_PHASE/);
});

test('duplicate batch, manifest and run identifiers are rejected without changing prior evidence', async t => {
  const { env } = await dataRoot(t);
  const value = boundFixture();
  const reservation = await campaign.beginCampaignBatch({ env, pointer: value.pointer, runIds: ['run_1'] });
  await campaign.finishCampaignBatch({ reservation, status: 'completed', actualRequests: 1, actualCostCny: 0.1 });
  await assert.rejects(campaign.beginCampaignBatch({ env, pointer: value.pointer, runIds: ['run_2'] }), /DUPLICATE_CAMPAIGN_BATCH/);
  const duplicateManifest = boundFixture({ batchId: 'exploration_2' });
  await assert.rejects(campaign.beginCampaignBatch({ env, pointer: duplicateManifest.pointer, runIds: ['run_2'] }), /DUPLICATE_CAMPAIGN_MANIFEST/);
  const duplicateRun = boundFixture({ batchId: 'exploration_3', manifestHash: digest('8') });
  await assert.rejects(campaign.beginCampaignBatch({ env, pointer: duplicateRun.pointer, runIds: ['run_1'] }), /DUPLICATE_RUN/);
});
