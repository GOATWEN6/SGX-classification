import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  FileClassificationT1SessionStore,
  type ClassificationT1Session,
} from './t1-session-store';
import { WorkerControlPlaneError } from './worker-control-plane';

export const CLASSIFICATION_T1_ASR_VERSION = 'classification-t1-asr-prejob.1' as const;
export const CLASSIFICATION_T1_ASR_PROTOCOL_VERSION = 'classification-asr-worker.1' as const;
export const CLASSIFICATION_T1_ASR_MAX_BYTES = 50 * 1024 * 1024;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });
const scope = z.object({ householdId: id, subjectId: id }).strict();
const safeModelField = z.string().min(1).max(256).refine(value => !/[\r\n\0]/.test(value));

export const ClassificationT1AsrResultSchema = z.object({
  sourceSha256: sha256,
  sourceByteLength: z.number().int().positive().max(CLASSIFICATION_T1_ASR_MAX_BYTES),
  audioFormat: safeModelField,
  sampleRateHz: z.number().int().positive().max(384_000),
  channels: z.number().int().positive().max(8),
  durationMs: z.number().int().positive().max(6 * 60 * 60 * 1000),
  modelId: safeModelField,
  modelVersion: safeModelField,
  modelRevision: safeModelField,
  runtimeId: safeModelField,
  runtimeVersion: safeModelField,
  text: z.string().trim().min(1).max(65_536),
  language: safeModelField.optional(),
  segments: z.array(z.object({
    text: z.string().trim().min(1).max(16_384),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  }).strict()).max(20_000),
}).strict().superRefine((value, ctx) => {
  let previousEnd = 0;
  for(const segment of value.segments) {
    if(segment.endMs <= segment.startMs || segment.startMs < previousEnd || segment.endMs > value.durationMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ASR_SEGMENT_TIME_INVALID' });
      break;
    }
    previousEnd = segment.endMs;
  }
});

export type ClassificationT1AsrResult = z.infer<typeof ClassificationT1AsrResultSchema>;

const AsrLeaseSchema = z.object({
  workerId: id,
  jobRevision: z.number().int().positive(),
  leaseTokenHash: sha256,
  leaseExpiresAt: dateTime,
  progress: z.number().int().min(0).max(100),
  stage: z.enum(['lease', 'downloading', 'asr', 'completing']),
}).strict();

export const ClassificationT1AsrJobSchema = z.object({
  version: z.literal(CLASSIFICATION_T1_ASR_VERSION),
  revision: z.number().int().nonnegative(),
  jobId: id,
  sessionId: id,
  scope,
  actorId: id,
  authorizationRevision: id,
  consentRef: id,
  status: z.enum(['pending', 'processing', 'succeeded', 'failed', 'cancelled']),
  attemptRevision: z.literal(1),
  audio: z.object({
    sourceSha256: sha256,
    sourceByteLength: z.number().int().positive().max(CLASSIFICATION_T1_ASR_MAX_BYTES),
    mimeType: z.literal('audio/wav'),
    filename: z.string().min(1).max(160),
  }).strict(),
  deadlineAt: dateTime,
  createdAt: dateTime,
  updatedAt: dateTime,
  startedAt: dateTime.optional(),
  finishedAt: dateTime.optional(),
  lease: AsrLeaseSchema.optional(),
  result: ClassificationT1AsrResultSchema.optional(),
  errorCode: id.optional(),
}).strict().superRefine((value, ctx) => {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(value.status);
  if(value.status === 'pending' && (value.lease || value.startedAt || value.finishedAt || value.result || value.errorCode)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ASR_PENDING_STATE_INVALID' });
  }
  if(value.status === 'processing' && (!value.lease || !value.startedAt || value.finishedAt || value.result || value.errorCode)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ASR_PROCESSING_STATE_INVALID' });
  }
  if(terminal && (!value.startedAt || !value.finishedAt || value.lease)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ASR_TERMINAL_STATE_INVALID' });
  }
  if(value.status === 'succeeded' && (!value.result || value.errorCode)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ASR_SUCCESS_STATE_INVALID' });
  }
  if(['failed', 'cancelled'].includes(value.status) && (value.result || !value.errorCode)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ASR_FAILURE_STATE_INVALID' });
  }
});

