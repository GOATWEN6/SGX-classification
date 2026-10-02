import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_BUNDLE_VERSION,
  FenceStop,
  PROTOCOL_VERSION,
  WorkerExecutionError,
} from './worker-runtime.mjs';

export const EXECUTION_CONTEXT_VERSION = 'classification-worker-stage-a-context.1';
export const BRIDGE_REQUEST_VERSION = 'classification-worker-stage-a-bridge-request.1';
export const BRIDGE_RESPONSE_VERSION = 'classification-worker-stage-a-bridge-response.1';
export const PIPELINE_RESULT_VERSION = 'classification-worker-pipeline-result.1';
export const DERIVED_FEATURES_VERSION = 'classification-worker-derived-features.1';
const EMPTY_DERIVED_FEATURES = Object.freeze({
  version: DERIVED_FEATURES_VERSION,
  ocrTextByEvidenceId: Object.freeze({}),
  retrievalHints: Object.freeze([]),
  embeddingRetrieval: 'not_applicable',
});

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set(['succeeded', 'needs_review']);
const PROVIDER_ERROR_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_INVALID_OUTPUT',
  'INTERNAL_ERROR',
]);
const STOP_REASONS = new Set([
  'cancelled',
  'authorization_changed',
  'evidence_inactive',
]);
const FORBIDDEN_CONTEXT_KEYS = new Set([
  'apiKey',
  'api_key',
  'credential',
  'secret',
  'bearerToken',
  'accessToken',
]);

function ensure(condition, code = 'VERSION_MISMATCH', stage = 'retrieval', message = code) {
  if (!condition) throw new WorkerExecutionError(code, stage, message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bindingFromIdentity(identity, scope) {
  return {
    jobId: identity.jobId,
    runId: identity.runId,
    jobRevision: identity.jobRevision,
    attemptRevision: identity.attemptRevision,
    scope,
    authorizationRevision: identity.authorizationRevision,
    inputHash: identity.inputHash,
    executionProfileDigest: identity.executionProfileDigest,
  };
}

function containsForbiddenKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_CONTEXT_KEYS.has(key) || containsForbiddenKey(child)
  ));
}

export function validateExecutionContext(raw, { requestId, identity, lease }) {
  ensure(raw && typeof raw === 'object');
  ensure(raw.protocolVersion === PROTOCOL_VERSION);
  ensure(raw.requestId === requestId);
  ensure(raw.contextVersion === EXECUTION_CONTEXT_VERSION);
  ensure(same(raw.binding, bindingFromIdentity(identity, lease.scope)));
  ensure(raw.execution && typeof raw.execution === 'object');
  ensure(raw.execution.job && typeof raw.execution.job === 'object');
  ensure(raw.execution.guard && typeof raw.execution.guard === 'object');
  ensure(raw.execution.placeKindPolicy && typeof raw.execution.placeKindPolicy === 'object');
  ensure(!containsForbiddenKey(raw.execution), 'VERSION_MISMATCH', 'retrieval', 'execution context contains a credential');
  return raw.execution;
}

function usageFromBridge(raw) {
  ensure(raw && typeof raw === 'object', 'PROVIDER_INVALID_OUTPUT', 'organizing');
  const keys = [
    'providerLatencyMs',
    'inputTokens',
    'outputTokens',
    'costCny',
    'providerCalls',
  ];
  for (const key of keys) {
    ensure(Number.isFinite(raw[key]) && raw[key] >= 0, 'PROVIDER_INVALID_OUTPUT', 'organizing');
  }
  ensure(Number.isInteger(raw.providerLatencyMs), 'PROVIDER_INVALID_OUTPUT', 'organizing');
  ensure(Number.isInteger(raw.inputTokens), 'PROVIDER_INVALID_OUTPUT', 'organizing');
  ensure(Number.isInteger(raw.outputTokens), 'PROVIDER_INVALID_OUTPUT', 'organizing');
  ensure(Number.isInteger(raw.providerCalls), 'PROVIDER_INVALID_OUTPUT', 'organizing');
  return raw;
}

