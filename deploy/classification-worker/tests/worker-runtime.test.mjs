import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LocalFeatureBundleProcessor,
  PROTOCOL_VERSION,
  WorkerRuntime,
  writeDownloadedFile,
} from '../runtime/worker-runtime.mjs';
import {
  HttpControlPlaneClient,
  LocalFeatureServiceClient,
  requireRuntimeEnvironment,
} from '../runtime/http-clients.mjs';
import {
  EXECUTION_CONTEXT_VERSION,
  PIPELINE_RESULT_VERSION,
  StageAPipelineProcessor,
  SubprocessStageABridge,
} from '../runtime/pipeline-processor.mjs';

const require = createRequire(import.meta.url);

const FIXED_NOW = Date.parse('2026-10-02T10:00:00.000Z');
const future = (minutes) => new Date(FIXED_NOW + minutes * 60_000).toISOString();
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function runtimeEnvironment() {
  const persistent = '/gemini/code/sgx-classification';
  const cache = `${persistent}/shared/cache`;
  const runtime = '/quota/sgx-classification';
  return {
    SGX_WORKER_ID: 'worker-test',
    SGX_CONTROL_PLANE_BASE_URL: 'https://control.example.test',
    SGX_CONTROL_PLANE_TOKEN: 'injected-test-token',
    SGX_GIT_COMMIT: 'a'.repeat(40),
    SGX_EXECUTION_PROFILE_DIGEST: `sha256:${'b'.repeat(64)}`,
    SGX_DEPLOY_ROOT: persistent,
    SGX_RUNTIME_ROOT: runtime,
    SGX_MODEL_ROOT: `${persistent}/shared/models`,
    SGX_WHEELHOUSE_ROOT: `${persistent}/shared/wheelhouse`,
    SGX_DOWNLOAD_ROOT: `${persistent}/shared/downloads`,
    SGX_MODEL_CACHE_ROOT: cache,
    HF_HOME: `${cache}/huggingface`,
    HF_HUB_CACHE: `${cache}/huggingface/hub`,
    HUGGINGFACE_HUB_CACHE: `${cache}/huggingface/hub`,
    TRANSFORMERS_CACHE: `${cache}/huggingface/transformers`,
    MODELSCOPE_CACHE: `${cache}/modelscope`,
    SGX_ONNX_CACHE: `${cache}/onnx`,
    TORCH_HOME: `${cache}/torch`,
    PIP_CACHE_DIR: `${cache}/pip`,
    UV_CACHE_DIR: `${cache}/uv`,
    XDG_CACHE_HOME: `${cache}/xdg`,
    VIRTUALENV_OVERRIDE_APP_DATA: `${cache}/virtualenv`,
    SGX_RUNTIME_CACHE_ROOT: `${runtime}/cache`,
    SGX_COMPILED_CACHE_ROOT: `${runtime}/cache/compiled`,
    SGX_PERSISTENCE_POLICY_VERSION: 'classification-download-persistence.1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    SGX_ALLOW_MODEL_DOWNLOADS: 'false',
  };
}

const versions = {
  gitCommit: '1e162e0',
  contractVersion: 'classification-ingestion-v2.0.0',
  providerVersion: 'stage-a-provider.1',
  promptVersion: 'sgx-five-facets.16',
  guardVersion: 'stage-a-guard.1',
  adapterVersion: 'cloud-worker.1',
  taxonomyVersion: 'sgx-taxonomy.1',
  ocrVersion: 'rapidocr-test.1',
  embeddingVersion: 'embedding-test.1',
};

const capabilities = {
  modalities: ['image', 'user_text', 'final_asr'],
  features: ['hash', 'ocr', 'image_embedding', 'text_embedding'],
  maxImagesPerJob: 30,
  personMatchingEnabled: false,
};

const minimalBudgetPolicy = {
  maxCandidatesPerContent: 8,
};

function makeLease({ imageBytes = Buffer.from('image-one'), text = '这是一次家庭聚会。' } = {}) {
  const imageHash = digest(imageBytes);
  const textHash = digest(Buffer.from(text, 'utf8'));
  return {
    jobId: 'job-1',
    runId: 'run-1',
    leaseToken: 'l'.repeat(32),
    leaseExpiresAt: future(5),
    jobRevision: 2,
    attemptRevision: 1,
    scope: { householdId: 'household-1', subjectId: 'subject-1' },
    authorizationRevision: 'auth-3',
    deadlineAt: future(10),
    inputHash: `sha256:${'a'.repeat(64)}`,
    executionProfileDigest: `sha256:${'b'.repeat(64)}`,
    evidence: [
      {
        evidenceId: 'evidence-image-1',
        contentId: 'content-1',
        modality: 'image',
        revision: 1,
        sourceHash: imageHash,
        lifecycleState: 'active',
        artifact: {
          artifactId: 'artifact-image-1',
          downloadUrl: 'https://objects.example.test/read/image-1',
          expiresAt: future(4),
          sha256: imageHash,
          byteLength: imageBytes.length,
          mimeType: 'image/jpeg',
        },
      },
      {
        evidenceId: 'evidence-text-1',
        contentId: 'content-text-1',
        modality: 'user_text',
        revision: 1,
        sourceHash: textHash,
        lifecycleState: 'active',
        inlineText: { text, sha256: textHash },
      },
    ],
    resultUpload: {
      artifactId: 'artifact-result-1',
      uploadUrl: 'https://objects.example.test/write/result-1',
      expiresAt: future(9),
      maxByteLength: 1_048_576,
      mimeType: 'application/json',
    },
  };
}

function envelopeForLease(lease, targetsByTextContentId = {}) {
  const imageContentIds = lease.evidence
    .filter((item) => item.modality === 'image')
    .map((item) => item.contentId);
  const contents = lease.evidence.map((item) => ({
    contentId: item.contentId,
    evidenceId: item.evidenceId,
    modality: item.modality,
    lifecycleState: 'active',
  }));
  const bindings = lease.evidence
    .filter((item) => item.modality === 'user_text' || item.modality === 'final_asr')
    .map((item, index) => ({
      bindingId: `binding-${index + 1}`,
      sourceContentId: item.contentId,
      target: {
        kind: 'contents',
        contentIds: targetsByTextContentId[item.contentId] ?? imageContentIds.slice(0, 1),
      },
      authority: 'user_explicit',
      state: 'active',
    }));
  return { contents, bindings };
}

