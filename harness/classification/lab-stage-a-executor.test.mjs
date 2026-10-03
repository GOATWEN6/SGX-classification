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

test('historical Top-K reaches the canonical result without silently merging prior content', async t => {
  const value = await fixture(t);
  const calls = [];
  const factory = new StageALabExecutorFactory({
    profile: value.executionProfile,
    provider: 'qwen',
    model: value.model,
    inputCnyPerMillion: 0,
    outputCnyPerMillion: 0,
    placeKindPolicy: placePolicy(value.built.envelope.taxonomyVersion),
    transport: transportFor(value.model, calls),
  });
  const pending = await submitLabExecutionJob(value.input, value.store, clock);
  const sourceContent = pending.envelope.contents.find(item => item.modality === 'image');
  const sourceEvidence = pending.envelope.evidence.find(item => item.evidenceId === sourceContent.evidenceId);
  assert.ok(sourceContent);
  assert.ok(sourceEvidence);
  const context = {
    job: pending,
    signal: new AbortController().signal,
    clock,
    getGuard: async () => structuredClone(value.guard),
    readAsset: async evidenceId => {
      assert.equal(evidenceId, sourceEvidence.evidenceId);
      return new Uint8Array(png);
    },
    derivedFeatures: {
      version: 'classification-worker-derived-features.2',
      ocrTextByEvidenceId: {},
      retrievalHints: [],
      historicalCandidates: [{
        candidateId: 'historical_candidate_executor_1',
        sourceContentId: sourceContent.contentId,
        sourceEvidenceId: sourceEvidence.evidenceId,
        historicalContentId: 'content_previous_round_1',
        historicalEvidenceId: 'evidence_previous_round_1',
        kind: 'image_text_embedding',
        rank: 1,
        modelId: 'bge_visualized_m3',
        modelRevision: 'frozen_revision_1',
        reasons: ['semantic_neighbor', 'historical_projection_authorized'],
        featureRefs: ['feature_previous_round_1'],
        evidenceRefs: [sourceEvidence.evidenceId, 'evidence_previous_round_1'],
        historicalProjection: {
          contentId: 'content_previous_round_1',
          evidenceId: 'evidence_previous_round_1',
          evidenceRevision: 1,
          sourceHash: hash(Buffer.from('previous-round-image')),
          artifactId: 'artifact_previous_round_1',
          mimeType: 'image/jpeg',
          byteLength: 1024,
          consentRef: 'consent_previous_round_1',
          confirmedReferenceIds: [],
          lifecycleState: 'active',
        },
      }],
      embeddingRetrieval: 'batch_topk',
      historicalRetrieval: 'historical_topk',
    },
  };
  const executor = factory.create(value.executionProfile, context);
  const outcome = await executor.execute(context);
  assert.equal(calls.length, 1);
  assert.equal(outcome.result.output.crossRoundAssociations.length, 1);
  const association = outcome.result.output.crossRoundAssociations[0];
  assert.equal(association.historicalContentId, 'content_previous_round_1');
  assert.equal(association.status, 'candidate_only');
  assert.equal(association.decisionBasis, 'retrieval_only');
  assert.equal('score' in association, false);
  assert.ok(outcome.result.output.organization.stories.every(story => (
    !story.memberContentIds.includes('content_previous_round_1')
  )));
  assert.ok(outcome.result.output.organization.reviewItems.every(item => !item.includes(association.associationId)));
});

test('consent-gated person matching reaches the model and only produces unnamed AI candidates', async t => {
  const value = await fixture(t, 'stage_a_mock', {
    submission: {
      images: [
        { filename: 'family-one.png', mimeType: 'image/png', bytes: png },
        { filename: 'family-two.png', mimeType: 'image/png', bytes: png }
      ],
      userTextTargetIndexes: [0, 1]
    }
  });
  const imageIds = value.built.envelope.contents.filter(item => item.modality === 'image').map(item => item.evidenceId);
  const { guardDigest: _guardDigest, ...guardInput } = value.guard;
  const matchingGuard = buildTrustedLabGuardSnapshot({
    ...guardInput,
    allowPersonMatching: true,
    personMatchingEvidenceIds: imageIds,
    evidence: guardInput.evidence.map(item => imageIds.includes(item.evidenceId)
      ? { ...item, personConsentRef: `person_consent_${item.evidenceId}` }
      : item)
  });
  value.input.guard = matchingGuard;
  value.input.budgetPolicy = { ...value.input.budgetPolicy, maxRequests: 3, maxOutputTokens: 20_000 };
  const calls = [];
  const tokenCaps = [];
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    const context = JSON.parse(body.messages[1].content[0].text);
    calls.push(context);
    tokenCaps.push({ stage: context.stage, maxTokens: body.max_tokens });
    let response;
    if(context.stage === 'extract') {
      const photoId = context.untrustedContext.requestedPhotoIds[0];
      response = { observations: [{
        photoId,
        people: [{
          faceId: `face_${calls.length}`, description: '', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
          supports: [{ photoId, source: 'visual', quote: '画面可见一张清晰人脸' }]
        }],
        mentions: [], times: [], places: [], events: [], scenes: [],
        unknownFacets: ['time', 'place', 'event', 'scene'], conflicts: []
      }] };
    } else {
      const [left, right] = context.untrustedContext.requestedPairs[0];
      const observations = context.untrustedContext.observations;
      response = { relations: [
        {
          kind: 'event', left: { photoId: left }, right: { photoId: right }, decision: 'unknown',
          supports: [left, right].map(photoId => ({ photoId, source: 'visual', quote: '仅见人物，缺少事件线索' })),
          rationale: '缺少足够事件证据'
        },
        {
          kind: 'person',
          left: { photoId: left, faceId: observations[0].people[0].faceId },
          right: { photoId: right, faceId: observations[1].people[0].faceId },
          decision: 'same',
          supports: [left, right].map(photoId => ({ photoId, source: 'visual', quote: '两张照片均可见待比较人脸' })),
          rationale: '仅形成同人候选，不确认姓名或关系'
        }
      ] };
    }
    return new Response(JSON.stringify({
      id: `person_response_${calls.length}`, model: value.model,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }]
    }), { status: 200 });
  };
  const factory = new StageALabExecutorFactory({
    profile: value.executionProfile,
    provider: 'qwen', model: value.model, inputCnyPerMillion: 0, outputCnyPerMillion: 0,
    placeKindPolicy: placePolicy(value.built.envelope.taxonomyVersion), transport
  });
  const pending = await submitLabExecutionJob(value.input, value.store, clock);
  const completed = await runPendingLabExecutionJob(pending.jobId, {
    store: value.store, factory, guardProvider: new GuardProvider(matchingGuard), clock,
    runnerGeneration: 'runner_stage_a_person_matching'
  });
  assert.ok(['succeeded', 'needs_review'].includes(completed.status));
  assert.equal(calls.filter(call => call.stage === 'relate').length, 1);
  assert.equal(tokenCaps.find(call => call.stage === 'relate').maxTokens, 2048);
  assert.equal(calls.find(call => call.stage === 'relate').untrustedContext.personMatchingEnabled, true);
  const personObservations = completed.result.output.observations.filter(item => item.facet === 'person');
  assert.equal(personObservations.length, 2);
  assert.ok(personObservations.every(item => item.rawValue === '未命名人物'));
  assert.deepEqual(completed.result.output.highImpactClaims, []);
});