function failureBundle({ lease, files, versions, now }) {
  const evidence = files.map((file) => {
    const capabilities = file.evidence.modality === 'image'
      ? ['ocr', 'image_embedding']
      : ['text_embedding'];
    return {
      evidenceId: file.evidence.evidenceId,
      contentId: file.evidence.contentId,
      modality: file.evidence.modality,
      revision: file.evidence.revision,
      sourceHash: file.evidence.sourceHash,
      features: {},
      capabilities,
    };
  });
  return {
    status: 'needs_review',
    result: {
      schemaVersion: FEATURE_BUNDLE_VERSION,
      generatedAt: new Date(now()).toISOString(),
      jobId: lease.jobId,
      runId: lease.runId,
      scope: lease.scope,
      authorizationRevision: lease.authorizationRevision,
      inputHash: lease.inputHash,
      executionProfileDigest: lease.executionProfileDigest,
      versions,
      evidence,
      componentErrors: evidence.flatMap((item) => item.capabilities.map((capability) => ({
        evidenceId: item.evidenceId,
        capability,
        errorCode: 'FEATURE_SERVICE_UNAVAILABLE',
      }))),
    },
    usage: {
      providerLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costCny: 0,
      providerCalls: 0,
    },
  };
}

function assertFileSet(files) {
  ensure(Array.isArray(files) && files.length > 0, 'VERSION_MISMATCH', 'retrieval');
  const directory = path.dirname(files[0].sourcePath);
  for (const file of files) {
    ensure(path.dirname(file.sourcePath) === directory, 'VERSION_MISMATCH', 'retrieval');
    ensure(SHA256_PATTERN.test(file.evidence.sourceHash), 'VERSION_MISMATCH', 'retrieval');
  }
  return directory;
}

function normalizedVector(value) {
  if (!value || !Array.isArray(value.vector) || !Number.isInteger(value.dimensions)
    || value.vector.length !== value.dimensions || value.normalized !== true
    || typeof value.modelId !== 'string' || typeof value.modelRevision !== 'string') return null;
  const vector = value.vector.map(Number);
  if (vector.some((item) => !Number.isFinite(item))) return null;
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return {
    modelId: value.modelId,
    modelRevision: value.modelRevision,
    dimensions: value.dimensions,
    vector: vector.map((item) => item / norm),
  };
}