function identityFor(lease, workerId = 'virtai-worker-1') {
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

function contextBinding(lease) {
  return {
    jobId: lease.jobId,
    runId: lease.runId,
    jobRevision: lease.jobRevision,
    attemptRevision: lease.attemptRevision,
    scope: lease.scope,
    authorizationRevision: lease.authorizationRevision,
    inputHash: lease.inputHash,
    executionProfileDigest: lease.executionProfileDigest,
  };
}

function personGuardForLease(lease, personMatchingEvidenceIds = []) {
  const authorized = new Set(personMatchingEvidenceIds);
  return {
    scope: lease.scope,
    actorId: 'actor-test',
    authorityRef: 'authority-test',
    purposes: ['classification', 'album_organization'],
    authorizationRevision: lease.authorizationRevision,
    contextRevision: 'context-test-1',
    active: true,
    allowedConsentRefs: lease.evidence.map((item) => `consent-${item.evidenceId}`),
    allowedCorrectionIds: [],
    allowPersonMatching: authorized.size > 0,
    personMatchingEvidenceIds: [...authorized],
    evidence: lease.evidence.map((item) => ({
      evidenceId: item.evidenceId,
      revision: item.revision,
      sourceHash: item.sourceHash,
      consentRef: `consent-${item.evidenceId}`,
      ...(authorized.has(item.evidenceId) ? { personConsentRef: `person-consent-${item.evidenceId}` } : {}),
      lifecycleState: item.lifecycleState,
    })),
  };
}

function historicalCandidate(source, { suffix = '1', faceSuffix = 'd' } = {}) {
  const historicalContentId = `historical-content-${suffix}`;
  const historicalEvidenceId = `historical-evidence-${suffix}`;
  return {
    candidateId: `historical-candidate-${suffix}`,
    sourceContentId: source.sourceContentId,
    sourceEvidenceId: source.sourceEvidenceId,
    ...(source.sourceFaceId ? { sourceFaceId: source.sourceFaceId } : {}),
    historicalContentId,
    historicalEvidenceId,
    kind: source.kind,
    rank: 1,
    modelId: source.modelId,
    modelRevision: source.modelRevision,
    reasons: source.kind === 'face_embedding'
      ? ['anonymous_person_candidate', 'historical_projection_authorized']
      : ['semantic_neighbor', 'historical_projection_authorized'],
    featureRefs: [`historical-feature-${suffix}`],
    evidenceRefs: [source.sourceEvidenceId, historicalEvidenceId],
    historicalProjection: {
      contentId: historicalContentId,
      evidenceId: historicalEvidenceId,
      evidenceRevision: 1,
      sourceHash: digest(Buffer.from(`historical-${suffix}`)),
      artifactId: `historical-artifact-${suffix}`,
      mimeType: 'image/jpeg',
      byteLength: 128,
      consentRef: `historical-consent-${suffix}`,
      ...(source.kind === 'face_embedding' ? {
        personConsentRef: `historical-person-consent-${suffix}`,
        faceId: `face_${faceSuffix.repeat(32)}`,
      } : {}),
      confirmedReferenceIds: [],
      lifecycleState: 'active',
    },
  };
}

function historicalResult(request, candidates = []) {
  return {
    schemaVersion: '2.0',
    contractVersion: 'classification-historical-retrieval.2',
    scope: request.scope,
    authorizationRevision: request.authorizationRevision,
    candidates,
    traces: request.sources.map((source) => ({
      sourceContentId: source.sourceContentId,
      sourceEvidenceId: source.sourceEvidenceId,
      ...(source.sourceFaceId ? { sourceFaceId: source.sourceFaceId } : {}),
      kind: source.kind,
      eligibleCount: candidates.filter((item) => (
        item.sourceEvidenceId === source.sourceEvidenceId
          && item.kind === source.kind
          && (item.sourceFaceId ?? '') === (source.sourceFaceId ?? '')
      )).length,
      selectedCandidateIds: candidates.filter((item) => (
        item.sourceEvidenceId === source.sourceEvidenceId
          && item.kind === source.kind
          && (item.sourceFaceId ?? '') === (source.sourceFaceId ?? '')
      )).map((item) => item.candidateId),
      coverage: 'complete',
    })),
    scoreMeaning: 'retrieval_order_not_probability',
  };
}

class FakeControlPlane {
  constructor({ leases, controls = [], completeError = null }) {
    this.leases = leases;
    this.controls = [...controls];
    this.completeError = completeError;
    this.requests = { lease: [], heartbeat: [], complete: [], fail: [], cancelAck: [] };
  }

  async lease(request) {
    this.requests.lease.push(request);
    return { protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, leases: this.leases };
  }

  async heartbeat(jobId, request) {
    this.requests.heartbeat.push({ jobId, request });
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      leaseExpiresAt: future(5),
      control: this.controls.shift() ?? 'continue',
    };
  }

  async complete(jobId, request) {
    this.requests.complete.push({ jobId, request });
    if (this.completeError) throw this.completeError;
    return { accepted: true };
  }

  async fail(jobId, request) {
    this.requests.fail.push({ jobId, request });
    return { accepted: true };
  }

  async cancelAck(jobId, request) {
    this.requests.cancelAck.push({ jobId, request });
    return { accepted: true };
  }
}

class FakeArtifacts {
  constructor(entries = {}) {
    this.entries = entries;
    this.downloads = [];
    this.uploads = [];
    this.downloadError = null;
  }

  async downloadToFile({ url, destination, maxByteLength }) {
    this.downloads.push({ url, destination });
    if (this.downloadError) throw this.downloadError;
    const bytes = this.entries[url];
    assert.ok(bytes, `missing fake artifact for ${url}`);
    return writeDownloadedFile(destination, [bytes], maxByteLength);
  }

  async upload({ url, bytes, mimeType }) {
    this.uploads.push({ url, bytes: Buffer.from(bytes), mimeType });
  }
}

class FakeFeatures {
  constructor({ fail = [], embeddings = {}, ocrTextByHash = {}, faceEmbeddingsByHash = {} } = {}) {
    this.fail = new Set(fail);
    this.embeddings = embeddings;
    this.ocrTextByHash = ocrTextByHash;
    this.faceEmbeddingsByHash = faceEmbeddingsByHash;
    this.calls = [];
  }

