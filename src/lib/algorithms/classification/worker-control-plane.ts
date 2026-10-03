import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  computeLabGrantDigest,
  computeLabResultDigest,
  parseTrustedLabGuardSnapshot,
  validateLabExecutionResultAgainstEnvelope,
  type LabExecutionMetrics,
  type LabExecutionResult,
  type LabJobRecordV2,
  type TrustedLabGuardSnapshot,
} from './lab-execution-contract';
import { FileTrustedLabGuardStore } from './lab-execution-guard-store';
import { FileClassificationLabV2Store } from './lab-execution-store';
import { listEffectiveLabPrivacyEvents } from './lab-execution';
import {
  FileHistoricalRetrievalAdapter,
  HistoricalFeatureRecordSchema,
  HistoricalRetrievalQuerySchema,
  type HistoricalFeatureRecord,
  type HistoricalRetrievalResult,
} from './historical-retrieval';
import { digest, stable } from './stage-a-contract';

export const WORKER_CONTROL_PLANE_VERSION = 'classification-worker-control-plane.v1' as const;
export const WORKER_PIPELINE_RESULT_VERSION = 'classification-worker-pipeline-result.1' as const;
export const WORKER_CONTROL_STATE_VERSION = 'classification-worker-control-state.1' as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });
const scope = z.object({ householdId: id, subjectId: id }).strict();
const protocol = z.literal(WORKER_CONTROL_PLANE_VERSION);

const WorkerVersionsSchema = z.object({
  gitCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
  contractVersion: id,
  providerVersion: id,
  promptVersion: id,
  guardVersion: id,
  adapterVersion: id,
  taxonomyVersion: id,
  ocrVersion: id,
  embeddingVersion: id,
}).strict();

const WorkerCapabilitiesSchema = z.object({
  modalities: z.array(z.enum(['image', 'user_text', 'final_asr'])).min(1),
  features: z.array(id).min(1),
  maxImagesPerJob: z.number().int().min(1).max(100),
  personMatchingEnabled: z.boolean(),
}).strict();

const LeaseRequestSchema = z.object({
  protocolVersion: protocol,
  requestId: id,
  workerId: id,
  maxJobs: z.number().int().min(1).max(16),
  versions: WorkerVersionsSchema,
  capabilities: WorkerCapabilitiesSchema,
}).strict();

const RunIdentitySchema = z.object({
  workerId: id,
  jobId: id,
  runId: id,
  leaseToken: z.string().min(32).max(512),
  jobRevision: z.number().int().positive(),
  attemptRevision: z.number().int().positive(),
  authorizationRevision: id,
  inputHash: sha256,
  executionProfileDigest: sha256,
}).strict();

const HeartbeatRequestSchema = z.object({
  protocolVersion: protocol,
  requestId: id,
  identity: RunIdentitySchema,
  progress: z.number().int().min(0).max(100),
  stage: z.enum(['downloading', 'features', 'retrieval', 'vlm_extract', 'vlm_relate', 'organizing', 'uploading']),
}).strict();

const ExecutionContextRequestSchema = z.object({
  protocolVersion: protocol,
  requestId: id,
  identity: RunIdentitySchema,
}).strict();

const HistoricalQueryRequestSchema = z.object({
  protocolVersion: protocol,
  requestId: id,
  identity: RunIdentitySchema,
  query: HistoricalRetrievalQuerySchema,
}).strict();

const WorkerUsageSchema = z.object({
  endToEndLatencyMs: z.number().int().nonnegative(),
  providerLatencyMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costCny: z.number().nonnegative(),
  providerCalls: z.number().int().nonnegative(),
}).strict();

const ResultArtifactSchema = z.object({
  artifactId: id,
  sha256,
  byteLength: z.number().int().positive().max(1024 * 1024 * 1024),
  mimeType: z.literal('application/json'),
}).strict();

const CompleteRequestSchema = z.object({
  protocolVersion: protocol,
  requestId: id,
  identity: RunIdentitySchema,
  status: z.enum(['succeeded', 'needs_review']),
  versions: WorkerVersionsSchema,
  resultArtifact: ResultArtifactSchema,
  usage: WorkerUsageSchema,
}).strict();

const workerErrorCode = z.enum([
  'DOWNLOAD_FAILED',
  'HASH_MISMATCH',
  'UNSUPPORTED_MEDIA',
  'FEATURE_SERVICE_UNAVAILABLE',
  'OCR_FAILED',
  'EMBEDDING_FAILED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_INVALID_OUTPUT',
  'RESULT_UPLOAD_FAILED',
  'VERSION_MISMATCH',
  'INTERNAL_ERROR',
]);

const FailRequestSchema = z.object({
  protocolVersion: protocol,
  requestId: id,
  identity: RunIdentitySchema,
  errorCode: workerErrorCode,
  stage: z.enum(['lease', 'downloading', 'features', 'retrieval', 'vlm_extract', 'vlm_relate', 'organizing', 'uploading']),
  retryable: z.boolean(),
  providerCalled: z.boolean(),
  usage: WorkerUsageSchema,
}).strict();

const CancelAckRequestSchema = z.object({
  protocolVersion: protocol,
  requestId: id,
  identity: RunIdentitySchema,
  reason: z.enum(['cancelled', 'authorization_changed', 'deadline_exceeded', 'evidence_inactive']),
  temporaryFilesDeleted: z.boolean(),
}).strict();

const UploadedResultSchema = z.object({
  sha256,
  byteLength: z.number().int().positive(),
  mimeType: z.literal('application/json'),
  uploadedAt: dateTime,
}).strict();

