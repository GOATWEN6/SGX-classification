#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BRIDGE_REQUEST_VERSION,
  BRIDGE_RESPONSE_VERSION,
} from './pipeline-processor.mjs';

const require = createRequire(import.meta.url);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
let providerCallObserved = false;

const SAFE_DIAGNOSTICS = new Map([
  ['BRIDGE_ARGUMENT_MISSING', 'BRIDGE_ARGUMENT_MISSING'],
  ['BRIDGE_ARGUMENT_INVALID', 'BRIDGE_ARGUMENT_INVALID'],
  ['LAB_RUN_IDENTITY_MISMATCH', 'BRIDGE_IDENTITY_MISMATCH'],
  ['LAB_PROVIDER_UNAVAILABLE', 'BRIDGE_PROVIDER_CONFIG_UNAVAILABLE'],
  ['AUTHORIZATION_REVOKED', 'BRIDGE_AUTHORIZATION_REVOKED'],
  ['AUTHORIZATION_CHANGED', 'BRIDGE_AUTHORIZATION_CHANGED'],
  ['INACTIVE_EVIDENCE', 'BRIDGE_EVIDENCE_INACTIVE'],
  ['EVIDENCE_CHANGED', 'BRIDGE_EVIDENCE_CHANGED'],
  ['LAB_RUN_TIMEOUT', 'BRIDGE_TIMEOUT'],
  ['TIMEOUT', 'BRIDGE_TIMEOUT'],
  ['INVALID_OUTPUT', 'BRIDGE_INVALID_OUTPUT'],
  ['MODEL_VERSION_MISMATCH', 'BRIDGE_MODEL_VERSION_MISMATCH'],
  ['MISSING_USAGE_OR_PROVENANCE', 'BRIDGE_MISSING_USAGE_OR_PROVENANCE'],
  ['RATE_LIMITED', 'BRIDGE_RATE_LIMITED'],
  ['PROVIDER_UNAVAILABLE', 'BRIDGE_PROVIDER_UNAVAILABLE'],
  ['PROVIDER_REJECTED', 'BRIDGE_PROVIDER_REJECTED'],
  ['OUTPUT_TRUNCATED', 'BRIDGE_OUTPUT_TRUNCATED'],
  ['RESPONSE_LIMIT', 'BRIDGE_RESPONSE_LIMIT'],
  ['BUDGET_EXHAUSTED', 'BRIDGE_BUDGET_EXHAUSTED'],
  ['BUDGET_OVERRUN', 'BRIDGE_BUDGET_OVERRUN'],
  ['RESERVATION_OVERRUN', 'BRIDGE_RESERVATION_OVERRUN'],
  ['MODEL_NOT_CONFIGURED', 'BRIDGE_MODEL_NOT_CONFIGURED'],
  ['AUTHORIZATION_CHECK_REQUIRED', 'BRIDGE_AUTHORIZATION_CHECK_REQUIRED'],
  ['PROVIDER_AUDIT_FAILED', 'BRIDGE_PROVIDER_AUDIT_FAILED'],
]);

const STAGE_DIAGNOSTIC_PHASES = new Set(['provider_envelope', 'content_json', 'schema']);
const SAFE_TOKEN = /^[A-Za-z0-9_$?.:-]{1,128}$/;

function stageDiagnostic(error) {
  const raw = error?.diagnostic;
  if (!raw || !STAGE_DIAGNOSTIC_PHASES.has(raw.phase) || !Array.isArray(raw.issues)) return undefined;
  const issues = raw.issues.slice(0, 20).flatMap((issue) => {
    if (!issue || !SAFE_TOKEN.test(issue.path ?? '') || !SAFE_TOKEN.test(issue.code ?? '')) return [];
    const keys = Array.isArray(issue.keys)
      ? issue.keys.filter((key) => SAFE_TOKEN.test(key)).slice(0, 20)
      : undefined;
    const expected = SAFE_TOKEN.test(issue.expected ?? '') ? issue.expected : undefined;
    return [{
      path: issue.path,
      code: issue.code,
      ...(keys?.length ? { keys } : {}),
      ...(expected ? { expected } : {}),
    }];
  });
  return issues.length ? { phase: raw.phase, issues } : undefined;
}

