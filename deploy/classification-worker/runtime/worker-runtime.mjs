import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PROTOCOL_VERSION = 'classification-worker-control-plane.v1';
export const FEATURE_BUNDLE_VERSION = 'classification-worker-feature-bundle.1';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEARTBEAT_STAGES = new Set([
  'downloading',
  'features',
  'retrieval',
  'vlm_extract',
  'vlm_relate',
  'organizing',
  'uploading',
]);
const CANCEL_REASONS = new Set([
  'cancelled',
  'authorization_changed',
  'deadline_exceeded',
  'evidence_inactive',
]);
const HEARTBEAT_CONTROLS = new Set([
  'continue',
  'cancel',
  'authorization_changed',
  'deadline_exceeded',
]);

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function ensure(condition, code, stage, message = code) {
  if (!condition) throw new WorkerExecutionError(code, stage, message);
}

function parseTimestamp(value, code, stage) {
  const parsed = Date.parse(value);
  ensure(Number.isFinite(parsed), code, stage);
  return parsed;
}

function emptyUsage(startedAt, now) {
  return {
    endToEndLatencyMs: Math.max(0, now() - startedAt),
    providerLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costCny: 0,
    providerCalls: 0,
  };
}

function runIdentity(workerId, lease) {
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

function terminalKey(lease) {
  return [lease.jobId, lease.runId, lease.attemptRevision].join(':');
}

function safeExtension(mimeType) {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/heic') return '.heic';
  return '.bin';
}

export class WorkerExecutionError extends Error {
  constructor(errorCode, stage, message = errorCode, options = {}) {
    super(message, options);
    this.name = 'WorkerExecutionError';
    this.errorCode = errorCode;
    this.stage = stage;
    this.providerCalled = options.providerCalled === true;
    this.diagnosticCode = typeof options.diagnosticCode === 'string'
      ? options.diagnosticCode
      : undefined;
    // This runtime never schedules an automatic retry. A later attempt requires
    // a new control-plane decision and identity.
    this.retryable = false;
  }
}

export class FenceStop extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'FenceStop';
    this.reason = reason;
  }
}

export class TerminalStateUnknownError extends Error {
  constructor(operation, cause) {
    super(`terminal state unknown after ${operation}`, { cause });
    this.name = 'TerminalStateUnknownError';
    this.operation = operation;
  }
}

export function createJsonLogger(writeLine = (line) => process.stdout.write(`${line}\n`)) {
  const emit = (level, event, fields = {}) => {
    // Call sites intentionally pass identifiers and stable codes only. Never
    // pass lease tokens, signed URLs, source text, media paths or face vectors.
    writeLine(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    }));
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

class LeaseFence {
  constructor({
    controlPlane,
    identity,
    leaseExpiresAt,
    deadlineAt,
    heartbeatIntervalMs,
    now,
    idFactory,
    setIntervalFn,
    clearIntervalFn,
  }) {
    this.controlPlane = controlPlane;
    this.identity = identity;
    this.leaseExpiresAtMs = parseTimestamp(leaseExpiresAt, 'VERSION_MISMATCH', 'lease');
    this.deadlineAtMs = parseTimestamp(deadlineAt, 'VERSION_MISMATCH', 'lease');
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.now = now;
    this.idFactory = idFactory;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.abortController = new AbortController();
    this.stage = 'downloading';
    this.progress = 0;
    this.timer = null;
    this.inFlight = null;
    this.stopReason = null;
    this.backgroundError = null;
  }