  async #value(capability, source) {
    this.calls.push({ capability, source });
    if (this.fail.has(capability)) {
      const error = new Error(capability);
      error.code = `${capability.toUpperCase()}_FAILED`;
      throw error;
    }
    if (capability === 'ocr') {
      return {
        sourceSha256: source.sourceSha256,
        sourceByteLength: source.sourceByteLength,
        imageFormat: 'JPEG',
        imageWidth: 100,
        imageHeight: 100,
        modelId: 'rapidocr/test',
        modelVersion: 'test',
        modelRevision: 'test-revision',
        regions: this.ocrTextByHash[source.sourceSha256]
          ? [{
            text: this.ocrTextByHash[source.sourceSha256],
            bounds: { x: 0, y: 0, width: 10, height: 10 },
            modelScore: 0.99,
          }]
          : [],
      };
    }
    if (capability === 'image_embedding' || capability === 'text_embedding') {
      return {
        sourceSha256: source.sourceSha256,
        sourceByteLength: source.sourceByteLength,
        modelId: 'embedding/test',
        modelRevision: 'test-revision',
        dimensions: 2,
        normalized: true,
        vector: this.embeddings[source.sourceSha256] ?? [0.6, 0.8],
      };
    }
    if (capability === 'face_embeddings') {
      return {
        sourceSha256: source.sourceSha256,
        sourceByteLength: source.sourceByteLength,
        detectorModelId: 'face-detector/test',
        detectorModelRevision: 'test-revision',
        embeddingModelId: 'face-embedding/test',
        embeddingModelRevision: 'test-revision',
        dimensions: 2,
        normalized: true,
        faces: this.faceEmbeddingsByHash[source.sourceSha256] ?? [],
      };
    }
    return { capability, sourceSha256: source.sourceSha256 };
  }

  ocr(source) { return this.#value('ocr', source); }
  imageEmbedding(source) { return this.#value('image_embedding', source); }
  textEmbedding(source) { return this.#value('text_embedding', source); }
  faceEmbeddings(source) { return this.#value('face_embeddings', source); }
}

async function doesNotExist(target) {
  try {
    await access(target);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function fixture({
  lease = makeLease(),
  controls = [],
  featureFailures = [],
  completeError = null,
  now = () => FIXED_NOW,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-runtime.'));
  const scratchRoot = path.join(root, 'jobs');
  const controlPlane = new FakeControlPlane({ leases: [lease], controls, completeError });
  const artifacts = new FakeArtifacts({
    [lease.evidence[0]?.artifact?.downloadUrl]: Buffer.from('image-one'),
  });
  const features = new FakeFeatures({ fail: featureFailures });
  const processor = new LocalFeatureBundleProcessor({
    featureService: features,
    personMatchingEnabled: capabilities.personMatchingEnabled,
    now,
  });
  let requestNumber = 0;
  const logs = [];
  const runtime = new WorkerRuntime({
    workerId: 'virtai-worker-1',
    versions,
    capabilities,
    controlPlane,
    artifacts,
    processor,
    scratchRoot,
    executionProfileDigest: `sha256:${'b'.repeat(64)}`,
    heartbeatIntervalMs: 0,
    now,
    idFactory: () => `request-${++requestNumber}`,
    logger: {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
      error: (event, fields) => logs.push({ level: 'error', event, fields }),
    },
  });
  return { root, scratchRoot, runtime, controlPlane, artifacts, features, logs };
}

test('worker leases, heartbeats, verifies sources, calls features, uploads, completes and cleans', async (t) => {
  const fx = await fixture();
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));

  const summary = await fx.runtime.runOnce();

  assert.deepEqual(summary, { leased: 1, completed: 1, failed: 0, cancelled: 0, skipped: 0 });
  assert.equal(fx.controlPlane.requests.lease.length, 1);
  assert.equal(fx.controlPlane.requests.heartbeat.length, 4);
  assert.deepEqual(fx.features.calls.map((call) => call.capability), [
    'ocr', 'image_embedding', 'text_embedding',
  ]);
  assert.equal(fx.artifacts.downloads.length, 1);
  assert.equal(fx.artifacts.uploads.length, 1);
  assert.equal(fx.controlPlane.requests.complete.length, 1);
  assert.equal(fx.controlPlane.requests.fail.length, 0);
  assert.equal(fx.controlPlane.requests.cancelAck.length, 0);
  const uploaded = JSON.parse(fx.artifacts.uploads[0].bytes.toString('utf8'));
  assert.equal(uploaded.schemaVersion, 'classification-worker-feature-bundle.1');
  assert.equal(uploaded.evidence.length, 2);
  assert.deepEqual(uploaded.componentErrors, []);
  const complete = fx.controlPlane.requests.complete[0].request;
  assert.equal(complete.status, 'succeeded');
  assert.equal(complete.usage.providerCalls, 0);
  assert.equal(complete.identity.authorizationRevision, 'auth-3');
  assert.equal(await doesNotExist(path.join(fx.scratchRoot, 'job-1', 'run-1')), true);
});

test('component failure is preserved as needs_review when another feature succeeds', async (t) => {
  const fx = await fixture({ featureFailures: ['image_embedding'] });
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));

  const summary = await fx.runtime.runOnce();

  assert.equal(summary.completed, 1);
  assert.equal(fx.controlPlane.requests.complete[0].request.status, 'needs_review');
  const uploaded = JSON.parse(fx.artifacts.uploads[0].bytes.toString('utf8'));
  assert.deepEqual(uploaded.componentErrors, [{
    evidenceId: 'evidence-image-1',
    capability: 'image_embedding',
    errorCode: 'IMAGE_EMBEDDING_FAILED',
  }]);
});

test('artifact hash mismatch fails once without feature calls or upload and cleans scratch', async (t) => {
  const lease = makeLease();
  const fx = await fixture({ lease });
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));
  fx.artifacts.entries[lease.evidence[0].artifact.downloadUrl] = Buffer.from('image-two');

  const summary = await fx.runtime.runOnce();

  assert.equal(summary.failed, 1);
  assert.equal(fx.artifacts.downloads.length, 1);
  assert.equal(fx.features.calls.length, 0);
  assert.equal(fx.artifacts.uploads.length, 0);
  assert.equal(fx.controlPlane.requests.fail.length, 1);
  assert.equal(fx.controlPlane.requests.fail[0].request.errorCode, 'HASH_MISMATCH');
  assert.equal(fx.controlPlane.requests.fail[0].request.retryable, false);
  assert.equal(await doesNotExist(path.join(fx.scratchRoot, 'job-1', 'run-1')), true);
});

test('download failure has zero automatic retries', async (t) => {
  const fx = await fixture();
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));
  fx.artifacts.downloadError = new Error('transient');

  await fx.runtime.runOnce();

  assert.equal(fx.artifacts.downloads.length, 1);
  assert.equal(fx.controlPlane.requests.fail.length, 1);
  assert.equal(fx.controlPlane.requests.fail[0].request.errorCode, 'DOWNLOAD_FAILED');
  assert.equal(fx.controlPlane.requests.fail[0].request.retryable, false);
});

test('control-plane cancel aborts before download and acknowledges only after cleanup', async (t) => {
  const fx = await fixture({ controls: ['cancel'] });
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));

  const summary = await fx.runtime.runOnce();

  assert.equal(summary.cancelled, 1);
  assert.equal(fx.artifacts.downloads.length, 0);
  assert.equal(fx.controlPlane.requests.complete.length, 0);
  assert.equal(fx.controlPlane.requests.fail.length, 0);
  assert.equal(fx.controlPlane.requests.cancelAck.length, 1);
  assert.equal(fx.controlPlane.requests.cancelAck[0].request.reason, 'cancelled');
  assert.equal(fx.controlPlane.requests.cancelAck[0].request.temporaryFilesDeleted, true);
});

test('expired deadline is fenced locally without calling heartbeat or features', async (t) => {
  const lease = makeLease();
  lease.deadlineAt = new Date(FIXED_NOW).toISOString();
  const fx = await fixture({ lease });
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));

  const summary = await fx.runtime.runOnce();

  assert.equal(summary.cancelled, 1);
  assert.equal(fx.controlPlane.requests.heartbeat.length, 0);
  assert.equal(fx.features.calls.length, 0);
  assert.equal(fx.controlPlane.requests.cancelAck[0].request.reason, 'deadline_exceeded');
});

test('post-upload cancellation prevents a late complete', async (t) => {
  const fx = await fixture({ controls: ['continue', 'continue', 'continue', 'authorization_changed'] });
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));

  const summary = await fx.runtime.runOnce();

  assert.equal(summary.cancelled, 1);
  assert.equal(fx.artifacts.uploads.length, 1);
  assert.equal(fx.controlPlane.requests.complete.length, 0);
  assert.equal(fx.controlPlane.requests.cancelAck[0].request.reason, 'authorization_changed');
});