function diagnosticCode(error) {
  const raw = error instanceof Error ? error.message : '';
  if (SAFE_DIAGNOSTICS.has(raw)) return SAFE_DIAGNOSTICS.get(raw);
  if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') {
    return 'BRIDGE_MODULE_LOAD_FAILED';
  }
  if (error?.code === 'ENOENT') return 'BRIDGE_FILE_MISSING';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'BRIDGE_PERMISSION_DENIED';
  if (error instanceof SyntaxError) return 'BRIDGE_INVALID_JSON';
  return 'BRIDGE_UNCLASSIFIED_FAILURE';
}

function cliValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error('BRIDGE_ARGUMENT_MISSING');
  return process.argv[index + 1];
}

function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseNonnegative(value, fallback) {
  const parsed = Number(value ?? fallback);
  ensure(Number.isFinite(parsed) && parsed >= 0, 'LAB_RUN_IDENTITY_MISMATCH');
  return parsed;
}

function providerResponseRecorder(job) {
  const root = process.env.SGX_PROVIDER_AUDIT_DIR;
  if (!root) return undefined;
  ensure(path.isAbsolute(root), 'LAB_RUN_IDENTITY_MISMATCH');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, `${job.jobId}.provider-responses.jsonl`);
  return (entry) => {
    try {
      const bytes = Buffer.from(`${JSON.stringify({
        schemaVersion: 'classification-provider-response-audit.1',
        recordedAt: new Date().toISOString(),
        jobId: job.jobId,
        runId: job.runId,
        ...entry,
      })}\n`);
      ensure(bytes.length <= 1_100_000, 'PROVIDER_AUDIT_FAILED');
      const descriptor = openSync(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        fchmodSync(descriptor, 0o600);
        writeSync(descriptor, bytes);
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'PROVIDER_AUDIT_FAILED') throw error;
      throw new Error('PROVIDER_AUDIT_FAILED', { cause: error });
    }
  };
}

function bindingFromJob(job) {
  return {
    jobId: job.jobId,
    runId: job.runId,
    attemptRevision: job.attemptRevision,
    authorizationRevision: job.authorization.authorizationRevision,
  };
}

function mockTransport(model, onCall) {
  return async (_url, init) => {
    onCall();
    const body = JSON.parse(String(init.body));
    const user = body.messages?.[1]?.content;
    ensure(Array.isArray(user) && user[0] && typeof user[0].text === 'string', 'INVALID_OUTPUT');
    const call = JSON.parse(user[0].text);
    const value = call.stage === 'extract'
      ? {
        observations: (call.untrustedContext?.requestedPhotoIds ?? []).map((photoId) => ({
          photoId,
          people: [],
          mentions: [],
          times: [],
          places: [],
          events: [],
          scenes: [],
          unknownFacets: ['person', 'time', 'place', 'event', 'scene'],
          conflicts: [],
        })),
      }
      : {
        relations: (call.untrustedContext?.requestedPairs ?? []).map(([left, right]) => ({
          kind: 'event',
          left: { photoId: left },
          right: { photoId: right },
          decision: 'unknown',
          supports: [left, right].map((photoId) => ({
            photoId,
            source: 'visual',
            quote: '本地 mock 未形成同一事件证据',
          })),
          rationale: '本地 mock 只验证集成契约',
        })),
      };
    return new Response(JSON.stringify({
      id: `stage_a_bridge_mock_${Date.now()}`,
      model,
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
    }), { status: 200 });
  };
}

