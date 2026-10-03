import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const build = process.env.CLASSIFICATION_BUILD_DIR;
const { buildLabSubmission } = require(`${build}/src/lib/algorithms/classification/lab-contract.js`);
const {
  LAB_EXECUTION_RESULT_VERSION,
  buildTrustedLabGuardSnapshot,
  validateLabExecutionResultAgainstEnvelope,
} = require(`${build}/src/lib/algorithms/classification/lab-execution-contract.js`);
const { FileTrustedLabGuardStore } = require(`${build}/src/lib/algorithms/classification/lab-execution-guard-store.js`);
const { FileClassificationLabV2Store } = require(`${build}/src/lib/algorithms/classification/lab-execution-store.js`);
const { submitLabExecutionJob } = require(`${build}/src/lib/algorithms/classification/lab-execution.js`);
const { DeterministicLabProvider } = require(`${build}/src/lib/algorithms/classification/lab-provider.js`);
const { FileHistoricalRetrievalAdapter } = require(`${build}/src/lib/algorithms/classification/historical-retrieval.js`);
const {
  FileRealCallBudgetGate,
  REAL_CALL_AUTHORIZATION_VERSION,
} = require(`${build}/src/lib/algorithms/classification/real-call-budget.js`);
const { FileClassificationT1SessionStore } = require(`${build}/src/lib/algorithms/classification/t1-session-store.js`);
const {
  ClassificationWorkerControlPlane,
  WORKER_CONTROL_PLANE_VERSION,
  WORKER_PIPELINE_RESULT_VERSION,
} = require(`${build}/src/lib/algorithms/classification/worker-control-plane.js`);

const FIXED_NOW = Date.parse('2026-10-03T05:00:00.000Z');

function png(index, width = 4, height = 3) {
  const bytes = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(index, 24);
  return bytes;
}

function submission(index, patch = {}) {
  return {
    scope: { householdId: 'house_t1', subjectId: 'elder_t1' },
    actorId: 'daughter_t1',
    contextKind: 'album_upload',
    recipientIds: [],
    images: [{ filename: `round-${index}.png`, mimeType: 'image/png', bytes: png(index) }],
    userText: `第${index}轮家庭照片`,
    userTextTargetIndexes: [0],
    finalAsrTargetIndexes: null,
    submittedAt: `2026-10-03T05:0${index}:00.000Z`,
    ...patch,
  };
}

function profile() {
  return {
    providerMode: 'deterministic',
    providerVersion: 'classification-lab-deterministic.1',
    modelVersion: 'none',
    promptVersion: 'none',
    guardVersion: 'classification-lab-guard.1',
    adapterVersion: 'classification-lab-adapter.1',
    taxonomyVersion: 'classification-lab-taxonomy.1',
    placeKindPolicyDigest: `sha256:${'1'.repeat(64)}`,
    scorerVersion: 'classification-semantic-score.2',
    configDigest: `sha256:${'2'.repeat(64)}`,
  };
}

function realProfile() {
  return {
    providerMode: 'stage_a_real',
    providerVersion: 'qwen:qwen3.7-flash-2026-07-15:sgx-five-facets.16:stage-a-validation.2',
    modelVersion: 'qwen3.7-flash-2026-07-15',
    promptVersion: 'sgx-five-facets.16',
    guardVersion: 'classification-lab-guard.1',
    adapterVersion: 'classification-lab-stage-a-composition.1',
    taxonomyVersion: 'classification-lab-taxonomy.1',
    placeKindPolicyDigest: `sha256:${'3'.repeat(64)}`,
    scorerVersion: 'classification-semantic-score.2',
    configDigest: `sha256:${'4'.repeat(64)}`,
  };
}

function realAuthorization() {
  return {
    version: REAL_CALL_AUTHORIZATION_VERSION,
    authorizationId: 'sgx_internal_t1_20261003',
    providerVersion: realProfile().providerVersion,
    modelVersion: realProfile().modelVersion,
    caps: { maxRequests: 150, maxCostCny: 25, maxRetries: 0 },
    openingUsage: { requests: 81, costCny: 0.745861, sourceRefs: ['campaign-ledgers:r5-r9b'] },
    allowPersonMatching: true,
    expiresAt: '2026-10-10T00:00:00.000Z',
    authorizationEvidenceRef: 'user-approved-150-requests-25-cny-20261003',
  };
}