test('background heartbeat aborts a long-running feature call on authorization change', async (t) => {
  const fx = await fixture({ controls: ['continue', 'continue', 'authorization_changed'] });
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));
  let intervalTick;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  fx.runtime.heartbeatIntervalMs = 1_000;
  fx.runtime.setIntervalFn = (callback) => {
    intervalTick = callback;
    return Symbol('fake-timer');
  };
  fx.runtime.clearIntervalFn = () => {};
  fx.runtime.processor = {
    process: ({ signal }) => new Promise((resolve, reject) => {
      markStarted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  };

  const run = fx.runtime.runOnce();
  await started;
  intervalTick();
  const summary = await run;

  assert.equal(summary.cancelled, 1);
  assert.equal(fx.controlPlane.requests.heartbeat.length, 3);
  assert.equal(fx.artifacts.uploads.length, 0);
  assert.equal(fx.controlPlane.requests.complete.length, 0);
  assert.equal(fx.controlPlane.requests.cancelAck[0].request.reason, 'authorization_changed');
});

test('all feature failures produce one terminal failure and no result upload', async (t) => {
  const fx = await fixture({ featureFailures: ['ocr', 'image_embedding', 'text_embedding'] });
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));

  const summary = await fx.runtime.runOnce();

  assert.equal(summary.failed, 1);
  assert.equal(fx.artifacts.uploads.length, 0);
  assert.equal(fx.controlPlane.requests.fail.length, 1);
  assert.equal(fx.controlPlane.requests.fail[0].request.errorCode, 'FEATURE_SERVICE_UNAVAILABLE');
});

test('unknown completion acknowledgement does not emit a contradictory failure', async (t) => {
  const fx = await fixture({ completeError: new Error('response lost') });
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));

  const summary = await fx.runtime.runOnce();

  assert.equal(summary.failed, 1);
  assert.equal(fx.controlPlane.requests.complete.length, 1);
  assert.equal(fx.controlPlane.requests.fail.length, 0);
  assert.equal(fx.controlPlane.requests.cancelAck.length, 0);
  assert.ok(fx.logs.some((entry) => entry.event === 'terminal_state_unknown'));
});

test('same attempt is not executed twice in one worker lifetime', async (t) => {
  const fx = await fixture();
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));

  const first = await fx.runtime.runOnce();
  const second = await fx.runtime.runOnce();

  assert.equal(first.completed, 1);
  assert.equal(second.skipped, 1);
  assert.equal(fx.artifacts.downloads.length, 1);
  assert.equal(fx.controlPlane.requests.complete.length, 1);
});

test('execution-profile mismatch is rejected before source download', async (t) => {
  const lease = makeLease();
  lease.executionProfileDigest = `sha256:${'c'.repeat(64)}`;
  const fx = await fixture({ lease });
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(fx.root, { recursive: true, force: true })));

  const summary = await fx.runtime.runOnce();

  assert.equal(summary.failed, 1);
  assert.equal(fx.artifacts.downloads.length, 0);
  assert.equal(fx.controlPlane.requests.fail[0].request.errorCode, 'VERSION_MISMATCH');
});

test('HTTP control-plane client accepts empty 204 terminal response without retrying', async () => {
  const requests = [];
  const client = new HttpControlPlaneClient({
    baseUrl: 'https://control.example.test',
    token: 'injected-test-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 204 });
    },
  });

  const response = await client.complete('job-1', { test: true });

  assert.equal(response, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://control.example.test/internal/v1/classification/jobs/job-1/complete');
  assert.equal(requests[0].options.headers.authorization, 'Bearer injected-test-token');
});

test('HTTP clients reject insecure remote control plane and non-local feature service', () => {
  assert.throws(
    () => new HttpControlPlaneClient({ baseUrl: 'http://control.example.test', token: 'test' }),
    /HTTPS/,
  );
  assert.throws(
    () => new LocalFeatureServiceClient({ endpoint: 'https://features.example.test' }),
    /localhost/,
  );
});

test('runtime accepts download caches only under the persistent SGX root', () => {
  const env = runtimeEnvironment();

  assert.equal(requireRuntimeEnvironment(env), env);
});

test('runtime rejects a model download cache on the ephemeral runtime volume', () => {
  const env = runtimeEnvironment();
  env.MODELSCOPE_CACHE = '/quota/sgx-classification/cache/modelscope';

  assert.throws(
    () => requireRuntimeEnvironment(env),
    /MODELSCOPE_CACHE must stay below SGX_DEPLOY_ROOT/,
  );
});

test('runtime rejects online model transport even with persistent caches', () => {
  const env = runtimeEnvironment();
  env.HF_HUB_OFFLINE = '0';

  assert.throws(
    () => requireRuntimeEnvironment(env),
    /runtime model transport must remain offline/,
  );
});

test('worker defaults and release examples use the Stage A prompt source version', async () => {
  const [contract, main, environment, release] = await Promise.all([
    readFile(new URL('../../../src/lib/algorithms/classification/stage-a-contract.ts', import.meta.url), 'utf8'),
    readFile(new URL('../runtime/main.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../nonsecret.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../release-manifest.example.json', import.meta.url), 'utf8'),
  ]);
  const promptVersion = contract.match(/PROMPT_VERSION\s*=\s*'([^']+)'/)?.[1];
  assert.equal(promptVersion, 'sgx-five-facets.16');
  assert.match(main, new RegExp(`SGX_PROMPT_VERSION \\?\\? '${promptVersion}'`));
  assert.match(environment, new RegExp(`SGX_PROMPT_VERSION=${promptVersion}(?:\\n|$)`));
  assert.equal(JSON.parse(release).algorithmVersions.prompt, promptVersion);
});

test('pipeline processor binds feature extraction, trusted context and canonical classification result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-pipeline.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const lease = makeLease();
  const imagePath = path.join(root, 'image.jpg');
  const textPath = path.join(root, 'text.txt');
  await writeFile(imagePath, Buffer.from('image-one'));
  await writeFile(textPath, lease.evidence[1].inlineText.text);
  const files = [
    { evidence: lease.evidence[0], sourcePath: imagePath, byteLength: 9 },
    { evidence: lease.evidence[1], sourcePath: textPath, byteLength: Buffer.byteLength(lease.evidence[1].inlineText.text) },
  ];
  const identity = identityFor(lease);
  const calls = [];
  const contextProvider = {
    async executionContext(jobId, request) {
      calls.push({ kind: 'context', jobId, request });
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        contextVersion: EXECUTION_CONTEXT_VERSION,
        binding: contextBinding(lease),
        execution: {
          job: { jobId: lease.jobId, envelope: envelopeForLease(lease), budgetPolicy: minimalBudgetPolicy },
          guard: { authorizationRevision: lease.authorizationRevision },
          placeKindPolicy: { policyVersion: 'test.1' },
        },
      };
    },
  };
  const bridge = {
    async run(input) {
      calls.push({ kind: 'bridge', input });
      return {
        status: 'succeeded',
        result: { version: 'classification-lab-execution-result.1', workflowStatus: 'succeeded' },
        usage: {
          providerLatencyMs: 31,
          inputTokens: 100,
          outputTokens: 25,
          costCny: 0.001,
          providerCalls: 1,
        },
      };
    },
  };
  const checkpoints = [];
  const processor = new StageAPipelineProcessor({
    featureProcessor: new LocalFeatureBundleProcessor({
      featureService: new FakeFeatures(),
      now: () => FIXED_NOW,
    }),
    contextProvider,
    historicalRetrieval: {
      async historicalQuery() {
        throw new Error('historical service temporarily unavailable');
      },
    },
    bridge,
    now: () => FIXED_NOW,
    idFactory: () => 'context-request-1',
  });

  const result = await processor.process({
    lease,
    identity,
    files,
    versions,
    signal: new AbortController().signal,
    checkpoint: async (stage, progress) => checkpoints.push({ stage, progress }),
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.schemaVersion, PIPELINE_RESULT_VERSION);
  assert.equal(result.result.featureBundle.schemaVersion, 'classification-worker-feature-bundle.1');
  assert.equal(result.result.classification.workflowStatus, 'succeeded');
  assert.equal(result.usage.providerCalls, 1);
  assert.deepEqual(checkpoints, [
    { stage: 'retrieval', progress: 45 },
    { stage: 'vlm_extract', progress: 55 },
    { stage: 'organizing', progress: 80 },
  ]);
  assert.equal(calls[0].request.identity.leaseToken, lease.leaseToken);
  assert.equal(calls[1].input.execution.job.jobId, lease.jobId);
  assert.equal(calls[1].input.derivedFeatures.historicalRetrieval, 'disabled_component_failure');
});