function mappedFailure(error, providerCalled) {
  const raw = error instanceof Error ? error.message : '';
  const diagnostic = stageDiagnostic(error);
  if (raw === 'CANCELLED') {
    return { stopReason: 'cancelled', stage: 'vlm_extract', providerCalled, diagnosticCode: diagnosticCode(error) };
  }
  if (raw === 'AUTHORIZATION_REVOKED' || raw === 'AUTHORIZATION_CHANGED') {
    return { stopReason: 'authorization_changed', stage: 'retrieval', providerCalled, diagnosticCode: diagnosticCode(error) };
  }
  if (raw === 'INACTIVE_EVIDENCE' || raw === 'EVIDENCE_CHANGED') {
    return { stopReason: 'evidence_inactive', stage: 'retrieval', providerCalled, diagnosticCode: diagnosticCode(error) };
  }
  if (raw === 'LAB_RUN_TIMEOUT' || raw === 'TIMEOUT') {
    return { errorCode: 'PROVIDER_TIMEOUT', stage: 'vlm_extract', providerCalled, diagnosticCode: diagnosticCode(error) };
  }
  if (raw === 'INVALID_OUTPUT' || raw === 'MODEL_VERSION_MISMATCH' || raw === 'MISSING_USAGE_OR_PROVENANCE') {
    return {
      errorCode: 'PROVIDER_INVALID_OUTPUT',
      stage: 'vlm_extract',
      providerCalled,
      diagnosticCode: diagnosticCode(error),
      ...(diagnostic ? { stageDiagnostic: diagnostic } : {}),
    };
  }
  if (raw === 'RATE_LIMITED') {
    return { errorCode: 'PROVIDER_RATE_LIMITED', stage: 'vlm_extract', providerCalled, diagnosticCode: diagnosticCode(error) };
  }
  if (['OUTPUT_TRUNCATED', 'RESPONSE_LIMIT'].includes(raw)) {
    return { errorCode: 'PROVIDER_INVALID_OUTPUT', stage: 'vlm_extract', providerCalled, diagnosticCode: diagnosticCode(error) };
  }
  if (['PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED', 'MODEL_NOT_CONFIGURED',
    'AUTHORIZATION_CHECK_REQUIRED', 'BUDGET_EXHAUSTED', 'BUDGET_OVERRUN',
    'RESERVATION_OVERRUN', 'PROVIDER_AUDIT_FAILED'].includes(raw)) {
    return { errorCode: 'INTERNAL_ERROR', stage: 'vlm_extract', providerCalled, diagnosticCode: diagnosticCode(error) };
  }
  return {
    errorCode: 'INTERNAL_ERROR',
    stage: providerCalled ? 'vlm_extract' : 'retrieval',
    providerCalled,
    diagnosticCode: diagnosticCode(error),
  };
}

async function verifyEvidenceFiles(request, job, requestRoot) {
  ensure(Array.isArray(request.evidenceFiles) && request.evidenceFiles.length > 0, 'LAB_RUN_IDENTITY_MISMATCH');
  const activeEvidence = job.envelope.evidence
    .filter((item) => item.lifecycleState === 'active')
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const provided = [...request.evidenceFiles].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  ensure(activeEvidence.length === provided.length, 'EVIDENCE_CHANGED');
  const files = new Map();
  const contentByEvidenceId = new Map(job.envelope.contents.map((item) => [item.evidenceId, item]));
  const canonicalRoot = await realpath(requestRoot);
  for (let index = 0; index < activeEvidence.length; index += 1) {
    const expected = activeEvidence[index];
    const actual = provided[index];
    ensure(expected.evidenceId === actual.evidenceId, 'EVIDENCE_CHANGED');
    ensure(contentByEvidenceId.get(expected.evidenceId)?.contentId === actual.contentId, 'EVIDENCE_CHANGED');
    ensure(expected.revision === actual.revision, 'EVIDENCE_CHANGED');
    ensure(expected.sourceHash === actual.sourceHash, 'EVIDENCE_CHANGED');
    ensure(contentByEvidenceId.get(expected.evidenceId)?.modality === actual.modality, 'EVIDENCE_CHANGED');
    ensure(SHA256_PATTERN.test(actual.sourceHash), 'EVIDENCE_CHANGED');
    ensure(path.isAbsolute(actual.sourcePath), 'EVIDENCE_CHANGED');
    const canonical = await realpath(actual.sourcePath);
    ensure(canonical.startsWith(`${canonicalRoot}${path.sep}`), 'EVIDENCE_CHANGED');
    const fileStat = await stat(canonical);
    ensure(fileStat.isFile() && fileStat.size === actual.byteLength, 'EVIDENCE_CHANGED');
    const bytes = await readFile(canonical);
    const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    ensure(actualHash === actual.sourceHash, 'EVIDENCE_CHANGED');
    if (actual.modality === 'user_text' || actual.modality === 'final_asr') {
      ensure(job.originalTextByEvidenceId[actual.evidenceId] === bytes.toString('utf8'), 'EVIDENCE_CHANGED');
    }
    files.set(actual.evidenceId, bytes);
  }
  return files;
}

