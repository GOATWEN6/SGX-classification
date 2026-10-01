import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const base = `${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification`;
const { buildLabSubmission } = require(`${base}/lab-contract.js`);
const {
  buildTrustedLabGuardSnapshot,
  computeLabGuardDigest
} = require(`${base}/lab-execution-contract.js`);
const { FileClassificationLabV2Store } = require(`${base}/lab-execution-store.js`);
const {
  submitLabExecutionJob,
  runPendingLabExecutionJob,
  cancelLabExecutionJob
} = require(`${base}/lab-execution.js`);
const {
  StageALabExecutorFactory,
  stageALabProviderVersion
} = require(`${base}/lab-stage-a-executor.js`);
const {
  computePlaceKindPolicyDigest,
  STAGE_A_LAB_COMPOSITION_VERSION
} = require(`${base}/lab-stage-a-composition.js`);
const { PROMPT_VERSION } = require(`${base}/stage-a-contract.js`);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1kAAAAASUVORK5CYII=', 'base64');
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const clock = {
  nowMs: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle)
};

function submission(patch = {}) {
  return {
    scope: { householdId: 'house_stage_executor', subjectId: 'elder_stage_executor' },
    actorId: 'daughter_stage_executor',
    contextKind: 'family_transfer',
    senderId: 'daughter_stage_executor',
    recipientIds: ['elder_stage_executor'],
    images: [{ filename: 'family.png', mimeType: 'image/png', bytes: png }],
    userText: '这是家里的旧照片',
    finalAsr: undefined,
    userTextTargetIndexes: [0],
    finalAsrTargetIndexes: null,
    submittedAt: new Date().toISOString(),
    ...patch
  };
}

function guardFor(built, patch = {}) {
  return buildTrustedLabGuardSnapshot({
    scope: structuredClone(built.envelope.scope),
    actorId: built.envelope.actorId,
    authorityRef: 'authority_stage_executor',
    purposes: ['classification', 'album_organization', 'search_candidate', 'interview_candidate'],
    authorizationRevision: built.envelope.authorizationRevision,
    contextRevision: 'context_stage_executor_1',
    active: true,
    allowedConsentRefs: [...new Set(built.envelope.evidence.map(item => item.consentRef))].sort(),
    allowedCorrectionIds: [],
    allowPersonMatching: false,
    evidence: built.envelope.evidence.map(item => ({
      evidenceId: item.evidenceId,
      revision: item.revision,
      sourceHash: item.sourceHash,
      consentRef: item.consentRef,
      lifecycleState: item.lifecycleState
    })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    ...patch
  });
}

function placePolicy(taxonomyVersion) {
  return {
    policyVersion: 'classification-place-kind.1',
    taxonomyVersion,
    genericLabels: ['家中', '室内', '户外']
  };
}

function profile(mode, model, taxonomyVersion) {
  const policy = placePolicy(taxonomyVersion);
  return {
    providerMode: mode,
    providerVersion: stageALabProviderVersion('qwen', model),
    modelVersion: model,
    promptVersion: PROMPT_VERSION,
    guardVersion: 'classification-lab-guard.1',
    adapterVersion: STAGE_A_LAB_COMPOSITION_VERSION,
    taxonomyVersion,
    placeKindPolicyDigest: computePlaceKindPolicyDigest(policy),
    scorerVersion: 'classification-semantic-score.2',
    configDigest: hash(Buffer.from(`${mode}:${model}`))
  };
}

function transportFor(model, calls, patchValue) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, authorization: new Headers(init.headers).get('authorization') });
    const context = JSON.parse(body.messages[1].content[0].text);
    const photoId = context.untrustedContext.requestedPhotoIds[0];
    const value = patchValue?.({ body, context, photoId }) ?? {
      observations: [{
        photoId,
        people: [],
        mentions: [],
        times: [],
        places: [],
        events: [],
        scenes: [{
          label: '室内',
          supports: [{ photoId, source: 'visual', quote: '画面可见室内环境' }]
        }],
        unknownFacets: ['person', 'time', 'place', 'event'],
        conflicts: []
      }]
    };
    return new Response(JSON.stringify({
      id: `response_${calls.length}`,
      model,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }]
    }), { status: 200 });
  };
}