test('pipeline rejects a cross-scope historical response before the Stage A bridge', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-history-fence.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const lease = makeLease();
  const imagePath = path.join(root, 'image.jpg');
  const textPath = path.join(root, 'text.txt');
  await writeFile(imagePath, Buffer.from('image-one'));
  await writeFile(textPath, lease.evidence[1].inlineText.text);
  let bridgeCalls = 0;
  const processor = new StageAPipelineProcessor({
    featureProcessor: new LocalFeatureBundleProcessor({ featureService: new FakeFeatures() }),
    contextProvider: {
      async executionContext(_jobId, request) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          contextVersion: EXECUTION_CONTEXT_VERSION,
          binding: contextBinding(lease),
          execution: {
            job: { jobId: lease.jobId, envelope: envelopeForLease(lease), budgetPolicy: minimalBudgetPolicy },
            guard: {},
            placeKindPolicy: {},
          },
        };
      },
    },
    historicalRetrieval: {
      async historicalQuery(_jobId, request) {
        return { ...historicalResult(request.query), scope: { householdId: 'other-household', subjectId: 'subject-1' } };
      },
    },
    bridge: { async run() { bridgeCalls += 1; } },
    idFactory: () => 'context-request-history-fence',
  });

  await assert.rejects(() => processor.process({
    lease,
    identity: identityFor(lease),
    files: [
      { evidence: lease.evidence[0], sourcePath: imagePath, byteLength: 9 },
      { evidence: lease.evidence[1], sourcePath: textPath, byteLength: Buffer.byteLength(lease.evidence[1].inlineText.text) },
    ],
    versions,
    signal: new AbortController().signal,
  }), (error) => error.errorCode === 'VERSION_MISMATCH' && error.stage === 'retrieval');
  assert.equal(bridgeCalls, 0);
});

test('pipeline fails closed on an execution-context binding mismatch before the bridge', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-context-fence.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const lease = makeLease();
  const imagePath = path.join(root, 'image.jpg');
  const textPath = path.join(root, 'text.txt');
  await writeFile(imagePath, Buffer.from('image-one'));
  await writeFile(textPath, lease.evidence[1].inlineText.text);
  let bridgeCalls = 0;
  const featureService = new FakeFeatures();
  const processor = new StageAPipelineProcessor({
    featureProcessor: new LocalFeatureBundleProcessor({ featureService }),
    contextProvider: {
      async executionContext(_jobId, request) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          contextVersion: EXECUTION_CONTEXT_VERSION,
          binding: { ...contextBinding(lease), authorizationRevision: 'stale-auth' },
          execution: { job: {}, guard: {}, placeKindPolicy: {} },
        };
      },
    },
    bridge: { async run() { bridgeCalls += 1; } },
    idFactory: () => 'context-request-2',
  });

  await assert.rejects(() => processor.process({
    lease,
    identity: identityFor(lease),
    files: [
      { evidence: lease.evidence[0], sourcePath: imagePath, byteLength: 9 },
      { evidence: lease.evidence[1], sourcePath: textPath, byteLength: Buffer.byteLength(lease.evidence[1].inlineText.text) },
    ],
    versions,
    signal: new AbortController().signal,
  }), (error) => error.errorCode === 'VERSION_MISMATCH' && error.stage === 'retrieval');
  assert.equal(bridgeCalls, 0);
  assert.equal(featureService.calls.length, 0, 'trusted context must be validated before feature extraction');
});

test('pipeline validates per-image person consent before calling face features', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-person-consent.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const lease = makeLease();
  const imagePath = path.join(root, 'image.jpg');
  const textPath = path.join(root, 'text.txt');
  await writeFile(imagePath, Buffer.from('image-one'));
  await writeFile(textPath, lease.evidence[1].inlineText.text);
  const files = [
    { evidence: lease.evidence[0], sourcePath: imagePath, byteLength: 9 },
    { evidence: lease.evidence[1], sourcePath: textPath, byteLength: Buffer.byteLength(lease.evidence[1].inlineText.text) },
  ];
  const featureService = new FakeFeatures();
  let contextResolved = false;
  const processor = new StageAPipelineProcessor({
    featureProcessor: new LocalFeatureBundleProcessor({
      featureService,
      personMatchingEnabled: true,
      now: () => FIXED_NOW,
    }),
    contextProvider: {
      async executionContext(_jobId, request) {
        assert.equal(featureService.calls.length, 0, 'face and non-biometric features must wait for trusted context');
        contextResolved = true;
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          contextVersion: EXECUTION_CONTEXT_VERSION,
          binding: contextBinding(lease),
          execution: {
            job: { jobId: lease.jobId, envelope: envelopeForLease(lease), budgetPolicy: minimalBudgetPolicy },
            guard: personGuardForLease(lease, ['evidence-image-1']),
            placeKindPolicy: { policyVersion: 'test.1' },
          },
        };
      },
    },
    bridge: {
      async run() {
        return {
          status: 'succeeded',
          result: { workflowStatus: 'succeeded' },
          usage: { providerLatencyMs: 1, inputTokens: 1, outputTokens: 1, costCny: 0, providerCalls: 1 },
        };
      },
    },
    now: () => FIXED_NOW,
    idFactory: () => 'context-request-person-1',
  });

  await processor.process({
    lease,
    identity: identityFor(lease),
    files,
    versions,
    signal: new AbortController().signal,
  });

  assert.equal(contextResolved, true);
  assert.deepEqual(featureService.calls.map((call) => call.capability), [
    'ocr', 'image_embedding', 'face_embeddings', 'text_embedding',
  ]);
});