function meanNormalized(vectors) {
  if (!vectors.length) return null;
  const [{ modelId, modelRevision, dimensions }] = vectors;
  if (vectors.some((item) => item.modelId !== modelId
    || item.modelRevision !== modelRevision || item.dimensions !== dimensions)) return null;
  const mean = Array.from({ length: dimensions }, (_, index) => (
    vectors.reduce((sum, item) => sum + item.vector[index], 0) / vectors.length
  ));
  const norm = Math.sqrt(mean.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return { modelId, modelRevision, dimensions, vector: mean.map((item) => item / norm) };
}

function buildDerivedFeatures(featureBundle, execution) {
  ensure(featureBundle?.schemaVersion === FEATURE_BUNDLE_VERSION, 'VERSION_MISMATCH', 'retrieval');
  ensure(Array.isArray(featureBundle.evidence) && Array.isArray(featureBundle.componentErrors), 'VERSION_MISMATCH', 'retrieval');
  const maxCandidates = execution?.job?.budgetPolicy?.maxCandidatesPerContent;
  ensure(Number.isInteger(maxCandidates) && maxCandidates >= 1 && maxCandidates <= 12, 'VERSION_MISMATCH', 'retrieval');

  const envelope = execution?.job?.envelope;
  ensure(envelope && Array.isArray(envelope.contents) && Array.isArray(envelope.bindings), 'VERSION_MISMATCH', 'retrieval');
  const contentByEvidenceId = new Map(envelope.contents.map((item) => [item.evidenceId, item]));
  const imageContentIds = new Set(envelope.contents
    .filter((item) => item.lifecycleState === 'active' && item.modality === 'image')
    .map((item) => item.contentId));
  const targetImageContentIdsByTextContentId = new Map();
  for (const binding of envelope.bindings) {
    if (binding.state !== 'active' || binding.authority !== 'user_explicit'
      || binding.target?.kind !== 'contents') continue;
    const targets = binding.target.contentIds.filter((contentId) => imageContentIds.has(contentId));
    if (targets.length) targetImageContentIdsByTextContentId.set(binding.sourceContentId, targets);
  }

  const ocrTextByEvidenceId = {};
  const textVectorsByImageContentId = new Map();
  const images = [];
  for (const item of featureBundle.evidence) {
    ensure(typeof item.evidenceId === 'string' && typeof item.contentId === 'string'
      && SHA256_PATTERN.test(item.sourceHash ?? ''), 'VERSION_MISMATCH', 'retrieval');
    if (item.modality === 'image') {
      const ocr = item.features?.ocr;
      if (ocr) {
        ensure(`sha256:${ocr.sourceSha256}` === item.sourceHash && Array.isArray(ocr.regions), 'VERSION_MISMATCH', 'retrieval');
        const text = ocr.regions.map((region) => String(region?.text ?? '').trim()).filter(Boolean).join('\n').slice(0, 16000);
        if (text) ocrTextByEvidenceId[item.evidenceId] = { sourceHash: item.sourceHash, text };
      }
      images.push({
        evidenceId: item.evidenceId,
        contentId: item.contentId,
        imageVector: normalizedVector(item.features?.imageEmbedding),
      });
    } else if (item.modality === 'user_text' || item.modality === 'final_asr') {
      const vector = normalizedVector(item.features?.textEmbedding);
      const sourceContent = contentByEvidenceId.get(item.evidenceId);
      ensure(sourceContent?.contentId === item.contentId
        && sourceContent.modality === item.modality, 'VERSION_MISMATCH', 'retrieval');
      if (vector) {
        for (const targetContentId of targetImageContentIdsByTextContentId.get(sourceContent.contentId) ?? []) {
          textVectorsByImageContentId.set(targetContentId, [
            ...(textVectorsByImageContentId.get(targetContentId) ?? []),
            vector,
          ]);
        }
      }
    }
  }

  const embeddingFailed = featureBundle.componentErrors.some((item) => (
    item.capability === 'image_embedding' || item.capability === 'text_embedding'
  ));
  const retrievalHints = [];
  if (!embeddingFailed) {
    const resolved = images.map((image) => ({
      ...image,
      // User text/final ASR is the primary semantic vector when it is bound
      // to the same content; the image vector is the fallback.
      vector: meanNormalized(textVectorsByImageContentId.get(image.contentId) ?? []) ?? image.imageVector,
    })).filter((item) => item.vector);
    const pairHints = new Map();
    for (const left of resolved) {
      const neighbors = resolved.filter((right) => right.evidenceId !== left.evidenceId
        && right.vector.modelId === left.vector.modelId
        && right.vector.modelRevision === left.vector.modelRevision
        && right.vector.dimensions === left.vector.dimensions)
        .map((right) => ({
          right,
          similarity: left.vector.vector.reduce((sum, value, index) => sum + value * right.vector.vector[index], 0),
        }))
        .sort((a, b) => b.similarity - a.similarity || a.right.evidenceId.localeCompare(b.right.evidenceId))
        .slice(0, maxCandidates);
      neighbors.forEach(({ right }, index) => {
        const [leftPhotoId, rightPhotoId] = [left.evidenceId, right.evidenceId].sort();
        const key = `${leftPhotoId}/${rightPhotoId}`;
        const candidate = {
          kind: 'image_text_embedding_topk',
          leftPhotoId,
          rightPhotoId,
          rank: index + 1,
          modelId: left.vector.modelId,
          modelRevision: left.vector.modelRevision,
        };
        const previous = pairHints.get(key);
        if (!previous || candidate.rank < previous.rank) pairHints.set(key, candidate);
      });
    }
    retrievalHints.push(...[...pairHints.values()].sort((a, b) => a.rank - b.rank
      || a.leftPhotoId.localeCompare(b.leftPhotoId) || a.rightPhotoId.localeCompare(b.rightPhotoId)));
  }
  return {
    version: DERIVED_FEATURES_VERSION,
    ocrTextByEvidenceId,
    retrievalHints,
    embeddingRetrieval: embeddingFailed
      ? 'disabled_component_failure'
      : retrievalHints.length ? 'batch_topk' : 'not_applicable',
  };
}

export class SubprocessStageABridge {
  constructor({
    buildDir,
    bridgePath = fileURLToPath(new URL('./stage-a-bridge.mjs', import.meta.url)),
    nodeExecutable = process.execPath,
    environment = process.env,
    spawnImpl = spawn,
    killGraceMs = 2_000,
  }) {
    ensure(path.isAbsolute(buildDir ?? ''), 'VERSION_MISMATCH', 'lease', 'SGX_CLASSIFICATION_BUILD_DIR must be absolute');
    ensure(path.isAbsolute(bridgePath), 'VERSION_MISMATCH', 'lease');
    this.buildDir = buildDir;
    this.bridgePath = bridgePath;
    this.nodeExecutable = nodeExecutable;
    this.environment = environment;
    this.spawnImpl = spawnImpl;
    this.killGraceMs = killGraceMs;
  }

  async run({ identity, lease, execution, derivedFeatures = EMPTY_DERIVED_FEATURES, files, signal }) {
    const runRoot = assertFileSet(files);
    const nonce = randomUUID();
    const requestPath = path.join(runRoot, `stage-a-request-${nonce}.json`);
    const responsePath = path.join(runRoot, `stage-a-response-${nonce}.json`);
    const binding = bindingFromIdentity(identity, lease.scope);
    const request = {
      schemaVersion: BRIDGE_REQUEST_VERSION,
      binding,
      execution,
      derivedFeatures,
      evidenceFiles: files.map((file) => ({
        evidenceId: file.evidence.evidenceId,
        contentId: file.evidence.contentId,
        modality: file.evidence.modality,
        revision: file.evidence.revision,
        sourceHash: file.evidence.sourceHash,
        byteLength: file.byteLength,
        sourcePath: file.sourcePath,
        ...(file.evidence.artifact?.mimeType ? { mimeType: file.evidence.artifact.mimeType } : {}),
      })),
    };
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600, flag: 'wx' });

    const child = this.spawnImpl(this.nodeExecutable, [
      this.bridgePath,
      '--request', requestPath,
      '--response', responsePath,
    ], {
      cwd: runRoot,
      env: { ...this.environment, SGX_CLASSIFICATION_BUILD_DIR: this.buildDir },
      stdio: 'ignore',
      windowsHide: true,
    });
    let forceKill;
    const onAbort = () => {
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), this.killGraceMs);
      forceKill.unref?.();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    let exit;
    try {
      exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      });
    } catch (error) {
      throw new WorkerExecutionError('INTERNAL_ERROR', 'vlm_extract', 'stage-a bridge could not start', { cause: error });
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (forceKill) clearTimeout(forceKill);
    }
    if (signal.aborted) throw signal.reason ?? new Error('aborted');

    let response;
    try {
      response = JSON.parse(await readFile(responsePath, 'utf8'));
    } catch (error) {
      throw new WorkerExecutionError('INTERNAL_ERROR', 'vlm_extract', 'stage-a bridge returned no valid response', { cause: error });
    }
    if (exit.code !== 0) {
      if (STOP_REASONS.has(response?.stopReason)) throw new FenceStop(response.stopReason);
      const errorCode = PROVIDER_ERROR_CODES.has(response?.errorCode)
        ? response.errorCode
        : 'INTERNAL_ERROR';
      throw new WorkerExecutionError(errorCode, response?.stage ?? 'vlm_extract', errorCode, {
        providerCalled: response?.providerCalled === true,
      });
    }
    ensure(response.schemaVersion === BRIDGE_RESPONSE_VERSION, 'PROVIDER_INVALID_OUTPUT', 'organizing');
    ensure(same(response.binding, binding), 'VERSION_MISMATCH', 'organizing');
    ensure(TERMINAL_STATUSES.has(response.status), 'PROVIDER_INVALID_OUTPUT', 'organizing');
    ensure(response.result && typeof response.result === 'object', 'PROVIDER_INVALID_OUTPUT', 'organizing');
    return {
      status: response.status,
      result: response.result,
      usage: usageFromBridge(response.usage),
    };
  }
}