function guard(built, contextRevision) {
  const imageIds = built.envelope.contents.filter(value => value.modality === 'image').map(value => value.evidenceId);
  return buildTrustedLabGuardSnapshot({
    scope: built.envelope.scope,
    actorId: built.envelope.actorId,
    authorityRef: 'classification_t1_test_authority',
    purposes: ['classification', 'album_organization', 'search_candidate', 'interview_candidate'],
    authorizationRevision: built.envelope.authorizationRevision,
    contextRevision,
    active: true,
    allowedConsentRefs: [...new Set(built.envelope.evidence.map(value => value.consentRef))],
    allowedCorrectionIds: [],
    allowPersonMatching: true,
    personMatchingEvidenceIds: imageIds,
    evidence: built.envelope.evidence.map(value => ({
      evidenceId: value.evidenceId,
      revision: value.revision,
      sourceHash: value.sourceHash,
      consentRef: value.consentRef,
      ...(imageIds.includes(value.evidenceId) ? { personConsentRef: `person_consent_${value.evidenceId}` } : {}),
      lifecycleState: 'active',
    })),
  });
}

function worker(profileValue) {
  return {
    protocolVersion: WORKER_CONTROL_PLANE_VERSION,
    requestId: 'lease_request_1',
    workerId: 'worker_t1',
    maxJobs: 1,
    versions: {
      gitCommit: 'abcdef0',
      contractVersion: 'classification-ingestion.2',
      providerVersion: profileValue.providerVersion,
      promptVersion: profileValue.promptVersion,
      guardVersion: profileValue.guardVersion,
      adapterVersion: profileValue.adapterVersion,
      taxonomyVersion: profileValue.taxonomyVersion,
      ocrVersion: 'rapidocr_test',
      embeddingVersion: 'embedding_test',
    },
    capabilities: {
      modalities: ['image', 'user_text', 'final_asr'],
      features: ['hash', 'ocr', 'image_embedding', 'text_embedding', 'vlm_extract', 'vlm_relate', 'story_summary'],
      maxImagesPerJob: 20,
      personMatchingEnabled: true,
    },
  };
}

function identity(lease, workerId = 'worker_t1') {
  return {
    workerId,
    jobId: lease.jobId,
    runId: lease.runId,
    leaseToken: lease.leaseToken,
    jobRevision: lease.jobRevision,
    attemptRevision: lease.attemptRevision,
    authorizationRevision: lease.authorizationRevision,
    inputHash: lease.inputHash,
    executionProfileDigest: lease.executionProfileDigest,
  };
}

async function submit({ built, root, store, guardStore, clock, contextRevision, profileValue = profile() }) {
  const trusted = guard(built, contextRevision);
  const record = await submitLabExecutionJob({
    built,
    profile: profileValue,
    guard: trusted,
    semanticContext: {
      version: 'classification-lab-semantic-context.1',
      referenceDate: '2026-10-03',
      timeZone: 'Asia/Shanghai',
      relativeTimePolicyVersion: 'relative-time.1',
    },
    budgetPolicy: {
      maxRequests: 8,
      maxInputTokens: 100000,
      maxOutputTokens: 4096,
      maxCostCny: 5,
      maxCandidatesPerContent: 8,
      maxCallDurationMs: 60000,
    },
    attemptRevision: 1,
    deadlineAt: new Date(clock.value + 10 * 60_000).toISOString(),
  }, store, { nowMs: () => clock.value, setTimeout, clearTimeout });
  await guardStore.put(record.jobId, trusted);
  return record;
}