async function fixture(t, mode = 'stage_a_mock', options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-stage-a-executor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabV2Store(root);
  const built = buildLabSubmission(submission(options.submission));
  const guard = guardFor(built, options.guard);
  const model = options.model ?? 'qwen-stage-a-test.1';
  const executionProfile = profile(mode, model, built.envelope.taxonomyVersion);
  const input = {
    built,
    profile: executionProfile,
    guard,
    semanticContext: {
      version: 'classification-lab-semantic-context.1',
      referenceDate: new Date().toISOString().slice(0, 10),
      timeZone: 'Asia/Shanghai',
      relativeTimePolicyVersion: 'relative-time.1'
    },
    budgetPolicy: {
      maxRequests: 1,
      maxInputTokens: 100000,
      maxOutputTokens: 4096,
      maxCostCny: 1,
      maxCandidatesPerContent: 8,
      maxCallDurationMs: 5000
    },
    attemptRevision: 1,
    deadlineAt: new Date(Date.now() + 30000).toISOString()
  };
  return { store, built, guard, model, executionProfile, input };
}

class GuardProvider {
  constructor(value) { this.value = value; }
  async get() { return structuredClone(this.value); }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('real Stage A mock transport runs through the durable v2 lifecycle', async t => {
  const value = await fixture(t);
  const calls = [];
  const records = [];
  const factory = new StageALabExecutorFactory({
    profile: value.executionProfile,
    provider: 'qwen',
    model: value.model,
    inputCnyPerMillion: 0,
    outputCnyPerMillion: 0,
    placeKindPolicy: placePolicy(value.built.envelope.taxonomyVersion),
    transport: transportFor(value.model, calls),
    recordProviderResponse: entry => records.push(entry)
  });
  const pending = await submitLabExecutionJob(value.input, value.store, clock);
  const completed = await runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory,
    guardProvider: new GuardProvider(value.guard),
    clock,
    runnerGeneration: 'runner_stage_a_executor_mock'
  });
  assert.ok(['succeeded', 'needs_review'].includes(completed.status));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, null);
  assert.equal(records.length, 1);
  assert.equal(records[0].jobId, pending.jobId);
  assert.equal(completed.result.output.provider.mode, 'stage_a_mock');
  assert.equal(completed.result.output.provider.evidenceStatus, 'mock_transport');
  assert.equal(completed.result.output.provider.accuracyClaim, 'not_evaluated');
  assert.equal(completed.metrics.modelRequests, 1);
  assert.equal(completed.metrics.imageRequests, 1);
  assert.equal(completed.metrics.inputTokens, 100);
  assert.equal(completed.metrics.outputTokens, 50);
  assert.equal(completed.metrics.costCny, 0);
  assert.ok(completed.result.output.observations.some(item => item.facet === 'scene'));
});

test('stage_a_real enforces grant and reads the credential only at the authorized call', async t => {
  const value = await fixture(t, 'stage_a_real');
  const calls = [];
  let credentialCalls = 0;
  const factory = new StageALabExecutorFactory({
    profile: value.executionProfile,
    provider: 'qwen',
    model: value.model,
    inputCnyPerMillion: 1,
    outputCnyPerMillion: 2,
    placeKindPolicy: placePolicy(value.built.envelope.taxonomyVersion),
    transport: transportFor(value.model, calls),
    credential: () => { credentialCalls++; return 'local-test-secret'; }
  });
  assert.equal(credentialCalls, 0);
  factory.describe(value.executionProfile);
  assert.equal(credentialCalls, 0);
  const pending = await submitLabExecutionJob(value.input, value.store, clock);
  const completed = await runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory,
    guardProvider: new GuardProvider(value.guard),
    clock,
    runnerGeneration: 'runner_stage_a_executor_real'
  });
  assert.ok(['succeeded', 'needs_review'].includes(completed.status));
  assert.equal(credentialCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, 'Bearer local-test-secret');
  assert.equal(completed.result.output.provider.mode, 'stage_a_real');
  assert.equal(completed.result.output.provider.evidenceStatus, 'real_api');
  assert.ok(Math.abs(completed.metrics.costCny - 0.0002) < 1e-12);
});

