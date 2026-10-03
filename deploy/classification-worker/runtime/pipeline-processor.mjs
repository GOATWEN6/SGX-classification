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
export const DERIVED_FEATURES_VERSION = 'classification-worker-derived-features.2';
export const HISTORICAL_RETRIEVAL_SCHEMA_VERSION = '2.0';
export const HISTORICAL_RETRIEVAL_CONTRACT_VERSION = 'classification-historical-retrieval.2';
const EMPTY_DERIVED_FEATURES = Object.freeze({
  version: DERIVED_FEATURES_VERSION,
  ocrTextByEvidenceId: Object.freeze({}),
  faceCandidatesByEvidenceId: Object.freeze({}),
  retrievalHints: Object.freeze([]),
  historicalCandidates: Object.freeze([]),
  embeddingRetrieval: 'not_applicable',
  faceRetrieval: 'not_applicable',
  historicalRetrieval: 'not_applicable',
});

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FACE_ID_PATTERN = /^face_[a-f0-9]{32}$/;
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
const BRIDGE_DIAGNOSTIC_PATTERN = /^BRIDGE_[A-Z0-9_]{3,96}$/;
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

function safeBridgeDiagnostic(response, stderr, exit) {
  if (BRIDGE_DIAGNOSTIC_PATTERN.test(response?.diagnosticCode ?? '')) {
    return response.diagnosticCode;
  }
  const text = String(stderr ?? '').slice(0, 16_384);
  if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(text)) return 'BRIDGE_MODULE_LOAD_FAILED';
  if (/SyntaxError/.test(text)) return 'BRIDGE_SYNTAX_ERROR';
  if (/EACCES|EPERM/.test(text)) return 'BRIDGE_PERMISSION_DENIED';
  if (/heap out of memory|allocation failed/i.test(text)) return 'BRIDGE_RESOURCE_EXHAUSTED';
  if (exit?.signal) return 'BRIDGE_SIGNAL_EXIT';
  return 'BRIDGE_RESPONSE_UNAVAILABLE';
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