export type ClassificationT1AsrJob = z.infer<typeof ClassificationT1AsrJobSchema>;
export type ClassificationT1AsrProductView = Omit<ClassificationT1AsrJob, 'lease'>;

const leaseRequestSchema = z.object({
  protocolVersion: z.literal(CLASSIFICATION_T1_ASR_PROTOCOL_VERSION),
  requestId: id,
  workerId: id,
  maxJobs: z.number().int().min(1).max(4),
  features: z.array(z.literal('asr')).length(1),
}).strict();

const identitySchema = z.object({
  workerId: id,
  jobId: id,
  sessionId: id,
  leaseToken: z.string().min(32).max(512),
  jobRevision: z.number().int().positive(),
  attemptRevision: z.literal(1),
  authorizationRevision: id,
  sourceSha256: sha256,
}).strict();

const heartbeatRequestSchema = z.object({
  protocolVersion: z.literal(CLASSIFICATION_T1_ASR_PROTOCOL_VERSION),
  requestId: id,
  identity: identitySchema,
  progress: z.number().int().min(0).max(100),
  stage: z.enum(['downloading', 'asr', 'completing']),
}).strict();

const completeRequestSchema = z.object({
  protocolVersion: z.literal(CLASSIFICATION_T1_ASR_PROTOCOL_VERSION),
  requestId: id,
  identity: identitySchema,
  result: ClassificationT1AsrResultSchema,
}).strict();

const failRequestSchema = z.object({
  protocolVersion: z.literal(CLASSIFICATION_T1_ASR_PROTOCOL_VERSION),
  requestId: id,
  identity: identitySchema,
  errorCode: z.enum([
    'DOWNLOAD_FAILED',
    'HASH_MISMATCH',
    'UNSUPPORTED_MEDIA',
    'FEATURE_SERVICE_UNAVAILABLE',
    'ASR_DISABLED',
    'ASR_INFERENCE_FAILED',
    'ASR_MODEL_UNAVAILABLE',
    'ASR_INVALID_OUTPUT',
    'INTERNAL_ERROR',
  ]),
}).strict();

function bytesHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function hashSecret(value: string): `sha256:${string}` {
  return bytesHash(Buffer.from(value, 'utf8'));
}
function secret(): string { return randomBytes(32).toString('hex'); }
function iso(nowMs: () => number): string { return new Date(nowMs()).toISOString(); }
function sameScope(left: ClassificationT1Session['scope'], right: ClassificationT1Session['scope']): boolean {
  return left.householdId === right.householdId && left.subjectId === right.subjectId;
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function safeFilename(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f/\\]/g, '_').trim();
  return [...(normalized || 'recording.wav')].slice(0, 160).join('');
}
function validateWavEnvelope(bytes: Buffer): void {
  if(bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WorkerControlPlaneError('ASR_WAV_REQUIRED', 415);
  }
}

export class FileClassificationT1AsrStore {
  readonly root: string;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(baseRoot = process.env.CLASSIFICATION_LAB_DATA_DIR || path.join(tmpdir(), 'sgx-classification-lab')) {
    this.root = path.resolve(baseRoot, 'v2-asr-prejobs');
  }

  private directory(jobId: string): string { return path.join(this.root, id.parse(jobId)); }
  private jobFile(jobId: string): string { return path.join(this.directory(jobId), 'job.json'); }
  private audioFile(jobId: string): string { return path.join(this.directory(jobId), 'audio.wav'); }