function featureBundle(record, built, vector = [1, 0]) {
  return {
    schemaVersion: 'classification-worker-feature-bundle.1',
    generatedAt: new Date(FIXED_NOW).toISOString(),
    jobId: record.jobId,
    runId: record.runId,
    scope: record.envelope.scope,
    authorizationRevision: record.authorization.authorizationRevision,
    inputHash: record.contentDigest,
    executionProfileDigest: record.executionProfile.configDigest,
    versions: worker(profile()).versions,
    evidence: built.envelope.contents.map(content => {
      const evidence = built.envelope.evidence.find(value => value.evidenceId === content.evidenceId);
      const common = {
        evidenceId: content.evidenceId,
        contentId: content.contentId,
        modality: content.modality,
        revision: evidence.revision,
        sourceHash: evidence.sourceHash,
      };
      if(content.modality === 'image') return {
        ...common,
        features: {
          imageEmbedding: {
            sourceSha256: evidence.sourceHash.slice(7),
            sourceByteLength: evidence.byteLength,
            modelId: 'damo/multi-modal_clip-vit-base-patch16_zh',
            modelRevision: 'embedding_rev_1',
            dimensions: 2,
            normalized: true,
            vector,
          },
          faceEmbeddings: {
            sourceSha256: evidence.sourceHash.slice(7),
            sourceByteLength: evidence.byteLength,
            detectorModelId: 'yunet_test',
            detectorModelRevision: 'yunet_rev_1',
            embeddingModelId: 'opencv-zoo/face_recognition_sface_2021dec',
            embeddingModelRevision: 'sface_rev_1',
            dimensions: 2,
            normalized: true,
            faces: [{
              faceId: `face_${String(vector[0] === 1 ? 'a' : 'b').repeat(32)}`,
              bounds: { x: 1, y: 1, width: 2, height: 2 },
              vector,
            }],
          },
        },
      };
      return {
        ...common,
        features: {
          textEmbedding: {
            sourceSha256: evidence.sourceHash.slice(7),
            sourceByteLength: evidence.byteLength,
            modelId: 'damo/multi-modal_clip-vit-base-patch16_zh',
            modelRevision: 'embedding_rev_1',
            dimensions: 2,
            normalized: true,
            vector,
          },
        },
      };
    }),
    componentErrors: [],
  };
}

async function classificationResult(record) {
  const output = await new DeterministicLabProvider().run(record.envelope, {
    textByEvidenceId: record.originalTextByEvidenceId,
  });
  return {
    version: LAB_EXECUTION_RESULT_VERSION,
    workflowStatus: 'succeeded',
    profile: record.executionProfile,
    output,
  };
}

async function preparedCompletion({ control, lease, record, built, clock, requestId }) {
  const classification = await classificationResult(record);
  const pipeline = {
    schemaVersion: WORKER_PIPELINE_RESULT_VERSION,
    generatedAt: new Date(clock.value).toISOString(),
    jobId: lease.jobId,
    runId: lease.runId,
    scope: lease.scope,
    authorizationRevision: lease.authorizationRevision,
    inputHash: lease.inputHash,
    executionProfileDigest: lease.executionProfileDigest,
    versions: worker(profile()).versions,
    featureBundle: featureBundle(record, built, [1, 0]),
    derivedFeatures: {},
    classification,
  };
  const resultBytes = Buffer.from(JSON.stringify(pipeline));
  const uploadUrl = new URL(lease.resultUpload.uploadUrl);
  const uploaded = await control.uploadResult({
    jobId: lease.jobId,
    artifactId: lease.resultUpload.artifactId,
    uploadToken: uploadUrl.searchParams.get('token'),
    bytes: resultBytes,
    mimeType: 'application/json',
  });
  return {
    protocolVersion: WORKER_CONTROL_PLANE_VERSION,
    requestId,
    identity: identity(lease),
    status: 'succeeded',
    versions: worker(profile()).versions,
    resultArtifact: {
      artifactId: lease.resultUpload.artifactId,
      sha256: uploaded.sha256,
      byteLength: uploaded.byteLength,
      mimeType: 'application/json',
    },
    usage: {
      endToEndLatencyMs: 1200,
      providerLatencyMs: 800,
      inputTokens: 120,
      outputTokens: 80,
      costCny: 0.01,
      providerCalls: 1,
    },
  };
}