function failureBundle({ lease, files, versions, now, authorizedPersonEvidenceIds = new Set() }) {
  const evidence = files.map((file) => {
    const capabilities = file.evidence.modality === 'image'
      ? [
          'ocr',
          'image_embedding',
          ...(authorizedPersonEvidenceIds.has(file.evidence.evidenceId) ? ['face_embeddings'] : []),
        ]
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

function authorizedPersonEvidenceIds(execution, lease, files, personMatchingEnabled) {
  if (!personMatchingEnabled) return new Set();
  const guard = execution?.guard;
  ensure(guard && typeof guard === 'object', 'VERSION_MISMATCH', 'retrieval');
  if (guard.allowPersonMatching !== true) return new Set();
  ensure(guard.active === true, 'VERSION_MISMATCH', 'retrieval', 'person authorization is inactive');
  ensure(guard.authorizationRevision === lease.authorizationRevision,
    'VERSION_MISMATCH', 'retrieval', 'person authorization revision mismatch');
  ensure(same(guard.scope, lease.scope), 'VERSION_MISMATCH', 'retrieval', 'person authorization scope mismatch');
  ensure(Array.isArray(guard.personMatchingEvidenceIds) && Array.isArray(guard.evidence),
    'VERSION_MISMATCH', 'retrieval', 'person authorization evidence is missing');

  const fileByEvidenceId = new Map(files.map((file) => [file.evidence.evidenceId, file]));
  const guardByEvidenceId = new Map(guard.evidence.map((item) => [item?.evidenceId, item]));
  const authorized = new Set();
  for (const evidenceId of guard.personMatchingEvidenceIds) {
    ensure(typeof evidenceId === 'string' && !authorized.has(evidenceId),
      'VERSION_MISMATCH', 'retrieval', 'invalid person matching evidence');
    const file = fileByEvidenceId.get(evidenceId);
    const guarded = guardByEvidenceId.get(evidenceId);
    ensure(file?.evidence?.modality === 'image' && file.evidence.lifecycleState === 'active',
      'VERSION_MISMATCH', 'retrieval', 'person matching evidence is not an active image');
    ensure(guarded?.lifecycleState === 'active' && typeof guarded.personConsentRef === 'string'
      && guarded.personConsentRef.length > 0,
    'VERSION_MISMATCH', 'retrieval', 'person consent is missing');
    ensure(guarded.revision === file.evidence.revision && guarded.sourceHash === file.evidence.sourceHash,
      'VERSION_MISMATCH', 'retrieval', 'person evidence version mismatch');
    authorized.add(evidenceId);
  }
  return authorized;
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

function normalizedFaceBundle(value, sourceHash) {
  if (!value || typeof value !== 'object') return null;
  if (`sha256:${value.sourceSha256}` !== sourceHash
    || typeof value.detectorModelId !== 'string'
    || typeof value.detectorModelRevision !== 'string'
    || typeof value.embeddingModelId !== 'string'
    || typeof value.embeddingModelRevision !== 'string'
    || !Number.isInteger(value.dimensions) || value.dimensions < 1
    || value.normalized !== true || !Array.isArray(value.faces)) return null;
  const seen = new Set();
  const faces = [];
  for (const face of value.faces) {
    const bounds = face?.bounds;
    const detectorScore = face?.detectorScore;
    const vector = Array.isArray(face?.vector) ? face.vector.map(Number) : [];
    if (!FACE_ID_PATTERN.test(face?.faceId ?? '') || seen.has(face.faceId)
      || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger)
      || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0
      || (detectorScore !== undefined && detectorScore !== null
        && (!Number.isFinite(detectorScore) || detectorScore < 0 || detectorScore > 1))
      || vector.length !== value.dimensions || vector.some((item) => !Number.isFinite(item))) return null;
    const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
    if (!Number.isFinite(norm) || norm <= 0) return null;
    seen.add(face.faceId);
    faces.push({
      faceId: face.faceId,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
      ...(detectorScore === undefined || detectorScore === null ? {} : { detectorScore }),
      vector: vector.map((item) => item / norm),
    });
  }
  return {
    detectorModelId: value.detectorModelId,
    detectorModelRevision: value.detectorModelRevision,
    embeddingModelId: value.embeddingModelId,
    embeddingModelRevision: value.embeddingModelRevision,
    dimensions: value.dimensions,
    faces,
  };
}

function faceSimilarity(leftFaces, rightFaces) {
  let best = -Infinity;
  for (const left of leftFaces) {
    for (const right of rightFaces) {
      const similarity = left.vector.reduce((sum, value, index) => sum + value * right.vector[index], 0);
      if (similarity > best) best = similarity;
    }
  }
  return best;
}

function containsHistoricalSecret(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsHistoricalSecret);
  return Object.entries(value).some(([key, child]) => (
    ['vector', 'similarity', 'retrievalScore', 'probability'].includes(key)
      || containsHistoricalSecret(child)
  ));
}

function validateHistoricalRetrievalResult(raw, { lease, sources, maxCandidatesPerSource, currentEvidenceIds }) {
  ensure(raw && typeof raw === 'object', 'VERSION_MISMATCH', 'retrieval');
  ensure(raw.schemaVersion === HISTORICAL_RETRIEVAL_SCHEMA_VERSION
    && raw.contractVersion === HISTORICAL_RETRIEVAL_CONTRACT_VERSION,
  'VERSION_MISMATCH', 'retrieval');
  ensure(same(raw.scope, lease.scope) && raw.authorizationRevision === lease.authorizationRevision,
    'VERSION_MISMATCH', 'retrieval');
  ensure(raw.scoreMeaning === 'retrieval_order_not_probability'
    && Array.isArray(raw.candidates) && Array.isArray(raw.traces),
  'VERSION_MISMATCH', 'retrieval');
  ensure(!containsHistoricalSecret(raw), 'VERSION_MISMATCH', 'retrieval', 'historical response exposes a score or vector');
  const sourceByKey = new Map(sources.map((source) => [[
    source.sourceEvidenceId,
    source.kind,
    source.sourceFaceId ?? '',
  ].join('/'), source]));
  const seen = new Set();
  const candidateById = new Map();
  for (const candidate of raw.candidates) {
    ensure(candidate && typeof candidate === 'object'
      && typeof candidate.candidateId === 'string' && !seen.has(candidate.candidateId),
    'VERSION_MISMATCH', 'retrieval');
    seen.add(candidate.candidateId);
    candidateById.set(candidate.candidateId, candidate);
    const source = sourceByKey.get([
      candidate.sourceEvidenceId,
      candidate.kind,
      candidate.sourceFaceId ?? '',
    ].join('/'));
    const projection = candidate.historicalProjection;
    ensure(source && candidate.sourceContentId === source.sourceContentId
      && candidate.modelId === source.modelId && candidate.modelRevision === source.modelRevision,
    'VERSION_MISMATCH', 'retrieval');
    ensure(Number.isInteger(candidate.rank) && candidate.rank >= 1
      && candidate.rank <= maxCandidatesPerSource,
    'VERSION_MISMATCH', 'retrieval');
    ensure(!currentEvidenceIds.has(candidate.historicalEvidenceId)
      && projection && projection.lifecycleState === 'active'
      && candidate.historicalContentId === projection.contentId
      && candidate.historicalEvidenceId === projection.evidenceId
      && SHA256_PATTERN.test(projection.sourceHash ?? '')
      && typeof projection.artifactId === 'string'
      && typeof projection.consentRef === 'string'
      && Number.isInteger(projection.byteLength) && projection.byteLength > 0,
    'VERSION_MISMATCH', 'retrieval');
    ensure(Array.isArray(candidate.reasons) && candidate.reasons.length > 0
      && Array.isArray(candidate.featureRefs) && candidate.featureRefs.length > 0
      && Array.isArray(candidate.evidenceRefs)
      && candidate.evidenceRefs.includes(candidate.sourceEvidenceId)
      && candidate.evidenceRefs.includes(candidate.historicalEvidenceId),
    'VERSION_MISMATCH', 'retrieval');
    if (candidate.kind === 'face_embedding') {
      ensure(FACE_ID_PATTERN.test(candidate.sourceFaceId ?? '')
        && FACE_ID_PATTERN.test(projection.faceId ?? '')
        && typeof projection.personConsentRef === 'string',
      'VERSION_MISMATCH', 'retrieval');
    } else {
      ensure(candidate.sourceFaceId === undefined
        && projection.faceId === undefined && projection.personConsentRef === undefined,
      'VERSION_MISMATCH', 'retrieval');
    }
  }
  ensure(raw.traces.length === sources.length, 'VERSION_MISMATCH', 'retrieval');
  const traceKeys = new Set();
  for (const trace of raw.traces) {
    const key = [trace?.sourceEvidenceId, trace?.kind, trace?.sourceFaceId ?? ''].join('/');
    const source = sourceByKey.get(key);
    ensure(source && !traceKeys.has(key) && trace.sourceContentId === source.sourceContentId
      && Number.isInteger(trace.eligibleCount) && trace.eligibleCount >= 0
      && ['complete', 'truncated'].includes(trace.coverage)
      && Array.isArray(trace.selectedCandidateIds)
      && trace.selectedCandidateIds.length <= maxCandidatesPerSource,
    'VERSION_MISMATCH', 'retrieval');
    traceKeys.add(key);
    for (const candidateId of trace.selectedCandidateIds) {
      const candidate = candidateById.get(candidateId);
      ensure(candidate && candidate.sourceEvidenceId === source.sourceEvidenceId
        && candidate.kind === source.kind
        && (candidate.sourceFaceId ?? '') === (source.sourceFaceId ?? ''),
      'VERSION_MISMATCH', 'retrieval');
    }
  }
  return structuredClone(raw);
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
  const faceCandidatesByEvidenceId = {};
  const textVectorsByImageContentId = new Map();
  const images = [];
  const historicalSources = [];
  const personConsentByEvidenceId = new Map((execution?.guard?.evidence ?? [])
    .filter((item) => typeof item?.evidenceId === 'string' && typeof item?.personConsentRef === 'string')
    .map((item) => [item.evidenceId, item.personConsentRef]));
  const allowedFaceEvidenceIds = new Set(
    execution?.guard?.active === true && execution.guard.allowPersonMatching === true
      ? execution.guard.personMatchingEvidenceIds ?? []
      : [],
  );
  let invalidFaceFeature = false;
  for (const item of featureBundle.evidence) {
    ensure(typeof item.evidenceId === 'string' && typeof item.contentId === 'string'
      && SHA256_PATTERN.test(item.sourceHash ?? ''), 'VERSION_MISMATCH', 'retrieval');
    if (item.modality === 'image') {
      const sourceContent = contentByEvidenceId.get(item.evidenceId);
      ensure(sourceContent?.contentId === item.contentId
        && sourceContent.modality === item.modality, 'VERSION_MISMATCH', 'retrieval');
      const ocr = item.features?.ocr;
      if (ocr) {
        ensure(`sha256:${ocr.sourceSha256}` === item.sourceHash && Array.isArray(ocr.regions), 'VERSION_MISMATCH', 'retrieval');
        const text = ocr.regions.map((region) => String(region?.text ?? '').trim()).filter(Boolean).join('\n').slice(0, 16000);
        if (text) ocrTextByEvidenceId[item.evidenceId] = { sourceHash: item.sourceHash, text };
      }
      let faceBundle = null;
      if (item.features?.faceEmbeddings) {
        ensure(allowedFaceEvidenceIds.has(item.evidenceId),
          'VERSION_MISMATCH', 'retrieval', 'unauthorized face feature');
        faceBundle = normalizedFaceBundle(item.features.faceEmbeddings, item.sourceHash);
        invalidFaceFeature ||= !faceBundle;
        if (faceBundle) {
          faceCandidatesByEvidenceId[item.evidenceId] = {
            sourceHash: item.sourceHash,
            detectorModelId: faceBundle.detectorModelId,
            detectorModelRevision: faceBundle.detectorModelRevision,
            embeddingModelId: faceBundle.embeddingModelId,
            embeddingModelRevision: faceBundle.embeddingModelRevision,
            dimensions: faceBundle.dimensions,
            faces: faceBundle.faces.map(({ vector: _vector, ...metadata }) => metadata),
          };
        }
      }
      images.push({
        evidenceId: item.evidenceId,
        contentId: item.contentId,
        imageVector: normalizedVector(item.features?.imageEmbedding),
        faceBundle,
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
  const faceFailed = featureBundle.componentErrors.some((item) => item.capability === 'face_embeddings');
  const retrievalHints = [];
  const imageTextHints = [];
  if (!embeddingFailed) {
    const resolved = images.map((image) => ({
      ...image,
      // User text/final ASR is the primary semantic vector when it is bound
      // to the same content; the image vector is the fallback.
      vector: meanNormalized(textVectorsByImageContentId.get(image.contentId) ?? []) ?? image.imageVector,
    })).filter((item) => item.vector);
    historicalSources.push(...resolved.map((item) => ({
      sourceContentId: item.contentId,
      sourceEvidenceId: item.evidenceId,
      kind: 'image_text_embedding',
      modelId: item.vector.modelId,
      modelRevision: item.vector.modelRevision,
      dimensions: item.vector.dimensions,
      normalized: true,
      vector: item.vector.vector,
    })));
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
    imageTextHints.push(...[...pairHints.values()].sort((a, b) => a.rank - b.rank
      || a.leftPhotoId.localeCompare(b.leftPhotoId) || a.rightPhotoId.localeCompare(b.rightPhotoId)));
    retrievalHints.push(...imageTextHints);
  }
  const faceHints = [];
  if (!faceFailed && !invalidFaceFeature) {
    const resolved = images.filter((image) => image.faceBundle?.faces.length);
    for (const image of resolved) {
      const personConsentRef = personConsentByEvidenceId.get(image.evidenceId);
      ensure(typeof personConsentRef === 'string', 'VERSION_MISMATCH', 'retrieval', 'person consent is missing');
      for (const face of image.faceBundle.faces) {
        historicalSources.push({
          sourceContentId: image.contentId,
          sourceEvidenceId: image.evidenceId,
          sourceFaceId: face.faceId,
          kind: 'face_embedding',
          modelId: image.faceBundle.embeddingModelId,
          modelRevision: image.faceBundle.embeddingModelRevision,
          dimensions: image.faceBundle.dimensions,
          normalized: true,
          vector: face.vector,
          personConsentRef,
        });
      }
    }
    const pairHints = new Map();
    for (const left of resolved) {
      const neighbors = resolved.filter((right) => right.evidenceId !== left.evidenceId
        && right.faceBundle.embeddingModelId === left.faceBundle.embeddingModelId
        && right.faceBundle.embeddingModelRevision === left.faceBundle.embeddingModelRevision
        && right.faceBundle.dimensions === left.faceBundle.dimensions)
        .map((right) => ({
          right,
          similarity: faceSimilarity(left.faceBundle.faces, right.faceBundle.faces),
        }))
        .filter((item) => Number.isFinite(item.similarity))
        .sort((a, b) => b.similarity - a.similarity || a.right.evidenceId.localeCompare(b.right.evidenceId))
        .slice(0, maxCandidates);
      neighbors.forEach(({ right }, index) => {
        const [leftPhotoId, rightPhotoId] = [left.evidenceId, right.evidenceId].sort();
        const key = `${leftPhotoId}/${rightPhotoId}`;
        const candidate = {
          kind: 'face_embedding_topk',
          leftPhotoId,
          rightPhotoId,
          rank: index + 1,
          modelId: left.faceBundle.embeddingModelId,
          modelRevision: left.faceBundle.embeddingModelRevision,
        };
        const previous = pairHints.get(key);
        if (!previous || candidate.rank < previous.rank) pairHints.set(key, candidate);
      });
    }
    faceHints.push(...[...pairHints.values()].sort((a, b) => a.rank - b.rank
      || a.leftPhotoId.localeCompare(b.leftPhotoId) || a.rightPhotoId.localeCompare(b.rightPhotoId)));
    retrievalHints.push(...faceHints);
  }
  return {
    derivedFeatures: {
      version: DERIVED_FEATURES_VERSION,
      ocrTextByEvidenceId,
      faceCandidatesByEvidenceId,
      retrievalHints,
      historicalCandidates: [],
      embeddingRetrieval: embeddingFailed
        ? 'disabled_component_failure'
        : imageTextHints.length ? 'batch_topk' : 'not_applicable',
      faceRetrieval: faceFailed
        ? 'disabled_component_failure'
        : invalidFaceFeature ? 'disabled_invalid_feature'
          : faceHints.length ? 'batch_topk' : 'not_applicable',
      historicalRetrieval: 'not_applicable',
    },
    historicalSources,
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
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
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
      throw new WorkerExecutionError('INTERNAL_ERROR', 'vlm_extract', 'stage-a bridge could not start', {
        cause: error,
        diagnosticCode: 'BRIDGE_START_FAILED',
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (forceKill) clearTimeout(forceKill);
    }
    if (signal.aborted) throw signal.reason ?? new Error('aborted');

    let response;
    try {
      response = JSON.parse(await readFile(responsePath, 'utf8'));
    } catch (error) {
      throw new WorkerExecutionError('INTERNAL_ERROR', 'vlm_extract', 'stage-a bridge returned no valid response', {
        cause: error,
        diagnosticCode: safeBridgeDiagnostic(null, stderr, exit),
      });
    }
    if (exit.code !== 0) {
      if (STOP_REASONS.has(response?.stopReason)) throw new FenceStop(response.stopReason);
      const errorCode = PROVIDER_ERROR_CODES.has(response?.errorCode)
        ? response.errorCode
        : 'INTERNAL_ERROR';
      throw new WorkerExecutionError(errorCode, response?.stage ?? 'vlm_extract', errorCode, {
        providerCalled: response?.providerCalled === true,
        diagnosticCode: safeBridgeDiagnostic(response, stderr, exit),
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
    historicalRetrieval,
    bridge,
    now = () => Date.now(),
    idFactory = () => `context-${randomUUID()}`,
  }) {
    this.featureProcessor = featureProcessor;
    this.contextProvider = contextProvider;
    this.historicalRetrieval = historicalRetrieval;
    this.bridge = bridge;
    this.now = now;
    this.idFactory = idFactory;
  }

  async process({ lease, identity, files, versions, signal, checkpoint = async () => {} }) {
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
    const authorizedPersonEvidence = authorizedPersonEvidenceIds(
      execution,
      lease,
      files,
      this.featureProcessor.personMatchingEnabled === true,
    );

    let featureBundle;
    try {
      featureBundle = await this.featureProcessor.process({
        lease,
        files,
        versions,
        signal,
        authorizedPersonEvidenceIds: authorizedPersonEvidence,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof WorkerExecutionError) || error.errorCode !== 'FEATURE_SERVICE_UNAVAILABLE') throw error;
      featureBundle = failureBundle({
        lease,
        files,
        versions,
        now: this.now,
        authorizedPersonEvidenceIds: authorizedPersonEvidence,
      });
    }

    const built = buildDerivedFeatures(featureBundle.result, execution);
    const derivedFeatures = built.derivedFeatures;
    if (built.historicalSources.length && this.historicalRetrieval?.historicalQuery) {
      try {
        const historical = await this.historicalRetrieval.historicalQuery(lease.jobId, {
          protocolVersion: PROTOCOL_VERSION,
          requestId: this.idFactory(),
          identity,
          query: {
            schemaVersion: HISTORICAL_RETRIEVAL_SCHEMA_VERSION,
            contractVersion: HISTORICAL_RETRIEVAL_CONTRACT_VERSION,
            scope: lease.scope,
            authorizationRevision: lease.authorizationRevision,
            sources: built.historicalSources,
            maxCandidatesPerSource: execution.job.budgetPolicy.maxCandidatesPerContent,
            excludeEvidenceIds: files.map((file) => file.evidence.evidenceId),
          },
        }, { signal });
        const checked = validateHistoricalRetrievalResult(historical, {
          lease,
          sources: built.historicalSources,
          maxCandidatesPerSource: execution.job.budgetPolicy.maxCandidatesPerContent,
          currentEvidenceIds: new Set(files.map((file) => file.evidence.evidenceId)),
        });
        derivedFeatures.historicalCandidates = checked.candidates;
        derivedFeatures.historicalRetrieval = checked.candidates.length ? 'historical_topk' : 'no_candidates';
      } catch (error) {
        if (signal.aborted || error instanceof WorkerExecutionError) throw error;
        derivedFeatures.historicalRetrieval = 'disabled_component_failure';
      }
    } else if (built.historicalSources.length) {
      derivedFeatures.historicalRetrieval = 'not_configured';
    }
    await checkpoint('retrieval', 45);
    await checkpoint('vlm_extract', 55);
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