const WorkerControlStateSchema = z.object({
  version: z.literal(WORKER_CONTROL_STATE_VERSION),
  revision: z.number().int().nonnegative(),
  jobId: id,
  runId: id,
  workerId: id,
  leaseTokenHash: sha256,
  leaseExpiresAt: dateTime,
  jobRevision: z.number().int().positive(),
  attemptRevision: z.number().int().positive(),
  authorizationRevision: id,
  inputHash: sha256,
  executionProfileDigest: sha256,
  resultArtifactId: id,
  resultUploadTokenHash: sha256,
  resultUploadExpiresAt: dateTime,
  resultMaxByteLength: z.number().int().positive(),
  status: z.enum(['leased', 'completed', 'failed', 'cancelled']),
  progress: z.number().int().min(0).max(100),
  stage: z.enum(['lease', 'downloading', 'features', 'retrieval', 'vlm_extract', 'vlm_relate', 'organizing', 'uploading']),
  createdAt: dateTime,
  updatedAt: dateTime,
  uploadedResult: UploadedResultSchema.optional(),
}).strict();

type WorkerControlState = z.infer<typeof WorkerControlStateSchema>;
type RunIdentity = z.infer<typeof RunIdentitySchema>;
type WorkerVersions = z.infer<typeof WorkerVersionsSchema>;

export class WorkerControlPlaneError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