test('pipeline skips face features without per-image person authorization', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-no-person-consent.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const lease = makeLease();
  const imagePath = path.join(root, 'image.jpg');
  const textPath = path.join(root, 'text.txt');
  await writeFile(imagePath, Buffer.from('image-one'));
  await writeFile(textPath, lease.evidence[1].inlineText.text);
  const featureService = new FakeFeatures();
  const processor = new StageAPipelineProcessor({
    featureProcessor: new LocalFeatureBundleProcessor({
      featureService,
      personMatchingEnabled: true,
      now: () => FIXED_NOW,
    }),
    contextProvider: {
      async executionContext(_jobId, request) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          contextVersion: EXECUTION_CONTEXT_VERSION,
          binding: contextBinding(lease),
          execution: {
            job: { jobId: lease.jobId, envelope: envelopeForLease(lease), budgetPolicy: minimalBudgetPolicy },
            guard: personGuardForLease(lease),
            placeKindPolicy: { policyVersion: 'test.1' },
          },
        };
      },
    },
    bridge: {
      async run() {
        return {
          status: 'succeeded', result: { workflowStatus: 'succeeded' },
          usage: { providerLatencyMs: 1, inputTokens: 1, outputTokens: 1, costCny: 0, providerCalls: 1 },
        };
      },
    },
    now: () => FIXED_NOW,
    idFactory: () => 'context-request-person-2',
  });

  await processor.process({
    lease,
    identity: identityFor(lease),
    files: [
      { evidence: lease.evidence[0], sourcePath: imagePath, byteLength: 9 },
      { evidence: lease.evidence[1], sourcePath: textPath, byteLength: Buffer.byteLength(lease.evidence[1].inlineText.text) },
    ],
    versions,
    signal: new AbortController().signal,
  });

  assert.deepEqual(featureService.calls.map((call) => call.capability), [
    'ocr', 'image_embedding', 'text_embedding',
  ]);
});

test('pipeline degrades unavailable local features to review while Stage A still runs once', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-feature-degrade.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const lease = makeLease();
  const imagePath = path.join(root, 'image.jpg');
  const textPath = path.join(root, 'text.txt');
  await writeFile(imagePath, Buffer.from('image-one'));
  await writeFile(textPath, lease.evidence[1].inlineText.text);
  let bridgeCalls = 0;
  let derivedFeatures;
  const processor = new StageAPipelineProcessor({
    featureProcessor: new LocalFeatureBundleProcessor({
      featureService: new FakeFeatures({ fail: ['ocr', 'image_embedding', 'text_embedding'] }),
      now: () => FIXED_NOW,
    }),
    contextProvider: {
      async executionContext(_jobId, request) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          contextVersion: EXECUTION_CONTEXT_VERSION,
          binding: contextBinding(lease),
          execution: {
            job: { jobId: lease.jobId, envelope: envelopeForLease(lease), budgetPolicy: minimalBudgetPolicy },
            guard: {},
            placeKindPolicy: {},
          },
        };
      },
    },
    bridge: {
      async run(input) {
        bridgeCalls += 1;
        derivedFeatures = input.derivedFeatures;
        return {
          status: 'succeeded',
          result: { workflowStatus: 'succeeded' },
          usage: { providerLatencyMs: 1, inputTokens: 1, outputTokens: 1, costCny: 0, providerCalls: 1 },
        };
      },
    },
    now: () => FIXED_NOW,
    idFactory: () => 'context-request-3',
  });

  const result = await processor.process({
    lease,
    identity: identityFor(lease),
    files: [
      { evidence: lease.evidence[0], sourcePath: imagePath, byteLength: 9 },
      { evidence: lease.evidence[1], sourcePath: textPath, byteLength: Buffer.byteLength(lease.evidence[1].inlineText.text) },
    ],
    versions,
    signal: new AbortController().signal,
  });

  assert.equal(bridgeCalls, 1);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.result.featureBundle.componentErrors.length, 3);
  assert.equal(derivedFeatures.embeddingRetrieval, 'disabled_component_failure');
  assert.deepEqual(derivedFeatures.retrievalHints, []);
});

test('pipeline feeds OCR evidence and text-prioritized embedding Top-K hints into Stage A', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-derived-features.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const imageBytes = [Buffer.from('image-one'), Buffer.from('image-two'), Buffer.from('image-three')];
  const text = '第二张照片是同一次毕业活动。';
  const imageHashes = imageBytes.map((bytes) => digest(bytes));
  const textHash = digest(Buffer.from(text, 'utf8'));
  const lease = {
    ...makeLease(),
    evidence: [
      ...imageBytes.map((bytes, index) => ({
        evidenceId: `evidence-image-${index + 1}`,
        contentId: `content-${index + 1}`,
        modality: 'image',
        revision: 1,
        sourceHash: imageHashes[index],
        lifecycleState: 'active',
        artifact: { mimeType: 'image/jpeg' },
      })),
      {
        evidenceId: 'evidence-text-2',
        contentId: 'content-text-2',
        modality: 'user_text',
        revision: 1,
        sourceHash: textHash,
        lifecycleState: 'active',
        inlineText: { text, sha256: textHash },
      },
    ],
  };
  const files = [];
  for (let index = 0; index < imageBytes.length; index += 1) {
    const sourcePath = path.join(root, `image-${index + 1}.jpg`);
    await writeFile(sourcePath, imageBytes[index]);
    files.push({ evidence: lease.evidence[index], sourcePath, byteLength: imageBytes[index].length });
  }
  const textPath = path.join(root, 'text.txt');
  await writeFile(textPath, text);
  files.push({ evidence: lease.evidence[3], sourcePath: textPath, byteLength: Buffer.byteLength(text) });
  const stripped = (value) => value.slice('sha256:'.length);
  const featureService = new FakeFeatures({
    embeddings: {
      [stripped(imageHashes[0])]: [1, 0],
      [stripped(imageHashes[1])]: [0, 1],
      [stripped(imageHashes[2])]: [0.8, 0.6],
      [stripped(textHash)]: [1, 0],
    },
    ocrTextByHash: { [stripped(imageHashes[0])]: '1985年毕业留念' },
  });
  let bridgeInput;
  let historicalRequest;
  const processor = new StageAPipelineProcessor({
    featureProcessor: new LocalFeatureBundleProcessor({ featureService, now: () => FIXED_NOW }),
    contextProvider: {
      async executionContext(_jobId, request) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          contextVersion: EXECUTION_CONTEXT_VERSION,
          binding: contextBinding(lease),
          execution: {
            job: {
              jobId: lease.jobId,
              envelope: envelopeForLease(lease, { 'content-text-2': ['content-2'] }),
              budgetPolicy: { maxCandidatesPerContent: 1 },
            },
            guard: { version: 'classification-lab-guard.1' },
            placeKindPolicy: { policyVersion: 'classification-place-kind.1' },
          },
        };
      },
    },
    historicalRetrieval: {
      async historicalQuery(_jobId, request) {
        historicalRequest = request;
        const source = request.query.sources.find((item) => item.sourceContentId === 'content-2');
        return historicalResult(request.query, [historicalCandidate(source, { suffix: 'semantic-1' })]);
      },
    },
    bridge: {
      async run(input) {
        bridgeInput = input;
        return {
          status: 'succeeded',
          result: { workflowStatus: 'succeeded' },
          usage: { providerLatencyMs: 1, inputTokens: 1, outputTokens: 1, costCny: 0, providerCalls: 1 },
        };
      },
    },
    now: () => FIXED_NOW,
    idFactory: () => 'context-request-derived-1',
  });

  const result = await processor.process({
    lease,
    identity: identityFor(lease),
    files,
    versions,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(bridgeInput.derivedFeatures.embeddingRetrieval, 'batch_topk');
  assert.equal(
    bridgeInput.derivedFeatures.ocrTextByEvidenceId['evidence-image-1'].text,
    '1985年毕业留念',
  );
  assert.ok(bridgeInput.derivedFeatures.retrievalHints.some((hint) => (
    hint.leftPhotoId === 'evidence-image-1'
      && hint.rightPhotoId === 'evidence-image-2'
      && hint.rank === 1
  )));
  assert.deepEqual(
    historicalRequest.query.sources.find((item) => item.sourceContentId === 'content-2').vector,
    [1, 0],
    'user-bound text embedding must take priority over the raw image embedding',
  );
  assert.equal(historicalRequest.identity.leaseToken, lease.leaseToken);
  assert.equal(historicalRequest.protocolVersion, PROTOCOL_VERSION);
  assert.equal(bridgeInput.derivedFeatures.historicalRetrieval, 'historical_topk');
  assert.equal(bridgeInput.derivedFeatures.historicalCandidates[0].historicalEvidenceId, 'historical-evidence-semantic-1');
  assert.equal(JSON.stringify(bridgeInput.derivedFeatures).includes('similarity'), false);
});

