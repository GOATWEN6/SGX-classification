import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export const ASR_PROTOCOL_VERSION = 'classification-asr-worker.1';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_ERROR_CODES = new Set([
  'DOWNLOAD_FAILED',
  'HASH_MISMATCH',
  'UNSUPPORTED_MEDIA',
  'FEATURE_SERVICE_UNAVAILABLE',
  'ASR_DISABLED',
  'ASR_INFERENCE_FAILED',
  'ASR_MODEL_UNAVAILABLE',
  'ASR_INVALID_OUTPUT',
  'INTERNAL_ERROR',
]);

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function identity(workerId, lease) {
  return {
    workerId,
    jobId: lease.jobId,
    sessionId: lease.sessionId,
    leaseToken: lease.leaseToken,
    jobRevision: lease.jobRevision,
    attemptRevision: lease.attemptRevision,
    authorizationRevision: lease.authorizationRevision,
    sourceSha256: lease.audio.sha256,
  };
}

function validateLease(lease) {
  ensure(lease && typeof lease === 'object', 'ASR_LEASE_INVALID');
  for (const value of [lease.jobId, lease.sessionId, lease.runId ?? 'asr-run', lease.authorizationRevision]) {
    ensure(ID_PATTERN.test(value), 'ASR_LEASE_INVALID');
  }
  ensure(typeof lease.leaseToken === 'string' && lease.leaseToken.length >= 32, 'ASR_LEASE_INVALID');
  ensure(Number.isInteger(lease.jobRevision) && lease.jobRevision > 0, 'ASR_LEASE_INVALID');
  ensure(lease.attemptRevision === 1, 'ASR_LEASE_INVALID');
  ensure(Number.isFinite(Date.parse(lease.leaseExpiresAt)), 'ASR_LEASE_INVALID');
  ensure(Number.isFinite(Date.parse(lease.deadlineAt)), 'ASR_LEASE_INVALID');
  ensure(lease.audio?.mimeType === 'audio/wav', 'ASR_LEASE_INVALID');
  ensure(SHA256_PATTERN.test(lease.audio.sha256), 'ASR_LEASE_INVALID');
  ensure(Number.isInteger(lease.audio.byteLength) && lease.audio.byteLength > 0, 'ASR_LEASE_INVALID');
  ensure(typeof lease.audio.downloadUrl === 'string', 'ASR_LEASE_INVALID');
}

function mapError(error) {
  const raw = typeof error?.code === 'string' ? error.code : '';
  if (TERMINAL_ERROR_CODES.has(raw)) return raw;
  if (/WAV|AUDIO|PCM|SAMPLE_RATE|CHANNEL|DURATION|SOURCE_TYPE/.test(raw)) return 'UNSUPPORTED_MEDIA';
  if (/MODEL.*UNAVAILABLE/.test(raw)) return 'ASR_MODEL_UNAVAILABLE';
  if (/MODEL.*OUTPUT|TRANSCRIPT|SEGMENT/.test(raw)) return 'ASR_INVALID_OUTPUT';
  return 'INTERNAL_ERROR';
}

async function prepareScratch(root, lease) {
  ensure(path.isAbsolute(root), 'ASR_SCRATCH_INVALID');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  ensure(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'ASR_SCRATCH_INVALID');
  const canonical = await realpath(root);
  const jobRoot = path.join(canonical, lease.jobId);
  const runRoot = path.join(jobRoot, `attempt-${lease.attemptRevision}`);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const runStat = await lstat(runRoot);
  ensure(runStat.isDirectory() && !runStat.isSymbolicLink(), 'ASR_SCRATCH_INVALID');
  return { jobRoot, runRoot, audioPath: path.join(runRoot, 'audio.wav') };
}