test('person matching guard fails closed when any routed image lacks person consent', async t => {
  const value = await fixture(t);
  const imageId = value.built.envelope.contents.find(item => item.modality === 'image').evidenceId;
  const { guardDigest: _guardDigest, ...guardInput } = value.guard;
  assert.throws(() => buildTrustedLabGuardSnapshot({
    ...guardInput,
    allowPersonMatching: true,
    personMatchingEvidenceIds: [imageId]
  }), /PERSON_CONSENT_MISSING/);
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

test('direct Stage A execution preserves bounded provider schema diagnostics for the worker bridge', async t => {
  const value = await fixture(t);
  const calls = [];
  const factory = new StageALabExecutorFactory({
    profile: value.executionProfile,
    provider: 'qwen',
    model: value.model,
    inputCnyPerMillion: 0,
    outputCnyPerMillion: 0,
    placeKindPolicy: placePolicy(value.built.envelope.taxonomyVersion),
    transport: transportFor(value.model, calls, ({ photoId }) => ({
      observations: [{
        photoId,
        people: [], mentions: [], times: [],
        places: [{
          label: '北京',
          'canonical?': '北京市',
          supports: [{ photoId, source: 'visual', quote: '画面可见北京' }]
        }],
        events: [], scenes: [],
        unknownFacets: ['person', 'time', 'event', 'scene'],
        conflicts: []
      }]
    }))
  });
  const pending = await submitLabExecutionJob(value.input, value.store, clock);
  const context = {
    job: pending,
    signal: new AbortController().signal,
    clock,
    getGuard: async () => structuredClone(value.guard),
    readAsset: async () => new Uint8Array(png)
  };
  const executor = factory.create(value.executionProfile, context);

  await assert.rejects(
    () => executor.execute(context),
    error => error.message === 'INVALID_OUTPUT'
      && error.diagnostic?.phase === 'schema'
      && error.diagnostic.issues.some(issue => (
        issue.path === 'observations.0.places.0'
          && issue.code === 'unrecognized_keys'
          && issue.keys.includes('canonical?')
      ))
  );
  assert.equal(calls.length, 1);
});

test('direct Stage A execution quarantines an ungrounded assertion and preserves a safe review code', async t => {
  const value = await fixture(t);
  const calls = [];
  const factory = new StageALabExecutorFactory({
    profile: value.executionProfile,
    provider: 'qwen',
    model: value.model,
    inputCnyPerMillion: 0,
    outputCnyPerMillion: 0,
    placeKindPolicy: placePolicy(value.built.envelope.taxonomyVersion),
    transport: transportFor(value.model, calls, ({ photoId }) => ({
      observations: [{
        photoId,
        people: [], mentions: [], times: [], places: [],
        events: [{
          type: '家庭聚会',
          supports: [{ photoId, source: 'user_text', quote: '模型改写后不存在于原文的引文' }]
        }],
        scenes: [], unknownFacets: ['person', 'time', 'place', 'scene'], conflicts: []
      }]
    }))
  });
  const pending = await submitLabExecutionJob(value.input, value.store, clock);
  const context = {
    job: pending,
    signal: new AbortController().signal,
    clock,
    getGuard: async () => structuredClone(value.guard),
    readAsset: async () => new Uint8Array(png)
  };

  const outcome = await factory.create(value.executionProfile, context).execute(context);
  assert.equal(outcome.result.workflowStatus, 'needs_review');
  assert.ok(outcome.result.output.organization.reviewItems.some(item =>
    item.startsWith('UNSUPPORTED_MODEL_SUPPORT_DROPPED:')));
  assert.equal(outcome.result.output.observations.some(item =>
    item.facet === 'event' && item.normalizedValue === '家庭聚会'), false);
  assert.equal(calls.length, 1);
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