test('pipeline emits authorized face Top-K hints without promoting detections to identities', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-face-topk.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const imageBytes = [Buffer.from('face-image-one'), Buffer.from('face-image-two'), Buffer.from('face-image-three')];
  const imageHashes = imageBytes.map((bytes) => digest(bytes));
  const lease = {
    ...makeLease(),
    evidence: imageBytes.map((bytes, index) => ({
      evidenceId: `evidence-face-${index + 1}`,
      contentId: `content-face-${index + 1}`,
      modality: 'image',
      revision: 1,
      sourceHash: imageHashes[index],
      lifecycleState: 'active',
      artifact: { mimeType: 'image/jpeg' },
    })),
  };
  const files = [];
  for (let index = 0; index < imageBytes.length; index += 1) {
    const sourcePath = path.join(root, `face-${index + 1}.jpg`);
    await writeFile(sourcePath, imageBytes[index]);
    files.push({ evidence: lease.evidence[index], sourcePath, byteLength: imageBytes[index].length });
  }
  const stripped = (value) => value.slice('sha256:'.length);
  const face = (suffix, vector) => ({
    faceId: `face_${suffix.repeat(32)}`,
    bounds: { x: 10, y: 12, width: 40, height: 42 },
    detectorScore: 0.98,
    vector,
  });
  const featureService = new FakeFeatures({
    embeddings: Object.fromEntries(imageHashes.map((hash, index) => [stripped(hash), index === 2 ? [0, 1] : [1, 0]])),
    faceEmbeddingsByHash: {
      [stripped(imageHashes[0])]: [face('a', [1, 0])],
      [stripped(imageHashes[1])]: [face('b', [0.99, 0.1])],
      [stripped(imageHashes[2])]: [face('c', [0, 1])],
    },
  });
  let bridgeInput;
  let historicalRequest;
  const processor = new StageAPipelineProcessor({
    featureProcessor: new LocalFeatureBundleProcessor({
      featureService,
      personMatchingEnabled: true,
      now: () => FIXED_NOW,
    }),
    contextProvider: {
      async executionContext(_jobId, request) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          contextVersion: EXECUTION_CONTEXT_VERSION,
          binding: contextBinding(lease),
          execution: {
            job: {
              jobId: lease.jobId,
              envelope: envelopeForLease(lease),
              budgetPolicy: { maxCandidatesPerContent: 1 },
            },
            guard: personGuardForLease(lease, lease.evidence.map((item) => item.evidenceId)),
            placeKindPolicy: { policyVersion: 'classification-place-kind.1' },
          },
        };
      },
    },
    historicalRetrieval: {
      async historicalQuery(_jobId, request) {
        historicalRequest = request;
        const source = request.query.sources.find((item) => item.kind === 'face_embedding');
        return historicalResult(request.query, [historicalCandidate(source, { suffix: 'face-1', faceSuffix: 'e' })]);
      },
    },
    bridge: {
      async run(input) {
        bridgeInput = input;
        return {
          status: 'succeeded',
          result: { workflowStatus: 'succeeded' },
          usage: { providerLatencyMs: 1, inputTokens: 1, outputTokens: 1, costCny: 0, providerCalls: 1 },
        };
      },
    },
    now: () => FIXED_NOW,
    idFactory: () => 'context-request-face-topk-1',
  });

  await processor.process({
    lease,
    identity: identityFor(lease),
    files,
    versions,
    signal: new AbortController().signal,
  });

  assert.equal(bridgeInput.derivedFeatures.faceRetrieval, 'batch_topk');
  assert.ok(bridgeInput.derivedFeatures.retrievalHints.some((hint) => (
    hint.kind === 'face_embedding_topk'
      && hint.leftPhotoId === 'evidence-face-1'
      && hint.rightPhotoId === 'evidence-face-2'
      && hint.rank === 1
  )));
  assert.deepEqual(
    bridgeInput.derivedFeatures.faceCandidatesByEvidenceId['evidence-face-1'].faces,
    [{
      faceId: `face_${'a'.repeat(32)}`,
      bounds: { x: 10, y: 12, width: 40, height: 42 },
      detectorScore: 0.98,
    }],
  );
  assert.equal(JSON.stringify(bridgeInput.derivedFeatures).includes('"vector"'), false);
  assert.equal(JSON.stringify(bridgeInput.derivedFeatures).includes('personIdentity'), false);
  const faceSource = historicalRequest.query.sources.find((item) => item.kind === 'face_embedding');
  assert.equal(faceSource.sourceFaceId, `face_${'a'.repeat(32)}`);
  assert.equal(faceSource.personConsentRef, 'person-consent-evidence-face-1');
  assert.equal(bridgeInput.derivedFeatures.historicalCandidates[0].sourceFaceId, `face_${'a'.repeat(32)}`);
  assert.equal(bridgeInput.derivedFeatures.historicalCandidates[0].historicalProjection.faceId, `face_${'e'.repeat(32)}`);
});

test('subprocess bridge exchanges only file-bound JSON and validates the response binding', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-subprocess.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const fakeBridge = path.join(root, 'fake-bridge.mjs');
  await writeFile(fakeBridge, `
    import { readFile, writeFile } from 'node:fs/promises';
    const value = name => process.argv[process.argv.indexOf(name) + 1];
    const request = JSON.parse(await readFile(value('--request'), 'utf8'));
    await writeFile(value('--response'), JSON.stringify({
      schemaVersion: 'classification-worker-stage-a-bridge-response.1',
      binding: request.binding,
      status: 'succeeded',
      result: { workflowStatus: 'succeeded', source: 'fake-child' },
      usage: { providerLatencyMs: 2, inputTokens: 3, outputTokens: 4, costCny: 0, providerCalls: 1 }
    }), { flag: 'wx', mode: 0o600 });
  `);
  const lease = makeLease();
  const sourcePath = path.join(root, 'source.jpg');
  await writeFile(sourcePath, Buffer.from('image-one'));
  const bridge = new SubprocessStageABridge({ buildDir: root, bridgePath: fakeBridge });

  const result = await bridge.run({
    identity: identityFor(lease),
    lease,
    execution: { job: {}, guard: {}, placeKindPolicy: {} },
    files: [{ evidence: lease.evidence[0], sourcePath, byteLength: 9 }],
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.source, 'fake-child');
  assert.equal(result.usage.providerCalls, 1);
});