export class AsrWorkerRuntime {
  constructor({
    workerId,
    controlPlane,
    artifacts,
    featureService,
    scratchRoot = '/tmp/sgx-classification/asr',
    maxJobs = 1,
    pollIntervalMs = 2_000,
    now = () => Date.now(),
    idFactory = () => `asr-request-${randomUUID()}`,
    logger,
    sleep = (milliseconds, signal) => new Promise(resolve => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }),
  }) {
    ensure(ID_PATTERN.test(workerId ?? ''), 'ASR_WORKER_ID_INVALID');
    ensure(Number.isInteger(maxJobs) && maxJobs >= 1 && maxJobs <= 4, 'ASR_MAX_JOBS_INVALID');
    this.workerId = workerId;
    this.controlPlane = controlPlane;
    this.artifacts = artifacts;
    this.featureService = featureService;
    this.scratchRoot = scratchRoot;
    this.maxJobs = maxJobs;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.idFactory = idFactory;
    this.logger = logger;
    this.sleep = sleep;
    this.handled = new Set();
  }

  async #heartbeat(lease, runIdentity, stage, progress, signal) {
    const response = await this.controlPlane.asrHeartbeat(lease.jobId, {
      protocolVersion: ASR_PROTOCOL_VERSION,
      requestId: this.idFactory(),
      identity: runIdentity,
      stage,
      progress,
    }, { signal });
    ensure(response?.protocolVersion === ASR_PROTOCOL_VERSION, 'ASR_PROTOCOL_MISMATCH');
    if (response.control !== 'continue') {
      const error = new Error(response.control);
      error.code = 'ASR_CANCELLED';
      throw error;
    }
  }

  async #process(lease, signal) {
    let scratch;
    let runIdentity;
    try {
      validateLease(lease);
      runIdentity = identity(this.workerId, lease);
      if (this.now() >= Date.parse(lease.deadlineAt) || this.now() >= Date.parse(lease.leaseExpiresAt)) {
        throw Object.assign(new Error('deadline exceeded'), { code: 'INTERNAL_ERROR' });
      }
      scratch = await prepareScratch(this.scratchRoot, lease);
      await this.#heartbeat(lease, runIdentity, 'downloading', 5, signal);
      let downloaded;
      try {
        downloaded = await this.artifacts.downloadToFile({
          url: lease.audio.downloadUrl,
          destination: scratch.audioPath,
          maxByteLength: lease.audio.byteLength,
          signal,
        });
      } catch (error) {
        throw Object.assign(new Error('audio download failed', { cause: error }), { code: 'DOWNLOAD_FAILED' });
      }
      if (downloaded.sha256 !== lease.audio.sha256 || downloaded.byteLength !== lease.audio.byteLength) {
        throw Object.assign(new Error('audio hash mismatch'), { code: 'HASH_MISMATCH' });
      }
      await this.#heartbeat(lease, runIdentity, 'asr', 35, signal);
      const result = await this.featureService.asr({
        sourcePath: scratch.audioPath,
        sourceSha256: lease.audio.sha256,
        sourceByteLength: lease.audio.byteLength,
      }, { signal });
      ensure(result && result.sourceSha256 === lease.audio.sha256, 'ASR_RESULT_SOURCE_MISMATCH');
      ensure(result.sourceByteLength === lease.audio.byteLength, 'ASR_RESULT_SOURCE_MISMATCH');
      ensure(typeof result.text === 'string' && result.text.trim().length > 0, 'ASR_RESULT_INVALID');
      await this.#heartbeat(lease, runIdentity, 'completing', 95, signal);
      await this.controlPlane.asrComplete(lease.jobId, {
        protocolVersion: ASR_PROTOCOL_VERSION,
        requestId: this.idFactory(),
        identity: runIdentity,
        result,
      }, { signal });
      this.logger?.info('asr_job_completed', { jobId: lease.jobId, sessionId: lease.sessionId });
      return 'completed';
    } catch (error) {
      const code = mapError(error);
      if (runIdentity && error?.code !== 'ASR_CANCELLED') {
        try {
          await this.controlPlane.asrFail(lease.jobId, {
            protocolVersion: ASR_PROTOCOL_VERSION,
            requestId: this.idFactory(),
            identity: runIdentity,
            errorCode: code,
          }, { signal });
        } catch {
          this.logger?.error('asr_terminal_state_unknown', { jobId: lease?.jobId, errorCode: code });
        }
      }
      this.logger?.error('asr_job_failed', { jobId: lease?.jobId, errorCode: code });
      return 'failed';
    } finally {
      if (scratch?.runRoot) await rm(scratch.runRoot, { recursive: true, force: true });
      if (scratch?.jobRoot) await rm(scratch.jobRoot, { recursive: true, force: true });
    }
  }

  async runOnce({ signal } = {}) {
    if (signal?.aborted) return { leased: 0, completed: 0, failed: 0, skipped: 0 };
    const requestId = this.idFactory();
    const response = await this.controlPlane.asrLease({
      protocolVersion: ASR_PROTOCOL_VERSION,
      requestId,
      workerId: this.workerId,
      maxJobs: this.maxJobs,
      features: ['asr'],
    }, { signal });
    ensure(response?.protocolVersion === ASR_PROTOCOL_VERSION && response.requestId === requestId, 'ASR_PROTOCOL_MISMATCH');
    ensure(Array.isArray(response.leases), 'ASR_PROTOCOL_MISMATCH');
    const summary = { leased: response.leases.length, completed: 0, failed: 0, skipped: 0 };
    for (const lease of response.leases) {
      const key = `${lease.jobId}:${lease.attemptRevision}`;
      if (this.handled.has(key)) {
        summary.skipped += 1;
        continue;
      }
      this.handled.add(key);
      summary[await this.#process(lease, signal)] += 1;
    }
    return summary;
  }

  async runForever({ signal } = {}) {
    this.logger?.info('asr_worker_started', { workerId: this.workerId });
    while (!signal?.aborted) {
      try { await this.runOnce({ signal }); }
      catch { this.logger?.error('asr_lease_poll_failed', { errorCode: 'INTERNAL_ERROR' }); }
      if (!signal?.aborted) await this.sleep(this.pollIntervalMs, signal);
    }
    this.logger?.info('asr_worker_stopped', { workerId: this.workerId });
  }
}

export async function verifyDownloadedAsrFile(filePath) {
  const bytes = await readFile(filePath);
  return { sourceSha256: sha256(bytes), sourceByteLength: bytes.length };
}