  private async exclusive<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.pending.set(jobId, current);
    try { return await current; }
    finally { if(this.pending.get(jobId) === current) this.pending.delete(jobId); }
  }

  private async write(job: ClassificationT1AsrJob): Promise<void> {
    const parsed = ClassificationT1AsrJobSchema.parse(job);
    const target = this.jobFile(job.jobId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  }

  async create(job: ClassificationT1AsrJob, audio: Buffer): Promise<ClassificationT1AsrJob> {
    const parsed = ClassificationT1AsrJobSchema.parse(job);
    if(bytesHash(audio) !== parsed.audio.sourceSha256 || audio.length !== parsed.audio.sourceByteLength) {
      throw new WorkerControlPlaneError('ASR_SOURCE_MISMATCH');
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.directory(parsed.jobId);
    const pending = path.join(this.root, `.pending-${parsed.jobId}-${randomUUID()}`);
    await mkdir(pending, { mode: 0o700 });
    try {
      await writeFile(path.join(pending, 'audio.wav'), audio, { mode: 0o600, flag: 'wx' });
      await writeFile(path.join(pending, 'job.json'), `${JSON.stringify(parsed)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try { await rename(pending, target); }
      catch(error) {
        if((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
        const existing = await this.get(parsed.jobId);
        if(!existing || existing.audio.sourceSha256 !== parsed.audio.sourceSha256
          || existing.sessionId !== parsed.sessionId || existing.authorizationRevision !== parsed.authorizationRevision) {
          throw new WorkerControlPlaneError('ASR_JOB_CONFLICT', 409);
        }
        return existing;
      }
      return parsed;
    } finally {
      await rm(pending, { recursive: true, force: true });
    }
  }

  async get(jobId: string): Promise<ClassificationT1AsrJob | undefined> {
    try { return ClassificationT1AsrJobSchema.parse(JSON.parse(await readFile(this.jobFile(jobId), 'utf8'))); }
    catch(error) {
      if((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if(error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new WorkerControlPlaneError('ASR_STORE_CORRUPT', 500);
      }
      throw error;
    }
  }

  async list(limit = 100): Promise<ClassificationT1AsrJob[]> {
    try {
      const names = (await readdir(this.root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && id.safeParse(entry.name).success)
        .map(entry => entry.name)
        .sort();
      const values: ClassificationT1AsrJob[] = [];
      for(const name of names.slice(0, limit)) {
        const value = await this.get(name);
        if(value) values.push(value);
      }
      return values.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch(error) {
      if((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async update(
    jobId: string,
    expectedRevision: number,
    transform: (current: ClassificationT1AsrJob) => ClassificationT1AsrJob,
  ): Promise<ClassificationT1AsrJob> {
    return this.exclusive(jobId, async () => {
      const current = await this.get(jobId);
      if(!current) throw new WorkerControlPlaneError('ASR_JOB_NOT_FOUND', 404);
      if(current.revision !== expectedRevision) throw new WorkerControlPlaneError('ASR_JOB_STALE', 409);
      const next = ClassificationT1AsrJobSchema.parse({
        ...transform(structuredClone(current)),
        revision: current.revision + 1,
      });
      await this.write(next);
      return next;
    });
  }

  async readAudio(jobId: string): Promise<Buffer> {
    const job = await this.get(jobId);
    if(!job) throw new WorkerControlPlaneError('ASR_JOB_NOT_FOUND', 404);
    const handle = await open(this.audioFile(jobId), 'r');
    try {
      const stat = await handle.stat();
      if(!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
        throw new WorkerControlPlaneError('ASR_STORE_CORRUPT', 500);
      }
      const bytes = await handle.readFile();
      if(bytes.length !== job.audio.sourceByteLength || bytesHash(bytes) !== job.audio.sourceSha256) {
        throw new WorkerControlPlaneError('ASR_SOURCE_MISMATCH', 409);
      }
      return bytes;
    } finally { await handle.close(); }
  }
}

export interface ClassificationT1AsrServiceOptions {
  dataRoot?: string;
  publicBaseUrl: string;
  nowMs?: () => number;
  leaseDurationMs?: number;
}

export class ClassificationT1AsrService {
  readonly store: FileClassificationT1AsrStore;
  readonly sessions: FileClassificationT1SessionStore;
  readonly publicBaseUrl: string;
  readonly nowMs: () => number;
  readonly leaseDurationMs: number;

  constructor(options: ClassificationT1AsrServiceOptions) {
    const dataRoot = options.dataRoot ?? process.env.CLASSIFICATION_LAB_DATA_DIR ?? path.join(tmpdir(), 'sgx-classification-lab');
    const parsed = new URL(options.publicBaseUrl);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    if(parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new WorkerControlPlaneError('CONTROL_PLANE_BASE_URL_UNSAFE');
    }
    this.store = new FileClassificationT1AsrStore(dataRoot);
    this.sessions = new FileClassificationT1SessionStore(dataRoot, options.nowMs);
    this.publicBaseUrl = parsed.toString().replace(/\/$/, '');
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
    if(this.leaseDurationMs < 5_000 || this.leaseDurationMs > 300_000) {
      throw new WorkerControlPlaneError('INVALID_LEASE_DURATION');
    }
  }

  private async activeSession(job: ClassificationT1AsrJob): Promise<ClassificationT1Session> {
    const session = await this.sessions.get(job.sessionId);
    if(!session || session.state !== 'active' || !sameScope(session.scope, job.scope)
      || session.actorId !== job.actorId || session.authorizationRevision !== job.authorizationRevision
      || session.consentRef !== job.consentRef) {
      throw new WorkerControlPlaneError('AUTHORIZATION_CHANGED', 409);
    }
    return session;
  }

  private productView(job: ClassificationT1AsrJob): ClassificationT1AsrProductView {
    const { lease: _lease, ...view } = job;
    return view;
  }

  async submit(input: {
    sessionId?: string;
    scope: ClassificationT1Session['scope'];
    actorId: string;
    filename: string;
    mimeType: string;
    bytes: Buffer;
  }): Promise<{ session: ClassificationT1Session; job: ClassificationT1AsrProductView }> {
    const parsedInput = z.object({ sessionId: id.optional(), scope, actorId: id, filename: z.string().min(1).max(512), mimeType: z.string() })
      .strict().parse({
        sessionId: input.sessionId,
        scope: input.scope,
        actorId: input.actorId,
        filename: input.filename,
        mimeType: input.mimeType,
      });
    if(input.mimeType !== 'audio/wav' && input.mimeType !== 'audio/x-wav' && input.mimeType !== 'audio/wave') {
      throw new WorkerControlPlaneError('ASR_WAV_REQUIRED', 415);
    }
    if(input.bytes.length <= 0 || input.bytes.length > CLASSIFICATION_T1_ASR_MAX_BYTES) {
      throw new WorkerControlPlaneError('ASR_AUDIO_SIZE_LIMIT', 413);
    }
    validateWavEnvelope(input.bytes);
    const session = parsedInput.sessionId
      ? await this.sessions.requireActive({
        sessionId: parsedInput.sessionId,
        scope: parsedInput.scope,
        actorId: parsedInput.actorId,
      })
      : await this.sessions.create({ scope: parsedInput.scope, actorId: parsedInput.actorId });
    const sourceSha256 = bytesHash(input.bytes);
    const jobId = `asr_${createHash('sha256')
      .update(`${session.sessionId}/${session.authorizationRevision}/${sourceSha256}`)
      .digest('hex').slice(0, 24)}`;
    const at = iso(this.nowMs);
    const job = ClassificationT1AsrJobSchema.parse({
      version: CLASSIFICATION_T1_ASR_VERSION,
      revision: 0,
      jobId,
      sessionId: session.sessionId,
      scope: session.scope,
      actorId: session.actorId,
      authorizationRevision: session.authorizationRevision,
      consentRef: session.consentRef,
      status: 'pending',
      attemptRevision: 1,
      audio: {
        sourceSha256,
        sourceByteLength: input.bytes.length,
        mimeType: 'audio/wav',
        filename: safeFilename(parsedInput.filename),
      },
      deadlineAt: new Date(this.nowMs() + 20 * 60_000).toISOString(),
      createdAt: at,
      updatedAt: at,
    });
    const stored = await this.store.create(job, input.bytes);
    return { session, job: this.productView(stored) };
  }

  async get(sessionId: string, jobId: string): Promise<ClassificationT1AsrProductView | undefined> {
    const session = await this.sessions.get(id.parse(sessionId));
    if(!session) throw new WorkerControlPlaneError('T1_SESSION_NOT_FOUND', 404);
    const job = await this.store.get(id.parse(jobId));
    if(!job) return undefined;
    if(job.sessionId !== session.sessionId || !sameScope(job.scope, session.scope)
      || job.actorId !== session.actorId || job.authorizationRevision !== session.authorizationRevision) {
      throw new WorkerControlPlaneError('T1_SESSION_SCOPE_MISMATCH', 403);
    }
    return this.productView(job);
  }

  private identity(job: ClassificationT1AsrJob, raw: unknown): z.infer<typeof identitySchema> {
    const identity = identitySchema.parse(raw);
    if(!job.lease || identity.workerId !== job.lease.workerId || identity.jobId !== job.jobId
      || identity.sessionId !== job.sessionId || identity.jobRevision !== job.lease.jobRevision
      || identity.attemptRevision !== job.attemptRevision
      || identity.authorizationRevision !== job.authorizationRevision
      || identity.sourceSha256 !== job.audio.sourceSha256
      || !safeEqual(hashSecret(identity.leaseToken), job.lease.leaseTokenHash)) {
      throw new WorkerControlPlaneError('ASR_LEASE_IDENTITY_MISMATCH', 409);
    }
    return identity;
  }

  private async activeLease(jobId: string, rawIdentity: unknown): Promise<ClassificationT1AsrJob> {
    const job = await this.store.get(jobId);
    if(!job) throw new WorkerControlPlaneError('ASR_JOB_NOT_FOUND', 404);
    this.identity(job, rawIdentity);
    if(job.status !== 'processing' || !job.lease) throw new WorkerControlPlaneError('ASR_LEASE_TERMINAL', 409);
    if(this.nowMs() >= Date.parse(job.deadlineAt) || this.nowMs() >= Date.parse(job.lease.leaseExpiresAt)) {
      throw new WorkerControlPlaneError('ASR_LEASE_EXPIRED', 409);
    }
    await this.activeSession(job);
    return job;
  }

  async lease(raw: unknown): Promise<unknown> {
    const request = leaseRequestSchema.parse(raw);
    const leases: unknown[] = [];
    for(const candidate of await this.store.list(100)) {
      if(leases.length >= request.maxJobs) break;
      if(candidate.status !== 'pending' || this.nowMs() >= Date.parse(candidate.deadlineAt)) continue;
      try { await this.activeSession(candidate); }
      catch { continue; }
      const token = secret();
      const expiresAt = new Date(Math.min(Date.parse(candidate.deadlineAt), this.nowMs() + this.leaseDurationMs)).toISOString();
      let claimed: ClassificationT1AsrJob;
      try {
        claimed = await this.store.update(candidate.jobId, candidate.revision, current => ({
          ...current,
          status: 'processing',
          startedAt: iso(this.nowMs),
          updatedAt: iso(this.nowMs),
          lease: {
            workerId: request.workerId,
            jobRevision: current.revision + 1,
            leaseTokenHash: hashSecret(token),
            leaseExpiresAt: expiresAt,
            progress: 0,
            stage: 'lease',
          },
        }));
      } catch(error) {
        if(error instanceof WorkerControlPlaneError && error.code === 'ASR_JOB_STALE') continue;
        throw error;
      }
      leases.push({
        jobId: claimed.jobId,
        sessionId: claimed.sessionId,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
        jobRevision: claimed.revision,
        attemptRevision: claimed.attemptRevision,
        scope: claimed.scope,
        authorizationRevision: claimed.authorizationRevision,
        deadlineAt: claimed.deadlineAt,
        audio: {
          artifactId: `asr_audio_${claimed.jobId}`,
          downloadUrl: `${this.publicBaseUrl}/internal/v1/classification/asr/artifacts/${encodeURIComponent(claimed.jobId)}?token=${token}`,
          expiresAt,
          sha256: claimed.audio.sourceSha256,
          byteLength: claimed.audio.sourceByteLength,
          mimeType: claimed.audio.mimeType,
        },
      });
    }
    return { protocolVersion: CLASSIFICATION_T1_ASR_PROTOCOL_VERSION, requestId: request.requestId, leases };
  }

  async heartbeat(jobId: string, raw: unknown): Promise<unknown> {
    const request = heartbeatRequestSchema.parse(raw);
    try {
      const current = await this.activeLease(id.parse(jobId), request.identity);
      const expiresAt = new Date(Math.min(Date.parse(current.deadlineAt), this.nowMs() + this.leaseDurationMs)).toISOString();
      const updated = await this.store.update(current.jobId, current.revision, value => ({
        ...value,
        updatedAt: iso(this.nowMs),
        lease: { ...value.lease!, leaseExpiresAt: expiresAt, progress: request.progress, stage: request.stage },
      }));
      return {
        protocolVersion: CLASSIFICATION_T1_ASR_PROTOCOL_VERSION,
        requestId: request.requestId,
        leaseExpiresAt: updated.lease!.leaseExpiresAt,
        control: 'continue',
        jobRevision: updated.revision,
      };
    } catch(error) {
      const code = error instanceof WorkerControlPlaneError ? error.code : 'INTERNAL_ERROR';
      if(!['AUTHORIZATION_CHANGED', 'ASR_LEASE_EXPIRED', 'ASR_LEASE_TERMINAL'].includes(code)) throw error;
      return {
        protocolVersion: CLASSIFICATION_T1_ASR_PROTOCOL_VERSION,
        requestId: request.requestId,
        leaseExpiresAt: iso(this.nowMs),
        control: code === 'ASR_LEASE_EXPIRED' ? 'deadline_exceeded' : 'cancel',
      };
    }
  }

  async readAudio(jobId: string, token: string): Promise<{ bytes: Buffer; mimeType: 'audio/wav' }> {
    const job = await this.store.get(id.parse(jobId));
    if(!job || job.status !== 'processing' || !job.lease) throw new WorkerControlPlaneError('ASR_LEASE_NOT_FOUND', 404);
    if(!safeEqual(hashSecret(token), job.lease.leaseTokenHash)) throw new WorkerControlPlaneError('ASR_ARTIFACT_TOKEN_INVALID', 403);
    if(this.nowMs() >= Date.parse(job.lease.leaseExpiresAt)) throw new WorkerControlPlaneError('ASR_LEASE_EXPIRED', 410);
    await this.activeSession(job);
    return { bytes: await this.store.readAudio(job.jobId), mimeType: 'audio/wav' };
  }

  async complete(jobId: string, raw: unknown): Promise<unknown> {
    const request = completeRequestSchema.parse(raw);
    const current = await this.activeLease(id.parse(jobId), request.identity);
    if(request.result.sourceSha256 !== current.audio.sourceSha256
      || request.result.sourceByteLength !== current.audio.sourceByteLength) {
      throw new WorkerControlPlaneError('ASR_SOURCE_MISMATCH', 409);
    }
    const finished = iso(this.nowMs);
    const next = await this.store.update(current.jobId, current.revision, value => ({
      ...value,
      status: 'succeeded',
      result: request.result,
      lease: undefined,
      finishedAt: finished,
      updatedAt: finished,
    }));
    return {
      protocolVersion: CLASSIFICATION_T1_ASR_PROTOCOL_VERSION,
      requestId: request.requestId,
      accepted: true,
      jobRevision: next.revision,
    };
  }

  async fail(jobId: string, raw: unknown): Promise<unknown> {
    const request = failRequestSchema.parse(raw);
    const current = await this.activeLease(id.parse(jobId), request.identity);
    const finished = iso(this.nowMs);
    const next = await this.store.update(current.jobId, current.revision, value => ({
      ...value,
      status: 'failed',
      errorCode: request.errorCode,
      lease: undefined,
      finishedAt: finished,
      updatedAt: finished,
    }));
    return {
      protocolVersion: CLASSIFICATION_T1_ASR_PROTOCOL_VERSION,
      requestId: request.requestId,
      accepted: true,
      jobRevision: next.revision,
    };
  }
}