test('HTTP control-plane client fetches an immutable execution context through the internal route', async () => {
  const requests = [];
  const client = new HttpControlPlaneClient({
    baseUrl: 'https://control.example.test',
    token: 'injected-test-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const response = await client.executionContext('job-1', { requestId: 'request-1' });

  assert.deepEqual(response, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://control.example.test/internal/v1/classification/jobs/job-1/execution-context');
  assert.equal(requests[0].options.headers.authorization, 'Bearer injected-test-token');
});

test('HTTP control-plane client posts historical retrieval through the job-scoped route', async () => {
  const requests = [];
  const client = new HttpControlPlaneClient({
    baseUrl: 'https://control.example.test',
    token: 'injected-test-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const response = await client.historicalQuery('job/1', { requestId: 'history-request-1' });

  assert.deepEqual(response, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://control.example.test/internal/v1/classification/jobs/job%2F1/historical-query');
  assert.equal(requests[0].options.headers.authorization, 'Bearer injected-test-token');
});

test('stage-a child bridge runs the compiled VLM mock and StoryUnit organizer end to end', {
  skip: !process.env.CLASSIFICATION_BUILD_DIR,
}, async (t) => {
  const base = path.join(process.env.CLASSIFICATION_BUILD_DIR, 'src/lib/algorithms/classification');
  const { buildLabSubmission } = require(path.join(base, 'lab-contract.js'));
  const {
    buildTrustedLabGuardSnapshot,
  } = require(path.join(base, 'lab-execution-contract.js'));
  const { FileClassificationLabV2Store } = require(path.join(base, 'lab-execution-store.js'));
  const { submitLabExecutionJob } = require(path.join(base, 'lab-execution.js'));
  const {
    StageALabExecutorFactory,
    stageALabProviderVersion,
  } = require(path.join(base, 'lab-stage-a-executor.js'));
  const {
    computePlaceKindPolicyDigest,
    STAGE_A_LAB_COMPOSITION_VERSION,
  } = require(path.join(base, 'lab-stage-a-composition.js'));
  const { PROMPT_VERSION, digest: stageDigest } = require(path.join(base, 'stage-a-contract.js'));
  assert.equal(typeof StageALabExecutorFactory, 'function');

  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-worker-real-bridge.'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1kAAAAASUVORK5CYII=',
    'base64',
  );
  const submittedAt = new Date().toISOString();
  const built = buildLabSubmission({
    scope: { householdId: 'house_bridge', subjectId: 'subject_bridge' },
    actorId: 'actor_bridge',
    contextKind: 'album_upload',
    recipientIds: [],
    images: [{ filename: 'family.png', mimeType: 'image/png', bytes: png }],
    userText: '这是家里的旧照片。',
    userTextTargetIndexes: [0],
    finalAsrTargetIndexes: null,
    submittedAt,
  });
  const guard = buildTrustedLabGuardSnapshot({
    scope: built.envelope.scope,
    actorId: built.envelope.actorId,
    authorityRef: 'authority_bridge',
    purposes: ['classification', 'album_organization', 'search_candidate', 'interview_candidate'],
    authorizationRevision: built.envelope.authorizationRevision,
    contextRevision: 'context_bridge_1',
    active: true,
    allowedConsentRefs: [...new Set(built.envelope.evidence.map((item) => item.consentRef))].sort(),
    allowedCorrectionIds: [],
    allowPersonMatching: false,
    evidence: built.envelope.evidence.map((item) => ({
      evidenceId: item.evidenceId,
      revision: item.revision,
      sourceHash: item.sourceHash,
      consentRef: item.consentRef,
      lifecycleState: 'active',
    })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
  });
  const placeKindPolicy = {
    policyVersion: 'classification-place-kind.1',
    taxonomyVersion: built.envelope.taxonomyVersion,
    genericLabels: ['家中', '室内', '户外'],
  };
  const model = 'sgx-stage-a-worker-bridge-mock.1';
  const profile = {
    providerMode: 'stage_a_mock',
    providerVersion: stageALabProviderVersion('qwen', model),
    modelVersion: model,
    promptVersion: PROMPT_VERSION,
    guardVersion: 'classification-lab-guard.1',
    adapterVersion: STAGE_A_LAB_COMPOSITION_VERSION,
    taxonomyVersion: built.envelope.taxonomyVersion,
    placeKindPolicyDigest: computePlaceKindPolicyDigest(placeKindPolicy),
    scorerVersion: 'classification-semantic-score.2',
    configDigest: stageDigest({ test: 'worker-bridge', model }),
  };
  const clock = {
    nowMs: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const store = new FileClassificationLabV2Store(path.join(root, 'store'));
  const job = await submitLabExecutionJob({
    built,
    profile,
    guard,
    semanticContext: {
      version: 'classification-lab-semantic-context.1',
      referenceDate: new Date().toISOString().slice(0, 10),
      timeZone: 'Asia/Shanghai',
      relativeTimePolicyVersion: 'relative-time.1',
    },
    budgetPolicy: {
      maxRequests: 3,
      maxInputTokens: 100_000,
      maxOutputTokens: 4_096,
      maxCostCny: 0,
      maxCandidatesPerContent: 8,
      maxCallDurationMs: 10_000,
    },
    attemptRevision: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  }, store, clock);
  const assets = [];
  const contentByEvidenceId = new Map(built.envelope.contents.map((item) => [item.evidenceId, item]));
  for (const [index, asset] of built.assets.entries()) {
    const sourcePath = path.join(root, `asset-${index}`);
    await writeFile(sourcePath, asset.bytes);
    const evidence = built.envelope.evidence.find((item) => item.evidenceId === asset.evidenceId);
    const content = contentByEvidenceId.get(asset.evidenceId);
    assets.push({
      evidence: {
        evidenceId: asset.evidenceId,
        contentId: content.contentId,
        modality: content.modality,
        revision: evidence.revision,
        sourceHash: evidence.sourceHash,
        lifecycleState: 'active',
        ...(content.modality === 'image' ? { artifact: { mimeType: asset.mimeType } } : {}),
      },
      sourcePath,
      byteLength: asset.bytes.length,
    });
  }
  const lease = {
    jobId: job.jobId,
    runId: job.runId,
    leaseToken: 'l'.repeat(32),
    jobRevision: 1,
    attemptRevision: job.attemptRevision,
    scope: job.envelope.scope,
    authorizationRevision: job.authorization.authorizationRevision,
    inputHash: job.contentDigest,
    executionProfileDigest: profile.configDigest,
  };
  const bridge = new SubprocessStageABridge({
    buildDir: process.env.CLASSIFICATION_BUILD_DIR,
    environment: {
      ...process.env,
      SGX_VLM_PROVIDER: 'qwen',
      SGX_VLM_MODEL: model,
      SGX_VLM_INPUT_CNY_PER_MILLION: '0',
      SGX_VLM_OUTPUT_CNY_PER_MILLION: '0',
    },
  });

  const completed = await bridge.run({
    identity: identityFor(lease),
    lease,
    execution: { job, guard, placeKindPolicy },
    files: assets,
    signal: new AbortController().signal,
  });

  assert.ok(['succeeded', 'needs_review'].includes(completed.status));
  assert.equal(completed.result.output.provider.mode, 'stage_a_mock');
  assert.equal(completed.result.output.provider.accuracyClaim, 'not_evaluated');
  assert.equal(completed.usage.providerCalls, 1);
  assert.ok(completed.result.output.organization.stories.length >= 1);
});