test('T1 session keeps authorization stable across rounds and blocks revoked sessions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-t1-session.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new FileClassificationT1SessionStore(root, () => FIXED_NOW);
  const created = await sessions.create({
    scope: { householdId: 'house_t1', subjectId: 'elder_t1' },
    actorId: 'daughter_t1',
  });
  const first = await sessions.reserveRound({ sessionId: created.sessionId, scope: created.scope, actorId: created.actorId });
  const second = await sessions.reserveRound({ sessionId: created.sessionId, scope: created.scope, actorId: created.actorId });
  assert.equal(first.round, 1);
  assert.equal(second.round, 2);
  assert.equal(first.session.authorizationRevision, second.session.authorizationRevision);
  const builtA = buildLabSubmission(submission(1), {
    consentRef: created.consentRef,
    authorizationRevision: created.authorizationRevision,
  });
  const builtB = buildLabSubmission(submission(2), {
    consentRef: created.consentRef,
    authorizationRevision: created.authorizationRevision,
  });
  assert.equal(builtA.envelope.authorizationRevision, builtB.envelope.authorizationRevision);
  await sessions.revoke(created.sessionId);
  await assert.rejects(
    sessions.reserveRound({ sessionId: created.sessionId, scope: created.scope, actorId: created.actorId }),
    /T1_SESSION_REVOKED/,
  );
});