  start() {
    if (this.timer || this.heartbeatIntervalMs <= 0) return;
    this.timer = this.setIntervalFn(() => {
      void this.#tick().catch((error) => {
        this.backgroundError = error;
        this.abortController.abort(error);
      });
    }, this.heartbeatIntervalMs);
  }

  async stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // The caller observes backgroundError through assertActive().
      }
    }
  }

  #assertTime() {
    if (this.stopReason) throw new FenceStop(this.stopReason);
    if (this.backgroundError) throw this.backgroundError;
    const current = this.now();
    if (current >= this.deadlineAtMs || current >= this.leaseExpiresAtMs) {
      this.stopReason = 'deadline_exceeded';
      const error = new FenceStop(this.stopReason);
      this.abortController.abort(error);
      throw error;
    }
  }

  assertActive() {
    this.#assertTime();
    if (this.abortController.signal.aborted) {
      if (this.stopReason) throw new FenceStop(this.stopReason);
      throw this.backgroundError ?? new WorkerExecutionError('INTERNAL_ERROR', this.stage);
    }
  }

  async checkpoint(stage, progress) {
    ensure(HEARTBEAT_STAGES.has(stage), 'INTERNAL_ERROR', stage);
    this.stage = stage;
    this.progress = progress;
    this.#assertTime();
    await this.#tick();
    this.#assertTime();
  }

  async #tick() {
    if (this.inFlight) return this.inFlight;
    this.#assertTime();
    this.inFlight = (async () => {
      let response;
      const requestId = this.idFactory();
      try {
        response = await this.controlPlane.heartbeat(this.identity.jobId, {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          identity: this.identity,
          progress: this.progress,
          stage: this.stage,
        }, { signal: this.abortController.signal });
      } catch (error) {
        if (this.stopReason) throw new FenceStop(this.stopReason);
        throw new WorkerExecutionError('INTERNAL_ERROR', this.stage, 'heartbeat failed', { cause: error });
      }
      ensure(response?.protocolVersion === PROTOCOL_VERSION, 'VERSION_MISMATCH', this.stage);
      ensure(response.requestId === requestId, 'VERSION_MISMATCH', this.stage);
      ensure(HEARTBEAT_CONTROLS.has(response.control), 'VERSION_MISMATCH', this.stage);
      this.leaseExpiresAtMs = parseTimestamp(response.leaseExpiresAt, 'VERSION_MISMATCH', this.stage);
      if (response.control !== 'continue') {
        this.stopReason = response.control === 'cancel' ? 'cancelled' : response.control;
        const stopped = new FenceStop(this.stopReason);
        this.abortController.abort(stopped);
        throw stopped;
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
}

async function prepareScratch(scratchRoot, lease) {
  ensure(path.isAbsolute(scratchRoot), 'INTERNAL_ERROR', 'lease');
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(scratchRoot);
  ensure(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'INTERNAL_ERROR', 'lease');
  const canonicalRoot = await realpath(scratchRoot);
  ensure(ID_PATTERN.test(lease.jobId) && ID_PATTERN.test(lease.runId), 'VERSION_MISMATCH', 'lease');
  const jobRoot = path.join(canonicalRoot, lease.jobId);
  const runRoot = path.join(jobRoot, lease.runId);
  await mkdir(jobRoot, { recursive: true, mode: 0o700 });
  const jobStat = await lstat(jobRoot);
  ensure(jobStat.isDirectory() && !jobStat.isSymbolicLink(), 'INTERNAL_ERROR', 'lease');
  try {
    await mkdir(runRoot, { mode: 0o700 });
  } catch (error) {
    throw new WorkerExecutionError('INTERNAL_ERROR', 'lease', 'scratch attempt already exists', { cause: error });
  }
  return { jobRoot, runRoot };
}

async function cleanupScratch({ runRoot, jobRoot }) {
  if (!runRoot) return true;
  try {
    await rm(runRoot, { recursive: true, force: true });
    if (jobRoot) {
      try {
        await rmdir(jobRoot);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function validateLease(lease) {
  ensure(lease && typeof lease === 'object', 'VERSION_MISMATCH', 'lease');
  for (const key of ['jobId', 'runId', 'authorizationRevision']) {
    ensure(ID_PATTERN.test(lease[key] ?? ''), 'VERSION_MISMATCH', 'lease');
  }
  ensure(typeof lease.leaseToken === 'string' && lease.leaseToken.length >= 32, 'VERSION_MISMATCH', 'lease');
  ensure(Number.isInteger(lease.jobRevision) && lease.jobRevision >= 1, 'VERSION_MISMATCH', 'lease');
  ensure(Number.isInteger(lease.attemptRevision) && lease.attemptRevision >= 1, 'VERSION_MISMATCH', 'lease');
  ensure(SHA256_PATTERN.test(lease.inputHash ?? ''), 'VERSION_MISMATCH', 'lease');
  ensure(SHA256_PATTERN.test(lease.executionProfileDigest ?? ''), 'VERSION_MISMATCH', 'lease');
  ensure(Array.isArray(lease.evidence) && lease.evidence.length > 0, 'VERSION_MISMATCH', 'lease');
  ensure(lease.resultUpload?.mimeType === 'application/json', 'VERSION_MISMATCH', 'lease');
  const evidenceIds = new Set();
  const artifactIds = new Set();
  for (const evidence of lease.evidence) {
    ensure(ID_PATTERN.test(evidence.evidenceId ?? ''), 'VERSION_MISMATCH', 'lease');
    ensure(ID_PATTERN.test(evidence.contentId ?? ''), 'VERSION_MISMATCH', 'lease');
    ensure(!evidenceIds.has(evidence.evidenceId), 'VERSION_MISMATCH', 'lease');
    evidenceIds.add(evidence.evidenceId);
    if (evidence.lifecycleState !== 'active') throw new FenceStop('evidence_inactive');
    ensure(SHA256_PATTERN.test(evidence.sourceHash ?? ''), 'VERSION_MISMATCH', 'lease');
    if (evidence.modality === 'image') {
      ensure(evidence.artifact && !evidence.inlineText, 'VERSION_MISMATCH', 'lease');
      ensure(evidence.sourceHash === evidence.artifact.sha256, 'HASH_MISMATCH', 'downloading');
      ensure(!artifactIds.has(evidence.artifact.artifactId), 'VERSION_MISMATCH', 'lease');
      artifactIds.add(evidence.artifact.artifactId);
    } else {
      ensure(['user_text', 'final_asr'].includes(evidence.modality), 'VERSION_MISMATCH', 'lease');
      ensure(evidence.inlineText && !evidence.artifact, 'VERSION_MISMATCH', 'lease');
      ensure(evidence.sourceHash === evidence.inlineText.sha256, 'HASH_MISMATCH', 'downloading');
    }
  }
}

async function materializeEvidence({ lease, runRoot, artifacts, fence, now }) {
  const files = [];
  for (const [index, evidence] of lease.evidence.entries()) {
    fence.assertActive();
    if (evidence.modality === 'image') {
      ensure(now() < parseTimestamp(evidence.artifact.expiresAt, 'DOWNLOAD_FAILED', 'downloading'), 'DOWNLOAD_FAILED', 'downloading');
      const destination = path.join(runRoot, `${evidence.artifact.artifactId}${safeExtension(evidence.artifact.mimeType)}`);
      let downloaded;
      try {
        downloaded = await artifacts.downloadToFile({
          url: evidence.artifact.downloadUrl,
          destination,
          expectedByteLength: evidence.artifact.byteLength,
          maxByteLength: evidence.artifact.byteLength,
          signal: fence.abortController.signal,
        });
      } catch (error) {
        if (fence.stopReason) throw new FenceStop(fence.stopReason);
        throw new WorkerExecutionError('DOWNLOAD_FAILED', 'downloading', 'artifact download failed', { cause: error });
      }
      ensure(downloaded.byteLength === evidence.artifact.byteLength, 'HASH_MISMATCH', 'downloading');
      ensure(downloaded.sha256 === evidence.artifact.sha256, 'HASH_MISMATCH', 'downloading');
      files.push({ evidence, sourcePath: destination, byteLength: downloaded.byteLength });
    } else {
      const bytes = Buffer.from(evidence.inlineText.text, 'utf8');
      ensure(sha256(bytes) === evidence.inlineText.sha256, 'HASH_MISMATCH', 'downloading');
      const destination = path.join(runRoot, `inline-${index}.txt`);
      await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
      files.push({ evidence, sourcePath: destination, byteLength: bytes.length });
    }
  }
  return files;
}

export class LocalFeatureBundleProcessor {
  constructor({ featureService, personMatchingEnabled = false, now = () => Date.now() }) {
    this.featureService = featureService;
    this.personMatchingEnabled = personMatchingEnabled;
    this.now = now;
  }

  async process({ lease, files, versions, signal, authorizedPersonEvidenceIds = [] }) {
    const authorizedPersonEvidence = new Set(authorizedPersonEvidenceIds);
    const evidenceResults = [];
    const componentErrors = [];
    let successes = 0;
    const invoke = async (capability, file, call) => {
      try {
        const value = await call();
        successes += 1;
        return value;
      } catch (error) {
        if (signal.aborted) throw error;
        componentErrors.push({
          evidenceId: file.evidence.evidenceId,
          capability,
          errorCode: typeof error?.code === 'string' ? error.code : 'FEATURE_COMPONENT_FAILED',
        });
        return null;
      }
    };

    for (const file of files) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const source = {
        sourcePath: file.sourcePath,
        sourceSha256: file.evidence.sourceHash.slice('sha256:'.length),
        sourceByteLength: file.byteLength,
      };
      const features = {};
      if (file.evidence.modality === 'image') {
        features.ocr = await invoke('ocr', file, () => this.featureService.ocr(source, { signal }));
        features.imageEmbedding = await invoke('image_embedding', file, () => this.featureService.imageEmbedding(source, { signal }));
        if (this.personMatchingEnabled && authorizedPersonEvidence.has(file.evidence.evidenceId)) {
          features.faceEmbeddings = await invoke('face_embeddings', file, () => this.featureService.faceEmbeddings(source, { signal }));
        }
      } else {
        features.textEmbedding = await invoke('text_embedding', file, () => this.featureService.textEmbedding(source, { signal }));
      }
      evidenceResults.push({
        evidenceId: file.evidence.evidenceId,
        contentId: file.evidence.contentId,
        modality: file.evidence.modality,
        revision: file.evidence.revision,
        sourceHash: file.evidence.sourceHash,
        features,
      });
    }

    if (successes === 0) {
      throw new WorkerExecutionError('FEATURE_SERVICE_UNAVAILABLE', 'features');
    }
    return {
      status: componentErrors.length > 0 ? 'needs_review' : 'succeeded',
      result: {
        schemaVersion: FEATURE_BUNDLE_VERSION,
        generatedAt: new Date(this.now()).toISOString(),
        jobId: lease.jobId,
        runId: lease.runId,
        scope: lease.scope,
        authorizationRevision: lease.authorizationRevision,
        inputHash: lease.inputHash,
        executionProfileDigest: lease.executionProfileDigest,
        versions,
        evidence: evidenceResults,
        componentErrors,
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
}

export class WorkerRuntime {
  constructor({
    workerId,
    versions,
    capabilities,
    controlPlane,
    artifacts,
    processor,
    scratchRoot = '/tmp/sgx-classification/jobs',
    maxJobs = 1,
    executionProfileDigest = null,
    heartbeatIntervalMs = 10_000,
    pollIntervalMs = 2_000,
    now = () => Date.now(),
    idFactory = () => `request-${randomUUID()}`,
    logger = createJsonLogger(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    sleep = (milliseconds, signal) => new Promise((resolve) => {
      let finished = false;
      let timer;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      timer = setTimeout(finish, milliseconds);
      if (signal?.aborted) finish();
      else signal?.addEventListener('abort', finish, { once: true });
    }),
  }) {
    ensure(ID_PATTERN.test(workerId ?? ''), 'VERSION_MISMATCH', 'lease');
    ensure(Number.isInteger(maxJobs) && maxJobs >= 1 && maxJobs <= 16, 'VERSION_MISMATCH', 'lease');
    this.workerId = workerId;
    this.versions = versions;
    this.capabilities = capabilities;
    this.controlPlane = controlPlane;
    this.artifacts = artifacts;
    this.processor = processor;
    this.scratchRoot = scratchRoot;
    this.maxJobs = maxJobs;
    if (executionProfileDigest !== null) {
      ensure(SHA256_PATTERN.test(executionProfileDigest), 'VERSION_MISMATCH', 'lease');
    }
    this.executionProfileDigest = executionProfileDigest;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.idFactory = idFactory;
    this.logger = logger;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.sleep = sleep;
    this.handledAttempts = new Set();
  }

  async runOnce({ signal } = {}) {
    if (signal?.aborted) return { leased: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
    const requestId = this.idFactory();
    const response = await this.controlPlane.lease({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      workerId: this.workerId,
      maxJobs: this.maxJobs,
      versions: this.versions,
      capabilities: this.capabilities,
    }, { signal });
    ensure(response?.protocolVersion === PROTOCOL_VERSION, 'VERSION_MISMATCH', 'lease');
    ensure(response.requestId === requestId, 'VERSION_MISMATCH', 'lease');
    ensure(Array.isArray(response.leases), 'VERSION_MISMATCH', 'lease');
    const summary = { leased: response.leases.length, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
    for (const lease of response.leases) {
      const key = terminalKey(lease);
      if (this.handledAttempts.has(key)) {
        summary.skipped += 1;
        this.logger.warn('duplicate_lease_skipped', { jobId: lease.jobId, runId: lease.runId });
        continue;
      }
      this.handledAttempts.add(key);
      const outcome = await this.#processLease(lease);
      summary[outcome] += 1;
    }
    return summary;
  }

  async runForever({ signal } = {}) {
    this.logger.info('worker_started', { workerId: this.workerId });
    while (!signal?.aborted) {
      try {
        await this.runOnce({ signal });
      } catch (error) {
        this.logger.error('lease_poll_failed', {
          errorCode: error instanceof WorkerExecutionError ? error.errorCode : 'INTERNAL_ERROR',
        });
      }
      if (!signal?.aborted) await this.sleep(this.pollIntervalMs, signal);
    }
    this.logger.info('worker_stopped', { workerId: this.workerId });
  }

  async #processLease(lease) {
    const startedAt = this.now();
    let identity;
    let scratch = { jobRoot: null, runRoot: null };
    let fence;
    let terminal = null;
    let outcome = 'failed';
    let knownUsage = null;
    try {
      if (lease && typeof lease === 'object' && lease.jobId && lease.runId && lease.leaseToken) {
        identity = runIdentity(this.workerId, lease);
      }
      validateLease(lease);
      if (this.executionProfileDigest !== null) {
        ensure(
          lease.executionProfileDigest === this.executionProfileDigest,
          'VERSION_MISMATCH',
          'lease',
        );
      }
      scratch = await prepareScratch(this.scratchRoot, lease);
      fence = new LeaseFence({
        controlPlane: this.controlPlane,
        identity,
        leaseExpiresAt: lease.leaseExpiresAt,
        deadlineAt: lease.deadlineAt,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        now: this.now,
        idFactory: this.idFactory,
        setIntervalFn: this.setIntervalFn,
        clearIntervalFn: this.clearIntervalFn,
      });
      fence.start();
      await fence.checkpoint('downloading', 0);
      const files = await materializeEvidence({
        lease,
        runRoot: scratch.runRoot,
        artifacts: this.artifacts,
        fence,
        now: this.now,
      });
      await fence.checkpoint('features', 35);
      let processed;
      try {
        processed = await this.processor.process({
          lease,
          identity,
          files,
          versions: this.versions,
          signal: fence.abortController.signal,
          checkpoint: (stage, progress) => fence.checkpoint(stage, progress),
        });
      } catch (error) {
        if (fence.stopReason) throw new FenceStop(fence.stopReason);
        throw error;
      }
      ensure(
        processed && ['succeeded', 'needs_review'].includes(processed.status),
        'INTERNAL_ERROR',
        'organizing',
      );
      ensure(processed.result && typeof processed.result === 'object', 'INTERNAL_ERROR', 'organizing');
      await fence.checkpoint('uploading', 85);
      const resultBytes = Buffer.from(JSON.stringify(processed.result), 'utf8');
      ensure(resultBytes.length <= lease.resultUpload.maxByteLength, 'RESULT_UPLOAD_FAILED', 'uploading');
      ensure(this.now() < parseTimestamp(lease.resultUpload.expiresAt, 'RESULT_UPLOAD_FAILED', 'uploading'), 'RESULT_UPLOAD_FAILED', 'uploading');
      try {
        await this.artifacts.upload({
          url: lease.resultUpload.uploadUrl,
          bytes: resultBytes,
          mimeType: 'application/json',
          signal: fence.abortController.signal,
        });
      } catch (error) {
        if (fence.stopReason) throw new FenceStop(fence.stopReason);
        throw new WorkerExecutionError('RESULT_UPLOAD_FAILED', 'uploading', 'result upload failed', { cause: error });
      }
      // A post-upload heartbeat narrows the late-result window. The product
      // backend still performs the authoritative CAS on complete.
      await fence.checkpoint('uploading', 99);
      await fence.stop();
      fence.assertActive();
      const usage = {
        ...emptyUsage(startedAt, this.now),
        ...processed.usage,
      };
      knownUsage = usage;
      const completeRequest = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: this.idFactory(),
        identity,
        status: processed.status,
        versions: this.versions,
        resultArtifact: {
          artifactId: lease.resultUpload.artifactId,
          sha256: sha256(resultBytes),
          byteLength: resultBytes.length,
          mimeType: 'application/json',
        },
        usage,
      };
      try {
        await this.controlPlane.complete(lease.jobId, completeRequest);
      } catch (error) {
        throw new TerminalStateUnknownError('complete', error);
      }
      outcome = 'completed';
      this.logger.info('job_completed', {
        jobId: lease.jobId,
        runId: lease.runId,
        status: processed.status,
      });
    } catch (error) {
      if (error instanceof FenceStop || fence?.stopReason) {
        terminal = { kind: 'cancel', reason: error.reason ?? fence.stopReason };
        outcome = 'cancelled';
      } else if (error instanceof TerminalStateUnknownError) {
        terminal = { kind: 'unknown', operation: error.operation };
        outcome = 'failed';
      } else {
        const executionError = error instanceof WorkerExecutionError
          ? error
          : new WorkerExecutionError('INTERNAL_ERROR', 'lease', 'worker execution failed', { cause: error });
        terminal = { kind: 'fail', error: executionError };
        outcome = 'failed';
      }
    } finally {
      if (fence) await fence.stop();
    }

    const temporaryFilesDeleted = await cleanupScratch(scratch);
    if (!temporaryFilesDeleted) {
      this.logger.error('job_cleanup_failed', { jobId: lease.jobId, runId: lease.runId });
    }
    if (!terminal) return outcome;
    if (!identity) {
      this.logger.error('invalid_lease_unreportable', { jobId: lease?.jobId, runId: lease?.runId });
      return outcome;
    }
    if (terminal.kind === 'unknown') {
      this.logger.error('terminal_state_unknown', {
        jobId: lease.jobId,
        runId: lease.runId,
        operation: terminal.operation,
      });
      return outcome;
    }
    if (terminal.kind === 'cancel') {
      const reason = CANCEL_REASONS.has(terminal.reason) ? terminal.reason : 'cancelled';
      try {
        await this.controlPlane.cancelAck(lease.jobId, {
          protocolVersion: PROTOCOL_VERSION,
          requestId: this.idFactory(),
          identity,
          reason,
          temporaryFilesDeleted,
          ...(knownUsage ? { usage: knownUsage } : {}),
        });
      } catch (error) {
        this.logger.error('terminal_state_unknown', {
          jobId: lease.jobId,
          runId: lease.runId,
          operation: 'cancel_ack',
        });
      }
      this.logger.info('job_cancelled', { jobId: lease.jobId, runId: lease.runId, reason });
      return outcome;
    }
    const executionError = terminal.error;
    try {
      await this.controlPlane.fail(lease.jobId, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: this.idFactory(),
        identity,
        errorCode: executionError.errorCode,
        stage: HEARTBEAT_STAGES.has(executionError.stage) || executionError.stage === 'lease'
          ? executionError.stage
          : 'lease',
        retryable: false,
        providerCalled: executionError.providerCalled || (knownUsage?.providerCalls ?? 0) > 0,
        usage: knownUsage ?? emptyUsage(startedAt, this.now),
      });
    } catch (error) {
      this.logger.error('terminal_state_unknown', {
        jobId: lease.jobId,
        runId: lease.runId,
        operation: 'fail',
      });
    }
    this.logger.error('job_failed', {
      jobId: lease.jobId,
      runId: lease.runId,
      stage: executionError.stage,
      errorCode: executionError.errorCode,
      ...(executionError.diagnosticCode ? { diagnosticCode: executionError.diagnosticCode } : {}),
    });
    return outcome;
  }
}

export async function hashFile(filePath) {
  const bytes = await readFile(filePath);
  return { sha256: sha256(bytes), byteLength: bytes.length };
}

export async function writeDownloadedFile(destination, chunks, maxByteLength) {
  const handle = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    for await (const value of chunks) {
      const chunk = Buffer.from(value);
      byteLength += chunk.length;
      ensure(byteLength <= maxByteLength, 'DOWNLOAD_FAILED', 'downloading');
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close();
    await rm(destination, { force: true });
    throw error;
  }
  await handle.close();
  return { sha256: `sha256:${hash.digest('hex')}`, byteLength };
}