function fail(code: string, status = 400): never { throw new WorkerControlPlaneError(code, status); }
function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function secret(): string { return randomBytes(32).toString('hex'); }
function hashSecret(value: string): `sha256:${string}` { return hashBytes(Buffer.from(value, 'utf8')); }
function sameScope(left: { householdId: string; subjectId: string }, right: { householdId: string; subjectId: string }): boolean {
  return left.householdId === right.householdId && left.subjectId === right.subjectId;
}
function iso(nowMs: () => number): string { return new Date(nowMs()).toISOString(); }
function later(left: string, right: string): string { return Date.parse(left) >= Date.parse(right) ? left : right; }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function normalizedVector(raw: unknown): {
  modelId: string;
  modelRevision: string;
  dimensions: number;
  vector: number[];
} | undefined {
  const value = raw as Record<string, unknown> | undefined;
  if(!value || value.normalized !== true || typeof value.modelId !== 'string'
    || typeof value.modelRevision !== 'string' || !Number.isInteger(value.dimensions)
    || !Array.isArray(value.vector) || value.vector.length !== value.dimensions) return undefined;
  const vector = value.vector.map(Number);
  if(vector.some(item => !Number.isFinite(item))) return undefined;
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if(!Number.isFinite(norm) || norm <= 0) return undefined;
  return {
    modelId: id.parse(value.modelId),
    modelRevision: id.parse(value.modelRevision),
    dimensions: value.dimensions as number,
    vector: vector.map(item => item / norm),
  };
}
function meanVector(values: ReturnType<typeof normalizedVector>[]): Exclude<ReturnType<typeof normalizedVector>, undefined> | undefined {
  const vectors = values.filter((value): value is Exclude<typeof value, undefined> => Boolean(value));
  if(!vectors.length) return undefined;
  const first = vectors[0];
  if(vectors.some(value => value.modelId !== first.modelId
    || value.modelRevision !== first.modelRevision || value.dimensions !== first.dimensions)) return undefined;
  const mean = Array.from({ length: first.dimensions }, (_, index) => (
    vectors.reduce((sum, item) => sum + item.vector[index], 0) / vectors.length
  ));
  const norm = Math.sqrt(mean.reduce((sum, item) => sum + item * item, 0));
  if(!Number.isFinite(norm) || norm <= 0) return undefined;
  return { ...first, vector: mean.map(item => item / norm) };
}
function opaqueId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(stable(value)).digest('hex').slice(0, 24)}`;
}

export interface WorkerControlPlaneClock { nowMs(): number }

export interface ClassificationWorkerControlPlaneOptions {
  dataRoot?: string;
  publicBaseUrl: string;
  store?: FileClassificationLabV2Store;
  guardStore?: FileTrustedLabGuardStore;
  historical?: FileHistoricalRetrievalAdapter;
  clock?: WorkerControlPlaneClock;
  leaseDurationMs?: number;
  resultMaxByteLength?: number;
}

export class ClassificationWorkerControlPlane {
  readonly store: FileClassificationLabV2Store;
  readonly guardStore: FileTrustedLabGuardStore;
  readonly historical: FileHistoricalRetrievalAdapter;
  readonly root: string;
  readonly publicBaseUrl: string;
  readonly clock: WorkerControlPlaneClock;
  readonly leaseDurationMs: number;
  readonly resultMaxByteLength: number;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(options: ClassificationWorkerControlPlaneOptions) {
    const baseRoot = options.dataRoot ?? process.env.CLASSIFICATION_LAB_DATA_DIR ?? path.join(tmpdir(), 'sgx-classification-lab');
    this.store = options.store ?? new FileClassificationLabV2Store(baseRoot);
    this.guardStore = options.guardStore ?? new FileTrustedLabGuardStore(baseRoot);
    this.historical = options.historical ?? new FileHistoricalRetrievalAdapter(path.resolve(baseRoot, 'v2-historical'));
    this.root = path.resolve(baseRoot, 'v2-worker-control-plane');
    const parsed = new URL(options.publicBaseUrl);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    if(parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) fail('CONTROL_PLANE_BASE_URL_UNSAFE');
    this.publicBaseUrl = parsed.toString().replace(/\/$/, '');
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.resultMaxByteLength = options.resultMaxByteLength ?? 64 * 1024 * 1024;
    if(this.leaseDurationMs < 5_000 || this.leaseDurationMs > 300_000) fail('INVALID_LEASE_DURATION');
    if(this.resultMaxByteLength < 1024 || this.resultMaxByteLength > 1024 * 1024 * 1024) fail('INVALID_RESULT_SIZE_LIMIT');
  }

  private stateFile(jobId: string): string { return path.join(this.root, 'leases', `${id.parse(jobId)}.json`); }
  private resultFile(jobId: string): string { return path.join(this.root, 'results', `${id.parse(jobId)}.json`); }

  private async exclusive<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.pending.set(jobId, current);
    try { return await current; }
    finally { if(this.pending.get(jobId) === current) this.pending.delete(jobId); }
  }

  private async readState(jobId: string): Promise<WorkerControlState | undefined> {
    try { return WorkerControlStateSchema.parse(JSON.parse(await readFile(this.stateFile(jobId), 'utf8'))); }
    catch(error) {
      if((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if(error instanceof z.ZodError) fail('CONTROL_PLANE_STORE_CORRUPT', 500);
      throw error;
    }
  }

  private async writeState(value: WorkerControlState): Promise<void> {
    const state = WorkerControlStateSchema.parse(value);
    const directory = path.dirname(this.stateFile(state.jobId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.stateFile(state.jobId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  }

  private async updateState(jobId: string, transform: (current: WorkerControlState) => WorkerControlState): Promise<WorkerControlState> {
    return this.exclusive(jobId, async () => {
      const current = await this.readState(jobId);
      if(!current) fail('LEASE_NOT_FOUND', 404);
      const next = WorkerControlStateSchema.parse({ ...transform(structuredClone(current)), revision: current.revision + 1 });
      await this.writeState(next);
      return next;
    });
  }

  private workerMatches(job: LabJobRecordV2, guard: TrustedLabGuardSnapshot, versions: WorkerVersions, capabilities: z.infer<typeof WorkerCapabilitiesSchema>): boolean {
    const profile = job.executionProfile;
    if(versions.providerVersion !== profile.providerVersion
      || versions.promptVersion !== profile.promptVersion
      || versions.guardVersion !== profile.guardVersion
      || versions.adapterVersion !== profile.adapterVersion
      || versions.taxonomyVersion !== profile.taxonomyVersion) return false;
    const requiredModalities = new Set(job.envelope.contents
      .filter(content => content.lifecycleState === 'active')
      .map(content => content.modality));
    if([...requiredModalities].some(value => !capabilities.modalities.includes(value))) return false;
    const imageCount = job.envelope.contents.filter(content => content.lifecycleState === 'active' && content.modality === 'image').length;
    if(imageCount > capabilities.maxImagesPerJob) return false;
    if(guard.allowPersonMatching && !capabilities.personMatchingEnabled) return false;
    const requiredFeatures = imageCount
      ? ['ocr', 'image_embedding', 'vlm_extract', 'vlm_relate', 'story_summary']
      : ['vlm_extract', 'story_summary'];
    if(job.envelope.contents.some(content => content.lifecycleState === 'active' && content.modality !== 'image')) {
      requiredFeatures.push('text_embedding');
    }
    return requiredFeatures.every(value => capabilities.features.includes(value));
  }

  private async currentGuard(job: LabJobRecordV2): Promise<TrustedLabGuardSnapshot> {
    const guard = parseTrustedLabGuardSnapshot(await this.guardStore.get(job.jobId));
    if(!guard.active || !sameScope(guard.scope, job.envelope.scope)
      || guard.actorId !== job.authorization.actorId
      || guard.authorizationRevision !== job.authorization.authorizationRevision
      || guard.contextRevision !== job.authorization.contextRevision
      || computeLabGrantDigest(guard) !== job.authorization.grantDigest) fail('AUTHORIZATION_CHANGED', 409);
    const guarded = new Map(guard.evidence.map(value => [value.evidenceId, value]));
    for(const evidence of job.envelope.evidence) {
      const current = guarded.get(evidence.evidenceId);
      if(evidence.lifecycleState === 'deleted' || !current || current.lifecycleState !== 'active') fail('INACTIVE_EVIDENCE', 409);
      if(current.revision !== evidence.revision || current.sourceHash !== evidence.sourceHash
        || current.consentRef !== evidence.consentRef) fail('EVIDENCE_CHANGED', 409);
    }
    if((await listEffectiveLabPrivacyEvents(job, this.store)).length) fail('AUTHORIZATION_CHANGED', 409);
    return guard;
  }

  private identityState(identityInput: unknown, state: WorkerControlState): RunIdentity {
    const identity = RunIdentitySchema.parse(identityInput);
    const expected = {
      workerId: state.workerId,
      jobId: state.jobId,
      runId: state.runId,
      jobRevision: state.jobRevision,
      attemptRevision: state.attemptRevision,
      authorizationRevision: state.authorizationRevision,
      inputHash: state.inputHash,
      executionProfileDigest: state.executionProfileDigest,
    };
    const actual = { ...identity };
    delete (actual as Partial<RunIdentity>).leaseToken;
    if(stable(actual) !== stable(expected) || !safeEqual(hashSecret(identity.leaseToken), state.leaseTokenHash)) {
      fail('LEASE_IDENTITY_MISMATCH', 409);
    }
    return identity;
  }

  private async requireActiveLease(jobId: string, identityInput: unknown): Promise<{
    state: WorkerControlState;
    job: LabJobRecordV2;
    guard: TrustedLabGuardSnapshot;
    identity: RunIdentity;
  }> {
    const state = await this.readState(jobId);
    if(!state) fail('LEASE_NOT_FOUND', 404);
    const identity = this.identityState(identityInput, state);
    if(state.status !== 'leased') fail('LEASE_TERMINAL', 409);
    const job = await this.store.get(jobId);
    if(!job) fail('LAB_JOB_NOT_FOUND', 404);
    if(job.status !== 'processing' || job.revision !== state.jobRevision || job.runId !== state.runId) fail('STALE_RESULT', 409);
    if(this.clock.nowMs() >= Date.parse(job.deadlineAt) || this.clock.nowMs() >= Date.parse(state.leaseExpiresAt)) {
      fail('LEASE_EXPIRED', 409);
    }
    const guard = await this.currentGuard(job);
    return { state, job, guard, identity };
  }

  private evidenceLease(job: LabJobRecordV2, evidenceId: string, downloadToken: string, expiresAt: string) {
    const evidence = job.envelope.evidence.find(value => value.evidenceId === evidenceId);
    const content = job.envelope.contents.find(value => value.evidenceId === evidenceId && value.lifecycleState === 'active');
    if(!evidence || !content || evidence.lifecycleState !== 'active') fail('INACTIVE_EVIDENCE', 409);
    const bindingId = job.envelope.bindings.find(value => value.sourceContentId === content.contentId && value.state === 'active')?.bindingId;
    const common = {
      evidenceId,
      contentId: content.contentId,
      modality: content.modality,
      revision: evidence.revision,
      sourceHash: evidence.sourceHash,
      lifecycleState: 'active' as const,
      ...(bindingId ? { bindingId } : {}),
    };
    if(content.modality === 'image') {
      const ref = job.assetRefs.find(value => value.evidenceId === evidenceId);
      if(!ref || ref.mimeType === 'text/plain') fail('LAB_ASSET_NOT_FOUND', 404);
      return {
        ...common,
        artifact: {
          artifactId: opaqueId('artifact', [job.jobId, evidenceId, evidence.sourceHash]),
          downloadUrl: `${this.publicBaseUrl}/internal/v1/classification/artifacts/${encodeURIComponent(job.jobId)}/${encodeURIComponent(evidenceId)}?token=${downloadToken}`,
          expiresAt,
          sha256: evidence.sourceHash,
          byteLength: evidence.byteLength,
          mimeType: evidence.mimeType,
        },
      };
    }
    const text = job.originalTextByEvidenceId[evidenceId];
    if(text === undefined) fail('MISSING_LAB_TEXT_PAYLOAD', 500);
    return { ...common, inlineText: { text, sha256: evidence.sourceHash } };
  }

  async lease(raw: unknown): Promise<unknown> {
    const request = LeaseRequestSchema.parse(raw);
    const leases: unknown[] = [];
    for(const candidate of await this.store.list(100)) {
      if(leases.length >= request.maxJobs) break;
      if(candidate.status !== 'pending') continue;
      if(this.clock.nowMs() >= Date.parse(candidate.deadlineAt)) continue;
      let guard: TrustedLabGuardSnapshot;
      try { guard = await this.currentGuard(candidate); }
      catch { continue; }
      if(!this.workerMatches(candidate, guard, request.versions, request.capabilities)) continue;

      const at = later(candidate.updatedAt, iso(() => this.clock.nowMs()));
      const claimed = await this.store.compareAndSetTrusted(candidate.jobId, candidate.revision, current => ({
        ...current,
        status: 'processing',
        startedAt: at,
        updatedAt: at,
        processingOwner: { runnerGeneration: request.workerId, claimedAt: at },
        transitions: [...current.transitions, {
          from: 'pending',
          to: 'processing',
          reason: 'LAB_JOB_CLAIMED',
          at,
          revision: current.revision + 1,
          runnerGeneration: request.workerId,
        }],
      }));
      if(!claimed.ok) continue;

      const leaseToken = secret();
      const resultUploadToken = secret();
      const expiresAt = new Date(Math.min(
        Date.parse(claimed.record.deadlineAt),
        this.clock.nowMs() + this.leaseDurationMs,
      )).toISOString();
      const resultArtifactId = opaqueId('result', [claimed.record.jobId, claimed.record.runId, claimed.record.attemptRevision]);
      const state = WorkerControlStateSchema.parse({
        version: WORKER_CONTROL_STATE_VERSION,
        revision: 0,
        jobId: claimed.record.jobId,
        runId: claimed.record.runId,
        workerId: request.workerId,
        leaseTokenHash: hashSecret(leaseToken),
        leaseExpiresAt: expiresAt,
        jobRevision: claimed.record.revision,
        attemptRevision: claimed.record.attemptRevision,
        authorizationRevision: claimed.record.authorization.authorizationRevision,
        inputHash: claimed.record.contentDigest,
        executionProfileDigest: claimed.record.executionProfile.configDigest,
        resultArtifactId,
        resultUploadTokenHash: hashSecret(resultUploadToken),
        resultUploadExpiresAt: expiresAt,
        resultMaxByteLength: this.resultMaxByteLength,
        status: 'leased',
        progress: 0,
        stage: 'lease',
        createdAt: at,
        updatedAt: at,
      });
      try {
        await this.exclusive(claimed.record.jobId, async () => {
          if(await this.readState(claimed.record.jobId)) fail('LEASE_STATE_CONFLICT', 409);
          await this.writeState(state);
        });
      } catch {
        // A claimed job without a durable lease cannot be handed to a worker.
        // Preserve the failure as a retryable terminal record instead of
        // leaving an unobservable processing job behind.
        try { await this.terminalFailure(claimed.record, 'INTERNAL_ERROR', true); }
        catch { /* A concurrent state change already fenced this claim. */ }
        continue;
      }

      leases.push({
        jobId: claimed.record.jobId,
        runId: claimed.record.runId,
        leaseToken,
        leaseExpiresAt: expiresAt,
        jobRevision: claimed.record.revision,
        attemptRevision: claimed.record.attemptRevision,
        scope: claimed.record.envelope.scope,
        authorizationRevision: claimed.record.authorization.authorizationRevision,
        deadlineAt: claimed.record.deadlineAt,
        inputHash: claimed.record.contentDigest,
        executionProfileDigest: claimed.record.executionProfile.configDigest,
        evidence: claimed.record.envelope.contents
          .filter(content => content.lifecycleState === 'active')
          .map(content => this.evidenceLease(claimed.record, content.evidenceId, leaseToken, expiresAt)),
        resultUpload: {
          artifactId: resultArtifactId,
          uploadUrl: `${this.publicBaseUrl}/internal/v1/classification/results/${encodeURIComponent(claimed.record.jobId)}/${encodeURIComponent(resultArtifactId)}?token=${resultUploadToken}`,
          expiresAt,
          maxByteLength: this.resultMaxByteLength,
          mimeType: 'application/json',
        },
      });
    }
    return { protocolVersion: WORKER_CONTROL_PLANE_VERSION, requestId: request.requestId, leases };
  }

  async heartbeat(jobId: string, raw: unknown): Promise<unknown> {
    const request = HeartbeatRequestSchema.parse(raw);
    try {
      const active = await this.requireActiveLease(id.parse(jobId), request.identity);
      const expiresAt = new Date(Math.min(
        Date.parse(active.job.deadlineAt),
        this.clock.nowMs() + this.leaseDurationMs,
      )).toISOString();
      await this.updateState(jobId, current => ({
        ...current,
        leaseExpiresAt: expiresAt,
        resultUploadExpiresAt: expiresAt,
        progress: request.progress,
        stage: request.stage,
        updatedAt: later(current.updatedAt, iso(() => this.clock.nowMs())),
      }));
      return { protocolVersion: WORKER_CONTROL_PLANE_VERSION, requestId: request.requestId, leaseExpiresAt: expiresAt, control: 'continue' };
    } catch(error) {
      const code = error instanceof WorkerControlPlaneError ? error.code : 'INTERNAL_ERROR';
      const control = code === 'LEASE_EXPIRED' ? 'deadline_exceeded'
        : ['AUTHORIZATION_CHANGED', 'EVIDENCE_CHANGED'].includes(code) ? 'authorization_changed'
          : ['INACTIVE_EVIDENCE', 'LEASE_TERMINAL', 'STALE_RESULT'].includes(code) ? 'cancel'
            : undefined;
      if(!control) throw error;
      const state = await this.readState(jobId);
      return {
        protocolVersion: WORKER_CONTROL_PLANE_VERSION,
        requestId: request.requestId,
        leaseExpiresAt: state?.leaseExpiresAt ?? new Date(this.clock.nowMs()).toISOString(),
        control,
      };
    }
  }

  async executionContext(jobId: string, raw: unknown): Promise<unknown> {
    const request = ExecutionContextRequestSchema.parse(raw);
    const { state, job, guard } = await this.requireActiveLease(id.parse(jobId), request.identity);
    return {
      protocolVersion: WORKER_CONTROL_PLANE_VERSION,
      requestId: request.requestId,
      contextVersion: 'classification-worker-stage-a-context.1',
      binding: {
        jobId: job.jobId,
        runId: job.runId,
        jobRevision: state.jobRevision,
        attemptRevision: job.attemptRevision,
        scope: job.envelope.scope,
        authorizationRevision: job.authorization.authorizationRevision,
        inputHash: job.contentDigest,
        executionProfileDigest: job.executionProfile.configDigest,
      },
      execution: {
        job,
        guard,
        placeKindPolicy: {
          policyVersion: 'classification-place-kind.1',
          taxonomyVersion: job.executionProfile.taxonomyVersion,
          genericLabels: ['家中', '室内', '户外'],
        },
      },
    };
  }

  async historicalQuery(jobId: string, raw: unknown): Promise<HistoricalRetrievalResult> {
    const request = HistoricalQueryRequestSchema.parse(raw);
    const { job } = await this.requireActiveLease(id.parse(jobId), request.identity);
    const query = request.query;
    if(!sameScope(query.scope, job.envelope.scope)
      || query.authorizationRevision !== job.authorization.authorizationRevision) fail('CROSS_SCOPE', 403);
    const currentEvidence = new Set(job.envelope.evidence.map(value => value.evidenceId));
    if(query.sources.some(source => !currentEvidence.has(source.sourceEvidenceId))) fail('FOREIGN_RETRIEVAL_SOURCE', 403);
    return this.historical.query(query);
  }

  async readArtifact(jobId: string, evidenceId: string, leaseToken: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const state = await this.readState(id.parse(jobId));
    if(!state || state.status !== 'leased') fail('LEASE_NOT_FOUND', 404);
    if(!safeEqual(hashSecret(leaseToken), state.leaseTokenHash)) fail('ARTIFACT_TOKEN_INVALID', 403);
    const job = await this.store.get(jobId);
    if(!job || job.status !== 'processing' || job.revision !== state.jobRevision) fail('STALE_RESULT', 409);
    await this.currentGuard(job);
    const value = await this.store.readAsset(jobId, id.parse(evidenceId));
    if(value.ref.mimeType === 'text/plain') fail('TEXT_ARTIFACT_NOT_DOWNLOADABLE', 404);
    return { bytes: value.bytes, mimeType: value.ref.mimeType };
  }

  async uploadResult(input: {
    jobId: string;
    artifactId: string;
    uploadToken: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ sha256: `sha256:${string}`; byteLength: number }> {
    return this.exclusive(input.jobId, async () => {
      const state = await this.readState(id.parse(input.jobId));
      if(!state || state.status !== 'leased') fail('LEASE_NOT_FOUND', 404);
      if(state.resultArtifactId !== id.parse(input.artifactId)
        || !safeEqual(hashSecret(input.uploadToken), state.resultUploadTokenHash)) fail('RESULT_UPLOAD_TOKEN_INVALID', 403);
      if(input.mimeType !== 'application/json') fail('RESULT_UPLOAD_MIME_INVALID', 415);
      if(input.bytes.length <= 0 || input.bytes.length > state.resultMaxByteLength) fail('RESULT_UPLOAD_SIZE_INVALID', 413);
      if(this.clock.nowMs() >= Date.parse(state.resultUploadExpiresAt)) fail('RESULT_UPLOAD_EXPIRED', 410);
      try { JSON.parse(input.bytes.toString('utf8')); }
      catch { fail('RESULT_UPLOAD_JSON_INVALID'); }
      const resultHash = hashBytes(input.bytes);
      if(state.uploadedResult) {
        if(state.uploadedResult.sha256 !== resultHash || state.uploadedResult.byteLength !== input.bytes.length) {
          fail('RESULT_UPLOAD_CONFLICT', 409);
        }
        return { sha256: resultHash, byteLength: input.bytes.length };
      }
      const directory = path.dirname(this.resultFile(input.jobId));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = this.resultFile(input.jobId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, input.bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
      const uploadedAt = later(state.updatedAt, iso(() => this.clock.nowMs()));
      await this.writeState(WorkerControlStateSchema.parse({
        ...state,
        revision: state.revision + 1,
        updatedAt: uploadedAt,
        uploadedResult: {
          sha256: resultHash,
          byteLength: input.bytes.length,
          mimeType: 'application/json',
          uploadedAt,
        },
      }));
      return { sha256: resultHash, byteLength: input.bytes.length };
    });
  }

  private parsePipeline(raw: unknown, state: WorkerControlState, job: LabJobRecordV2): {
    classification: LabExecutionResult;
    featureBundle: Record<string, unknown>;
  } {
    if(!raw || typeof raw !== 'object') fail('PROVIDER_INVALID_OUTPUT');
    const value = raw as Record<string, unknown>;
    if(value.schemaVersion !== WORKER_PIPELINE_RESULT_VERSION || value.jobId !== job.jobId || value.runId !== job.runId
      || stable(value.scope) !== stable(job.envelope.scope)
      || value.authorizationRevision !== job.authorization.authorizationRevision
      || value.inputHash !== job.contentDigest || value.executionProfileDigest !== job.executionProfile.configDigest) {
      fail('PROVIDER_INVALID_OUTPUT');
    }
    if(!value.featureBundle || typeof value.featureBundle !== 'object') fail('PROVIDER_INVALID_OUTPUT');
    const classification = validateLabExecutionResultAgainstEnvelope(value.classification, job.envelope, job.executionProfile);
    return { classification, featureBundle: value.featureBundle as Record<string, unknown> };
  }

  private historyRecords(job: LabJobRecordV2, guard: TrustedLabGuardSnapshot, featureBundle: Record<string, unknown>, at: string): HistoricalFeatureRecord[] {
    const items = Array.isArray(featureBundle.evidence) ? featureBundle.evidence as Array<Record<string, unknown>> : [];
    const itemByEvidence = new Map(items.map(item => [String(item.evidenceId), item]));
    const contentByEvidence = new Map(job.envelope.contents.map(content => [content.evidenceId, content]));
    const guardByEvidence = new Map(guard.evidence.map(evidence => [evidence.evidenceId, evidence]));
    const textVectorsByImageContent = new Map<string, ReturnType<typeof normalizedVector>[]>();
    const activeImageContents = new Set(job.envelope.contents
      .filter(content => content.lifecycleState === 'active' && content.modality === 'image')
      .map(content => content.contentId));
    for(const binding of job.envelope.bindings) {
      if(binding.state !== 'active' || binding.authority !== 'user_explicit' || binding.target.kind !== 'contents') continue;
      const source = job.envelope.contents.find(content => content.contentId === binding.sourceContentId);
      if(!source || source.modality === 'image') continue;
      const vector = normalizedVector((itemByEvidence.get(source.evidenceId)?.features as Record<string, unknown> | undefined)?.textEmbedding);
      if(!vector) continue;
      for(const contentId of binding.target.contentIds.filter(value => activeImageContents.has(value))) {
        textVectorsByImageContent.set(contentId, [...(textVectorsByImageContent.get(contentId) ?? []), vector]);
      }
    }

    const records: HistoricalFeatureRecord[] = [];
    for(const evidence of job.envelope.evidence) {
      if(evidence.lifecycleState !== 'active' || evidence.modality !== 'image') continue;
      const content = contentByEvidence.get(evidence.evidenceId);
      const item = itemByEvidence.get(evidence.evidenceId);
      const guarded = guardByEvidence.get(evidence.evidenceId);
      if(!content || content.modality !== 'image' || !item || !guarded) continue;
      if(item.contentId !== content.contentId || item.sourceHash !== evidence.sourceHash || item.revision !== evidence.revision) {
        fail('PROVIDER_INVALID_OUTPUT');
      }
      const features = item.features && typeof item.features === 'object' ? item.features as Record<string, unknown> : {};
      const semantic = meanVector(textVectorsByImageContent.get(content.contentId) ?? [])
        ?? normalizedVector(features.imageEmbedding);
      const artifactId = opaqueId('historical_artifact', [job.jobId, evidence.evidenceId, evidence.sourceHash]);
      if(semantic) {
        records.push(HistoricalFeatureRecordSchema.parse({
          schemaVersion: '2.0',
          contractVersion: 'classification-historical-retrieval.2',
          recordId: opaqueId('historical_record', [job.jobId, evidence.evidenceId, 'semantic']),
          featureId: opaqueId('historical_feature', [job.runId, evidence.evidenceId, semantic.modelId, semantic.modelRevision]),
          scope: job.envelope.scope,
          authorizationRevision: job.authorization.authorizationRevision,
          contentId: content.contentId,
          evidenceId: evidence.evidenceId,
          evidenceRevision: evidence.revision,
          sourceHash: evidence.sourceHash,
          kind: 'image_text_embedding',
          modelId: semantic.modelId,
          modelRevision: semantic.modelRevision,
          dimensions: semantic.dimensions,
          normalized: true,
          vector: semantic.vector,
          lifecycleState: 'active',
          projection: {
            contentId: content.contentId,
            evidenceId: evidence.evidenceId,
            evidenceRevision: evidence.revision,
            sourceHash: evidence.sourceHash,
            artifactId,
            mimeType: evidence.mimeType,
            byteLength: evidence.byteLength,
            consentRef: evidence.consentRef,
            confirmedReferenceIds: [],
            lifecycleState: 'active',
          },
          createdAt: at,
          updatedAt: at,
        }));
      }
      const faces = features.faceEmbeddings as Record<string, unknown> | undefined;
      if(!guarded.personConsentRef || !faces || !Array.isArray(faces.faces)) continue;
      const modelId = typeof faces.embeddingModelId === 'string' ? faces.embeddingModelId : undefined;
      const modelRevision = typeof faces.embeddingModelRevision === 'string' ? faces.embeddingModelRevision : undefined;
      const dimensions = Number(faces.dimensions);
      if(!modelId || !modelRevision || !Number.isInteger(dimensions) || faces.normalized !== true) fail('PROVIDER_INVALID_OUTPUT');
      for(const face of faces.faces as Array<Record<string, unknown>>) {
        const vector = normalizedVector({ modelId, modelRevision, dimensions, normalized: true, vector: face.vector });
        if(!vector || typeof face.faceId !== 'string') fail('PROVIDER_INVALID_OUTPUT');
        records.push(HistoricalFeatureRecordSchema.parse({
          schemaVersion: '2.0',
          contractVersion: 'classification-historical-retrieval.2',
          recordId: opaqueId('historical_record', [job.jobId, evidence.evidenceId, face.faceId]),
          featureId: opaqueId('historical_feature', [job.runId, evidence.evidenceId, face.faceId, modelId, modelRevision]),
          scope: job.envelope.scope,
          authorizationRevision: job.authorization.authorizationRevision,
          contentId: content.contentId,
          evidenceId: evidence.evidenceId,
          evidenceRevision: evidence.revision,
          sourceHash: evidence.sourceHash,
          kind: 'face_embedding',
          modelId,
          modelRevision,
          dimensions,
          normalized: true,
          vector: vector.vector,
          lifecycleState: 'active',
          projection: {
            contentId: content.contentId,
            evidenceId: evidence.evidenceId,
            evidenceRevision: evidence.revision,
            sourceHash: evidence.sourceHash,
            artifactId,
            mimeType: evidence.mimeType,
            byteLength: evidence.byteLength,
            consentRef: evidence.consentRef,
            personConsentRef: guarded.personConsentRef,
            faceId: face.faceId,
            confirmedReferenceIds: (guard.personReferences ?? [])
              .filter(reference => reference.endpoint.photoId === evidence.evidenceId)
              .map(reference => reference.personId),
            lifecycleState: 'active',
          },
          createdAt: at,
          updatedAt: at,
        }));
      }
    }
    return records;
  }

  private labMetrics(usage: z.infer<typeof WorkerUsageSchema>, job: LabJobRecordV2): LabExecutionMetrics {
    const imageCount = job.envelope.contents.filter(content => content.lifecycleState === 'active' && content.modality === 'image').length;
    return {
      latencyMs: usage.endToEndLatencyMs,
      modelRequests: usage.providerCalls,
      imageRequests: usage.providerCalls > 0 ? imageCount : 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCny: usage.costCny,
    };
  }

  private async terminalFailure(job: LabJobRecordV2, code: string, retryable: boolean): Promise<LabJobRecordV2> {
    const status = retryable ? 'failed_retryable' as const : 'failed_terminal' as const;
    const at = later(job.updatedAt, iso(() => this.clock.nowMs()));
    const result = await this.store.compareAndSetTrusted(job.jobId, job.revision, current => ({
      ...current,
      status,
      updatedAt: at,
      finishedAt: at,
      error: { code, retryable },
      transitions: [...current.transitions, {
        from: 'processing',
        to: status,
        reason: retryable ? 'LAB_PROVIDER_UNAVAILABLE' : 'INVALID_OUTPUT',
        at,
        revision: current.revision + 1,
        runnerGeneration: current.processingOwner?.runnerGeneration,
      }],
    }));
    return result.record;
  }

  async complete(jobId: string, raw: unknown): Promise<unknown> {
    const request = CompleteRequestSchema.parse(raw);
    const { state, job, guard } = await this.requireActiveLease(id.parse(jobId), request.identity);
    if(request.versions.providerVersion !== job.executionProfile.providerVersion
      || request.versions.promptVersion !== job.executionProfile.promptVersion
      || request.versions.guardVersion !== job.executionProfile.guardVersion
      || request.versions.adapterVersion !== job.executionProfile.adapterVersion
      || request.versions.taxonomyVersion !== job.executionProfile.taxonomyVersion) fail('VERSION_MISMATCH', 409);
    if(request.resultArtifact.artifactId !== state.resultArtifactId || !state.uploadedResult
      || request.resultArtifact.sha256 !== state.uploadedResult.sha256
      || request.resultArtifact.byteLength !== state.uploadedResult.byteLength) fail('RESULT_ARTIFACT_MISMATCH', 409);
    const bytes = await readFile(this.resultFile(jobId));
    if(hashBytes(bytes) !== request.resultArtifact.sha256 || bytes.length !== request.resultArtifact.byteLength) {
      fail('RESULT_ARTIFACT_MISMATCH', 409);
    }
    const pipeline = this.parsePipeline(JSON.parse(bytes.toString('utf8')), state, job);
    if(pipeline.classification.workflowStatus === 'needs_review' && request.status !== 'needs_review') fail('WORKFLOW_STATUS_MISMATCH');
    const result = validateLabExecutionResultAgainstEnvelope({
      ...pipeline.classification,
      workflowStatus: request.status,
    }, job.envelope, job.executionProfile);
    const at = later(job.updatedAt, iso(() => this.clock.nowMs()));
    const records = this.historyRecords(job, guard, pipeline.featureBundle, at);
    const committed = await this.store.compareAndSetTrusted(jobId, job.revision, current => ({
      ...current,
      status: request.status,
      updatedAt: at,
      finishedAt: at,
      result,
      resultDigest: computeLabResultDigest(result),
      metrics: this.labMetrics(request.usage, job),
      transitions: [...current.transitions, {
        from: 'processing',
        to: request.status,
        reason: request.status === 'needs_review' ? 'LAB_RUN_NEEDS_REVIEW' : 'LAB_RUN_SUCCEEDED',
        at,
        revision: current.revision + 1,
        runnerGeneration: current.processingOwner?.runnerGeneration,
      }],
    }));
    if(!committed.ok) fail('STALE_RESULT', 409);
    if(records.length) await this.historical.upsert({
      scope: job.envelope.scope,
      authorizationRevision: job.authorization.authorizationRevision,
      records,
    });
    await this.updateState(jobId, current => ({ ...current, status: 'completed', progress: 100, updatedAt: at }));
    return {
      protocolVersion: WORKER_CONTROL_PLANE_VERSION,
      requestId: request.requestId,
      accepted: true,
      jobRevision: committed.record.revision,
      historicalRecordsUpserted: records.length,
    };
  }

  async fail(jobId: string, raw: unknown): Promise<unknown> {
    const request = FailRequestSchema.parse(raw);
    const { job } = await this.requireActiveLease(id.parse(jobId), request.identity);
    const retryableCodes = new Set([
      'DOWNLOAD_FAILED', 'FEATURE_SERVICE_UNAVAILABLE', 'OCR_FAILED', 'EMBEDDING_FAILED',
      'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED', 'RESULT_UPLOAD_FAILED', 'INTERNAL_ERROR',
    ]);
    const retryable = retryableCodes.has(request.errorCode);
    const record = await this.terminalFailure(job, request.errorCode, retryable);
    await this.updateState(jobId, current => ({
      ...current,
      status: 'failed',
      stage: request.stage,
      updatedAt: later(current.updatedAt, iso(() => this.clock.nowMs())),
    }));
    return { protocolVersion: WORKER_CONTROL_PLANE_VERSION, requestId: request.requestId, accepted: true, jobRevision: record.revision };
  }

  async cancelAck(jobId: string, raw: unknown): Promise<unknown> {
    const request = CancelAckRequestSchema.parse(raw);
    const state = await this.readState(id.parse(jobId));
    if(!state) fail('LEASE_NOT_FOUND', 404);
    this.identityState(request.identity, state);
    const job = await this.store.get(jobId);
    if(!job) fail('LAB_JOB_NOT_FOUND', 404);
    if(job.status === 'processing' && job.revision === state.jobRevision) {
      const code = request.reason === 'authorization_changed' ? 'AUTHORIZATION_CHANGED'
        : request.reason === 'evidence_inactive' ? 'INACTIVE_EVIDENCE'
          : request.reason === 'deadline_exceeded' ? 'LAB_RUN_TIMEOUT' : 'CANCELLED';
      const at = later(job.updatedAt, iso(() => this.clock.nowMs()));
      await this.store.compareAndSetTrusted(jobId, job.revision, current => ({
        ...current,
        status: request.reason === 'deadline_exceeded' ? 'failed_retryable' : 'cancelled',
        updatedAt: at,
        finishedAt: at,
        termination: {
          requestedAt: at,
          reason: request.reason === 'deadline_exceeded' ? 'timeout'
            : request.reason === 'authorization_changed' ? 'authorization_revoked'
              : request.reason === 'evidence_inactive' ? 'evidence_changed' : 'user',
        },
        error: { code, retryable: request.reason === 'deadline_exceeded' },
        transitions: [...current.transitions, {
          from: 'processing',
          to: request.reason === 'deadline_exceeded' ? 'failed_retryable' : 'cancelled',
          reason: code,
          at,
          revision: current.revision + 1,
          runnerGeneration: current.processingOwner?.runnerGeneration,
        }],
      }));
    }
    await this.updateState(jobId, current => ({
      ...current,
      status: 'cancelled',
      updatedAt: later(current.updatedAt, iso(() => this.clock.nowMs())),
    }));
    return {
      protocolVersion: WORKER_CONTROL_PLANE_VERSION,
      requestId: request.requestId,
      accepted: true,
      temporaryFilesDeleted: request.temporaryFilesDeleted,
    };
  }
}

export function verifyWorkerBearer(rawHeader: string | null, expectedToken: string): void {
  if(!expectedToken || expectedToken.length < 32) fail('CONTROL_PLANE_TOKEN_NOT_CONFIGURED', 503);
  const prefix = 'Bearer ';
  if(!rawHeader?.startsWith(prefix) || !safeEqual(hashSecret(rawHeader.slice(prefix.length)), hashSecret(expectedToken))) {
    fail('CONTROL_PLANE_UNAUTHORIZED', 401);
  }
}

export function workerControlPlaneDigest(value: unknown): `sha256:${string}` {
  return digest(value) as `sha256:${string}`;
}