test('reference control plane leases, fences, persists result and enables cross-round retrieval', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-worker-control.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = { value: FIXED_NOW };
  const store = new FileClassificationLabV2Store(root);
  const guardStore = new FileTrustedLabGuardStore(root);
  const control = new ClassificationWorkerControlPlane({
    dataRoot: root,
    publicBaseUrl: 'http://127.0.0.1:3137',
    store,
    guardStore,
    clock: { nowMs: () => clock.value },
  });
  const authorizationRevision = 't1_auth_shared_rounds';
  const consentRef = 't1_consent_shared_rounds';
  const firstBuilt = buildLabSubmission(submission(1), { authorizationRevision, consentRef });
  const firstRecord = await submit({
    built: firstBuilt,
    root,
    store,
    guardStore,
    clock,
    contextRevision: 't1_context_round_1',
  });

  const leaseResponse = await control.lease(worker(profile()));
  assert.equal(leaseResponse.leases.length, 1);
  const firstLease = leaseResponse.leases[0];
  assert.equal(firstLease.jobId, firstRecord.jobId);
  assert.equal(firstLease.evidence.length, 2);
  assert.equal((await store.get(firstRecord.jobId)).status, 'processing');

  const imageLease = firstLease.evidence.find(value => value.modality === 'image');
  const imageUrl = new URL(imageLease.artifact.downloadUrl);
  const downloaded = await control.readArtifact(firstLease.jobId, imageLease.evidenceId, imageUrl.searchParams.get('token'));
  assert.deepEqual(downloaded.bytes, firstBuilt.assets.find(value => value.evidenceId === imageLease.evidenceId).bytes);
  await assert.rejects(
    control.readArtifact(firstLease.jobId, imageLease.evidenceId, 'x'.repeat(64)),
    /ARTIFACT_TOKEN_INVALID/,
  );

  const context = await control.executionContext(firstLease.jobId, {
    protocolVersion: WORKER_CONTROL_PLANE_VERSION,
    requestId: 'context_request_1',
    identity: identity(firstLease),
  });
  assert.equal(context.execution.guard.allowPersonMatching, true);
  assert.equal(context.binding.authorizationRevision, authorizationRevision);

  const firstClassification = await classificationResult(await store.get(firstRecord.jobId));
  const firstImageContent = firstBuilt.envelope.contents.find(value => value.modality === 'image');
  const firstTextContent = firstBuilt.envelope.contents.find(value => value.modality === 'user_text');
  firstClassification.output.observations.push({
    contentId: firstImageContent.contentId,
    evidenceId: firstTextContent.evidenceId,
    facet: 'event',
    rawValue: '家庭照片',
    normalizedValue: '家庭照片',
    supports: [{
      evidenceId: firstTextContent.evidenceId,
      sourceType: 'user_text',
      quote: '第1轮家庭照片',
    }],
    state: 'candidate',
  });
  const foreignObservation = structuredClone(firstClassification);
  foreignObservation.output.observations.at(-1).evidenceId = 'evidence_not_bound';
  foreignObservation.output.observations.at(-1).supports = [{
    evidenceId: 'evidence_not_bound',
    sourceType: 'user_text',
    quote: '第1轮家庭照片',
  }];
  assert.throws(
    () => validateLabExecutionResultAgainstEnvelope(
      foreignObservation,
      firstRecord.envelope,
      firstRecord.executionProfile,
    ),
    /FOREIGN_RESULT_OBSERVATION/,
  );
  const firstPipeline = {
    schemaVersion: WORKER_PIPELINE_RESULT_VERSION,
    generatedAt: new Date(clock.value).toISOString(),
    jobId: firstLease.jobId,
    runId: firstLease.runId,
    scope: firstLease.scope,
    authorizationRevision,
    inputHash: firstLease.inputHash,
    executionProfileDigest: firstLease.executionProfileDigest,
    versions: worker(profile()).versions,
    featureBundle: featureBundle(await store.get(firstRecord.jobId), firstBuilt, [1, 0]),
    derivedFeatures: {},
    classification: firstClassification,
  };
  const resultBytes = Buffer.from(JSON.stringify(firstPipeline));
  const uploadUrl = new URL(firstLease.resultUpload.uploadUrl);
  const uploaded = await control.uploadResult({
    jobId: firstLease.jobId,
    artifactId: firstLease.resultUpload.artifactId,
    uploadToken: uploadUrl.searchParams.get('token'),
    bytes: resultBytes,
    mimeType: 'application/json',
  });
  const completed = await control.complete(firstLease.jobId, {
    protocolVersion: WORKER_CONTROL_PLANE_VERSION,
    requestId: 'complete_request_1',
    identity: identity(firstLease),
    status: 'succeeded',
    versions: worker(profile()).versions,
    resultArtifact: {
      artifactId: firstLease.resultUpload.artifactId,
      sha256: uploaded.sha256,
      byteLength: uploaded.byteLength,
      mimeType: 'application/json',
    },
    usage: {
      endToEndLatencyMs: 1200,
      providerLatencyMs: 800,
      inputTokens: 120,
      outputTokens: 80,
      costCny: 0.01,
      providerCalls: 1,
    },
  });
  assert.equal(completed.accepted, true);
  assert.equal(completed.historicalRecordsUpserted, 2, 'semantic and consented face vectors should both be indexed');
  assert.equal((await store.get(firstRecord.jobId)).status, 'succeeded');

  clock.value += 60_000;
  const secondBuilt = buildLabSubmission(submission(2), { authorizationRevision, consentRef });
  const secondRecord = await submit({
    built: secondBuilt,
    root,
    store,
    guardStore,
    clock,
    contextRevision: 't1_context_round_2',
  });
  const secondLease = (await control.lease({ ...worker(profile()), requestId: 'lease_request_2' })).leases[0];
  assert.equal(secondLease.jobId, secondRecord.jobId);
  const secondImage = secondBuilt.envelope.contents.find(value => value.modality === 'image');
  const semantic = await control.historicalQuery(secondLease.jobId, {
    protocolVersion: 'classification-worker-control-plane.v1',
    requestId: 'historical_request_2',
    identity: identity(secondLease),
    query: {
      schemaVersion: '2.0',
      contractVersion: 'classification-historical-retrieval.2',
      scope: secondLease.scope,
      authorizationRevision,
      sources: [{
        sourceContentId: secondImage.contentId,
        sourceEvidenceId: secondImage.evidenceId,
        kind: 'image_text_embedding',
        modelId: 'damo/multi-modal_clip-vit-base-patch16_zh',
        modelRevision: 'embedding_rev_1',
        dimensions: 2,
        normalized: true,
        vector: [1, 0],
      }],
      maxCandidatesPerSource: 8,
      excludeEvidenceIds: secondLease.evidence.map(value => value.evidenceId),
    },
  });
  assert.equal(semantic.candidates.length, 1);
  assert.equal(semantic.candidates[0].historicalEvidenceId, firstBuilt.envelope.contents.find(value => value.modality === 'image').evidenceId);
  assert.equal(Object.hasOwn(semantic.candidates[0], 'similarity'), false);

  const stale = identity(secondLease);
  stale.authorizationRevision = 't1_auth_other';
  await assert.rejects(
    control.executionContext(secondLease.jobId, {
      protocolVersion: WORKER_CONTROL_PLANE_VERSION,
      requestId: 'context_request_stale',
      identity: stale,
    }),
    /LEASE_IDENTITY_MISMATCH/,
  );
});