export class StageAPipelineProcessor {
  constructor({
    featureProcessor,
    contextProvider,
    bridge,
    now = () => Date.now(),
    idFactory = () => `context-${randomUUID()}`,
  }) {
    this.featureProcessor = featureProcessor;
    this.contextProvider = contextProvider;
    this.bridge = bridge;
    this.now = now;
    this.idFactory = idFactory;
  }

  async process({ lease, identity, files, versions, signal, checkpoint = async () => {} }) {
    let featureBundle;
    try {
      featureBundle = await this.featureProcessor.process({ lease, files, versions, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof WorkerExecutionError) || error.errorCode !== 'FEATURE_SERVICE_UNAVAILABLE') throw error;
      featureBundle = failureBundle({ lease, files, versions, now: this.now });
    }

    await checkpoint('retrieval', 45);
    const requestId = this.idFactory();
    const contextResponse = await this.contextProvider.executionContext(lease.jobId, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      identity,
    }, { signal });
    const execution = validateExecutionContext(contextResponse, {
      requestId,
      identity,
      lease,
    });

    await checkpoint('vlm_extract', 55);
    const derivedFeatures = buildDerivedFeatures(featureBundle.result, execution);
    const classified = await this.bridge.run({ identity, lease, execution, derivedFeatures, files, signal });
    await checkpoint('organizing', 80);
    const status = featureBundle.status === 'needs_review' || classified.status === 'needs_review'
      ? 'needs_review'
      : 'succeeded';
    return {
      status,
      result: {
        schemaVersion: PIPELINE_RESULT_VERSION,
        generatedAt: new Date(this.now()).toISOString(),
        jobId: lease.jobId,
        runId: lease.runId,
        scope: lease.scope,
        authorizationRevision: lease.authorizationRevision,
        inputHash: lease.inputHash,
        executionProfileDigest: lease.executionProfileDigest,
        versions,
        featureBundle: featureBundle.result,
        derivedFeatures,
        classification: classified.result,
      },
      usage: classified.usage,
    };
  }
}
