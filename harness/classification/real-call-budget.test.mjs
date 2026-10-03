import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const build = process.env.CLASSIFICATION_BUILD_DIR;
const {
  FileRealCallBudgetGate,
  REAL_CALL_AUTHORIZATION_VERSION,
  RealCallAuthorizationSchema,
} = require(`${build}/src/lib/algorithms/classification/real-call-budget.js`);

const NOW = Date.parse('2026-10-03T08:00:00.000Z');

function authorization(patch = {}) {
  return {
    version: REAL_CALL_AUTHORIZATION_VERSION,
    authorizationId: 'sgx_internal_t1_20261003',
    providerVersion: 'qwen:qwen3.7-flash-2026-07-15:sgx-five-facets.16:stage-a-validation.3',
    modelVersion: 'qwen3.7-flash-2026-07-15',
    caps: { maxRequests: 150, maxCostCny: 25, maxRetries: 0 },
    openingUsage: {
      requests: 81,
      costCny: 0.745861,
      sourceRefs: ['campaign-ledgers:r5-r9b'],
    },
    allowPersonMatching: true,
    expiresAt: '2026-10-10T00:00:00.000Z',
    authorizationEvidenceRef: 'user-approved-150-requests-25-cny-20261003',
    ...patch,
  };
}

function reservation(index, patch = {}) {
  return {
    jobId: `job_${index}`,
    runId: `run_${index}`,
    attemptRevision: 1,
    executionProfileDigest: `sha256:${String(index).repeat(64).slice(0, 64)}`,
    providerVersion: authorization().providerVersion,
    modelVersion: authorization().modelVersion,
    promptVersion: 'sgx-five-facets.16',
    allowPersonMatching: true,
    maxRequests: 40,
    maxCostCny: 5,
    ...patch,
  };
}

test('real-call authorization rejects an opening balance above the user cap', () => {
  assert.equal(RealCallAuthorizationSchema.safeParse(authorization({
    openingUsage: { requests: 151, costCny: 1, sourceRefs: ['invalid'] },
  })).success, false);
});

test('real-call authorization accepts the approved fifty-call extension but keeps a hard ceiling', () => {
  assert.equal(RealCallAuthorizationSchema.safeParse(authorization({
    authorizationId: 'sgx_internal_t1_postfix_20261003',
    caps: { maxRequests: 200, maxCostCny: 25, maxRetries: 0 },
    openingUsage: { requests: 149, costCny: 22.775116, sourceRefs: ['prior-ledger'] },
    authorizationEvidenceRef: 'user-approved-additional-50-requests-existing-25-cny-cap-20261003',
  })).success, true);
  assert.equal(RealCallAuthorizationSchema.safeParse(authorization({
    caps: { maxRequests: 201, maxCostCny: 25, maxRetries: 0 },
  })).success, false);
});

test('shared real-call ledger starts from prior runs and releases unused reservation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-real-call-budget.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = new FileRealCallBudgetGate({
    dataRoot: root,
    authorization: authorization(),
    nowMs: () => NOW,
  });
  assert.deepEqual(await gate.readStatus(), {
    authorizationId: 'sgx_internal_t1_20261003',
    state: 'active',
    used: { requests: 81, costCny: 0.745861 },
    remaining: { requests: 69, costCny: 24.254139 },
  });
  const held = await gate.reserve(reservation(1));
  assert.equal((await gate.readStatus()).used.requests, 121);
  const settled = await gate.finalize({
    reservation: held,
    disposition: 'settled',
    actualRequests: 3,
    actualCostCny: 0.02,
  });
  assert.deepEqual(settled.used, { requests: 84, costCny: 0.765861 });
  assert.deepEqual(settled.remaining, { requests: 66, costCny: 24.234139 });
});

test('unknown terminal usage conservatively keeps the full reservation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-real-call-uncertain.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = new FileRealCallBudgetGate({ dataRoot: root, authorization: authorization(), nowMs: () => NOW });
  const held = await gate.reserve(reservation(2));
  const uncertain = await gate.finalize({
    reservation: held,
    disposition: 'uncertain',
    actualRequests: 0,
    actualCostCny: 0,
    stopReason: 'PROVIDER_TIMEOUT',
  });
  assert.deepEqual(uncertain.used, { requests: 121, costCny: 5.745861 });
  await assert.rejects(
    gate.reserve(reservation(3)),
    /REAL_CALL_BUDGET_EXHAUSTED/,
  );
});

test('reservation overrun is recorded and halts later real calls', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-real-call-overrun.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = new FileRealCallBudgetGate({ dataRoot: root, authorization: authorization(), nowMs: () => NOW });
  const held = await gate.reserve(reservation(4, { maxRequests: 2, maxCostCny: 1 }));
  const result = await gate.finalize({
    reservation: held,
    disposition: 'settled',
    actualRequests: 3,
    actualCostCny: 0.1,
  });
  assert.equal(result.state, 'halted');
  await assert.rejects(gate.reserve(reservation(5, { maxRequests: 1 })), /REAL_CALL_AUTHORIZATION_HALTED/);
});