test('history index failure cannot expose a false terminal success', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-worker-history-failure.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = { value: FIXED_NOW };
  const store = new FileClassificationLabV2Store(root);
  const guardStore = new FileTrustedLabGuardStore(root);
  const historical = new FileHistoricalRetrievalAdapter(path.join(root, 'failing-history'));
  historical.upsert = async () => { throw new Error('simulated history storage failure'); };
  const control = new ClassificationWorkerControlPlane({
    dataRoot: root,
    publicBaseUrl: 'http://127.0.0.1:3137',
    store,
    guardStore,
    historical,
    clock: { nowMs: () => clock.value },
  });
  const built = buildLabSubmission(submission(3), {
    authorizationRevision: 't1_auth_history_failure',
    consentRef: 't1_consent_history_failure',
  });
  const record = await submit({
    built,
    root,
    store,
    guardStore,
    clock,
    contextRevision: 't1_context_history_failure',
  });
  const lease = (await control.lease(worker(profile()))).leases[0];
  const completeRequest = await preparedCompletion({
    control,
    lease,
    record: await store.get(record.jobId),
    built,
    clock,
    requestId: 'complete_history_failure',
  });

  await assert.rejects(control.complete(lease.jobId, completeRequest), /HISTORY_INDEX_FAILED/);
  const failed = await store.get(record.jobId);
  assert.equal(failed.status, 'failed_retryable');
  assert.equal(failed.error.code, 'HISTORY_INDEX_FAILED');
  assert.equal(failed.result, undefined);
  assert.equal(failed.resultDigest, undefined);
});

test('real worker lease requires and settles the shared user-authorized budget', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-worker-real-budget.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = { value: FIXED_NOW };
  const store = new FileClassificationLabV2Store(root);
  const guardStore = new FileTrustedLabGuardStore(root);
  const built = buildLabSubmission(submission(4), {
    authorizationRevision: 't1_auth_real_budget',
    consentRef: 't1_consent_real_budget',
  });
  const record = await submit({
    built,
    root,
    store,
    guardStore,
    clock,
    contextRevision: 't1_context_real_budget',
    profileValue: realProfile(),
  });
  const ungated = new ClassificationWorkerControlPlane({
    dataRoot: root,
    publicBaseUrl: 'http://127.0.0.1:3137',
    store,
    guardStore,
    clock: { nowMs: () => clock.value },
  });
  await assert.rejects(ungated.lease(worker(realProfile())), /REAL_CALL_AUTHORIZATION_NOT_CONFIGURED/);
  assert.equal((await store.get(record.jobId)).status, 'pending');

  const budget = new FileRealCallBudgetGate({
    dataRoot: root,
    authorization: realAuthorization(),
    nowMs: () => clock.value,
  });
  const gated = new ClassificationWorkerControlPlane({
    dataRoot: root,
    publicBaseUrl: 'http://127.0.0.1:3137',
    store,
    guardStore,
    realCallBudget: budget,
    clock: { nowMs: () => clock.value },
  });
  const lease = (await gated.lease(worker(realProfile()))).leases[0];
  assert.equal(lease.jobId, record.jobId);
  assert.equal((await budget.readStatus()).used.requests, 89, 'the job budget reserves eight possible calls');
  const failed = await gated.fail(lease.jobId, {
    protocolVersion: WORKER_CONTROL_PLANE_VERSION,
    requestId: 'fail_real_before_provider',
    identity: identity(lease),
    errorCode: 'DOWNLOAD_FAILED',
    stage: 'downloading',
    retryable: false,
    providerCalled: false,
    usage: {
      endToEndLatencyMs: 20,
      providerLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costCny: 0,
      providerCalls: 0,
    },
  });
  assert.deepEqual(failed.realCallBudget.used, { requests: 81, costCny: 0.745861 });
  assert.equal((await store.get(record.jobId)).status, 'failed_retryable');
});