test('invalid Provider JSON fails terminally without an automatic retry', async t => {
  const value = await fixture(t);
  const calls = [];
  const factory = new StageALabExecutorFactory({
    profile: value.executionProfile,
    provider: 'qwen',
    model: value.model,
    inputCnyPerMillion: 0,
    outputCnyPerMillion: 0,
    placeKindPolicy: placePolicy(value.built.envelope.taxonomyVersion),
    transport: transportFor(value.model, calls, () => ({ unexpected: true }))
  });
  const pending = await submitLabExecutionJob(value.input, value.store, clock);
  const completed = await runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory,
    guardProvider: new GuardProvider(value.guard),
    clock,
    runnerGeneration: 'runner_stage_a_executor_invalid'
  });
  assert.equal(calls.length, 1);
  assert.equal(completed.status, 'failed_terminal');
  assert.equal(completed.error.code, 'INVALID_OUTPUT');
});

test('processing cancellation aborts Stage A and a late transport cannot revive the job', async t => {
  const value = await fixture(t);
  const started = deferred();
  let calls = 0;
  const factory = new StageALabExecutorFactory({
    profile: value.executionProfile,
    provider: 'qwen',
    model: value.model,
    inputCnyPerMillion: 0,
    outputCnyPerMillion: 0,
    placeKindPolicy: placePolicy(value.built.envelope.taxonomyVersion),
    transport: async (_url, init) => {
      calls++;
      started.resolve();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('transport aborted')), { once: true });
      });
    }
  });
  const pending = await submitLabExecutionJob(value.input, value.store, clock);
  const running = runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory,
    guardProvider: new GuardProvider(value.guard),
    clock,
    runnerGeneration: 'runner_stage_a_executor_cancel'
  });
  await started.promise;
  const cancelled = await cancelLabExecutionJob(pending.jobId, { store: value.store, clock });
  const completed = await running;
  assert.equal(calls, 1);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(completed.status, 'cancelled');
  assert.equal(completed.error.code, 'CANCELLED');
  assert.equal(completed.result, undefined);
});

test('revoked preflight performs no credential read and no transport call', async t => {
  const value = await fixture(t, 'stage_a_real');
  const calls = [];
  let credentialCalls = 0;
  const factory = new StageALabExecutorFactory({
    profile: value.executionProfile,
    provider: 'qwen',
    model: value.model,
    inputCnyPerMillion: 1,
    outputCnyPerMillion: 2,
    placeKindPolicy: placePolicy(value.built.envelope.taxonomyVersion),
    transport: transportFor(value.model, calls),
    credential: () => { credentialCalls++; return 'must-not-be-read'; }
  });
  const pending = await submitLabExecutionJob(value.input, value.store, clock);
  const revoked = structuredClone(value.guard);
  revoked.active = false;
  revoked.guardDigest = computeLabGuardDigest(revoked);
  const completed = await runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory,
    guardProvider: new GuardProvider(revoked),
    clock,
    runnerGeneration: 'runner_stage_a_executor_revoked'
  });
  assert.equal(completed.status, 'cancelled');
  assert.equal(completed.error.code, 'AUTHORIZATION_REVOKED');
  assert.equal(credentialCalls, 0);
  assert.equal(calls.length, 0);
});