async function execute(requestPath, responsePath) {
  ensure(path.isAbsolute(requestPath) && path.isAbsolute(responsePath), 'BRIDGE_ARGUMENT_INVALID');
  ensure(path.dirname(requestPath) === path.dirname(responsePath), 'BRIDGE_ARGUMENT_INVALID');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  ensure(request.schemaVersion === BRIDGE_REQUEST_VERSION, 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(request.binding && request.execution && request.derivedFeatures, 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(request.derivedFeatures.version === 'classification-worker-derived-features.2', 'LAB_RUN_IDENTITY_MISMATCH');

  const buildDir = process.env.SGX_CLASSIFICATION_BUILD_DIR;
  ensure(buildDir && path.isAbsolute(buildDir), 'LAB_PROVIDER_UNAVAILABLE');
  const base = path.join(buildDir, 'src/lib/algorithms/classification');
  const contract = require(path.join(base, 'lab-execution-contract.js'));
  const stageA = require(path.join(base, 'lab-stage-a-executor.js'));

  const job = contract.parseLabJobV2(request.execution.job);
  const guard = contract.parseTrustedLabGuardSnapshot(request.execution.guard);
  const profile = contract.LabExecutionProfileSchema.parse(job.executionProfile);
  const identity = bindingFromJob(job);
  ensure(identity.jobId === request.binding.jobId, 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(identity.runId === request.binding.runId, 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(identity.attemptRevision === request.binding.attemptRevision, 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(identity.authorizationRevision === request.binding.authorizationRevision, 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(stable(job.envelope.scope) === stable(request.binding.scope), 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(stable(guard.scope) === stable(request.binding.scope), 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(guard.actorId === job.authorization.actorId, 'AUTHORIZATION_CHANGED');
  ensure(guard.authorityRef === job.authorization.authorityRef, 'AUTHORIZATION_CHANGED');
  ensure(guard.authorizationRevision === request.binding.authorizationRevision, 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(guard.contextRevision === job.authorization.contextRevision, 'AUTHORIZATION_CHANGED');
  ensure(guard.purposes.includes('classification'), 'AUTHORIZATION_CHANGED');
  ensure(contract.computeLabGrantDigest(guard) === job.authorization.grantDigest, 'AUTHORIZATION_CHANGED');
  ensure(guard.guardDigest === job.authorization.initialGuardDigest, 'LAB_RUN_IDENTITY_MISMATCH');
  ensure(guard.active && job.authorization.state === 'active', 'AUTHORIZATION_REVOKED');
  ensure(['pending', 'processing'].includes(job.status), 'LAB_RUN_IDENTITY_MISMATCH');
  const trustedEvidence = new Map(guard.evidence.map((item) => [item.evidenceId, item]));
  ensure(trustedEvidence.size === job.envelope.evidence.length, 'EVIDENCE_CHANGED');
  for (const evidence of job.envelope.evidence) {
    const trusted = trustedEvidence.get(evidence.evidenceId);
    ensure(evidence.lifecycleState === 'active', 'EVIDENCE_CHANGED');
    ensure(trusted?.lifecycleState === 'active', 'EVIDENCE_CHANGED');
    ensure(trusted.revision === evidence.revision, 'EVIDENCE_CHANGED');
    ensure(trusted.sourceHash === evidence.sourceHash, 'EVIDENCE_CHANGED');
    ensure(trusted.consentRef === evidence.consentRef, 'AUTHORIZATION_CHANGED');
    ensure(guard.allowedConsentRefs.includes(evidence.consentRef), 'AUTHORIZATION_CHANGED');
  }

  const files = await verifyEvidenceFiles(request, job, path.dirname(requestPath));
  const provider = process.env.SGX_VLM_PROVIDER ?? 'qwen';
  ensure(provider === 'qwen' || provider === 'glm', 'LAB_RUN_IDENTITY_MISMATCH');
  const model = process.env.SGX_VLM_MODEL ?? profile.modelVersion;
  ensure(model === profile.modelVersion, 'LAB_RUN_IDENTITY_MISMATCH');
  const inputCnyPerMillion = parseNonnegative(
    process.env.SGX_VLM_INPUT_CNY_PER_MILLION,
    profile.providerMode === 'stage_a_mock' ? 0 : undefined,
  );
  const outputCnyPerMillion = parseNonnegative(
    process.env.SGX_VLM_OUTPUT_CNY_PER_MILLION,
    profile.providerMode === 'stage_a_mock' ? 0 : undefined,
  );
  const markProviderCalled = () => { providerCallObserved = true; };
  const transport = profile.providerMode === 'stage_a_mock'
    ? mockTransport(model, markProviderCalled)
    : async (...args) => {
      markProviderCalled();
      return fetch(...args);
    };
  const credential = profile.providerMode === 'stage_a_real'
    ? () => {
      const value = process.env.SGX_D4_API_KEY;
      ensure(value, 'LAB_PROVIDER_UNAVAILABLE');
      return value;
    }
    : undefined;
  const recordProviderResponse = providerResponseRecorder(job);
  const factory = new stageA.StageALabExecutorFactory({
    profile,
    provider,
    model,
    inputCnyPerMillion,
    outputCnyPerMillion,
    placeKindPolicy: request.execution.placeKindPolicy,
    transport,
    ...(recordProviderResponse ? { recordProviderResponse } : {}),
    ...(credential ? { credential } : {}),
  });
  const controller = new AbortController();
  for (const signalName of ['SIGINT', 'SIGTERM']) {
    process.once(signalName, () => controller.abort(new Error('CANCELLED')));
  }
  const clock = {
    nowMs: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const context = {
    job,
    signal: controller.signal,
    clock,
    getGuard: async () => structuredClone(guard),
    readAsset: async (evidenceId) => {
      ensure(files.has(evidenceId), 'EVIDENCE_CHANGED');
      return new Uint8Array(files.get(evidenceId));
    },
    derivedFeatures: request.derivedFeatures,
  };
  const executor = factory.create(profile, context);
  const outcome = contract.parseLabExecutionOutcome(await executor.execute(context), profile);
  return {
    response: {
      schemaVersion: BRIDGE_RESPONSE_VERSION,
      binding: request.binding,
      status: outcome.result.workflowStatus,
      result: outcome.result,
      usage: {
        providerLatencyMs: outcome.metrics.latencyMs,
        inputTokens: outcome.metrics.inputTokens,
        outputTokens: outcome.metrics.outputTokens,
        costCny: outcome.metrics.costCny,
        providerCalls: outcome.metrics.modelRequests,
      },
    },
    providerCalled: providerCallObserved,
  };
}

const requestPath = cliValue('--request');
const responsePath = cliValue('--response');
try {
  const completed = await execute(requestPath, responsePath);
  await writeFile(responsePath, JSON.stringify(completed.response), { mode: 0o600, flag: 'wx' });
} catch (error) {
  const failure = mappedFailure(error, providerCallObserved);
  try {
    await writeFile(responsePath, JSON.stringify({
      schemaVersion: BRIDGE_RESPONSE_VERSION,
      ...failure,
    }), { mode: 0o600, flag: 'wx' });
  } catch {
    // Parent reports the stable bridge error when no response can be written.
  }
  process.exitCode = 2;
}
