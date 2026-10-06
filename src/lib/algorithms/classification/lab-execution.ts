import { z } from 'zod';
import type { BuiltLabSubmission } from './lab-contract';
import {
  LAB_JOB_VERSION_V2,
  LabBudgetPolicySchema,
  LabExecutionProfileSchema,
  LabProductJobViewSchema,
  LabRedactedJobShellSchema,
  SemanticContextV1Schema,
  TrustedPrivacyControlEventSchema,
  buildLabContentIdentity,
  buildLabRunIdentity,
  computeLabContentDigest,
  computeLabGrantDigest,
  computeLabGuardDigest,
  computeLabResultDigest,
  computeLabRunIdentityDigest,
  deriveLabRunIds,
  mapLabExecutionError,
  parseLabExecutionOutcome,
  parseLabExecutionResult,
  parseLabJobV2,
  parseTrustedLabGuardSnapshot,
  validateLabExecutionResultAgainstEnvelope,
  type LabBudgetPolicy,
  type LabExecutionOutcome,
  type LabExecutionProfile,
  type LabExecutionResult,
  type LabJobRecordV2,
  type LabJobStatusV2,
  type LabProductJobView,
  type LabRedactedJobShell,
  type SemanticContextV1,
  type TrustedLabGuardSnapshot,
  type TrustedPrivacyControlEvent
} from './lab-execution-contract';
import { FileClassificationLabV2Store } from './lab-execution-store';
import { parseIngestionEnvelope } from './ingestion-contract';
import { stable, type RetrievalHint } from './stage-a-contract';

type LabPurpose = 'classification' | 'album_organization' | 'search_candidate' | 'interview_candidate';
type FailureStatus = 'cancelled' | 'failed_retryable' | 'failed_terminal';

export interface LabClock {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TrustedLabGuardProvider {
  get(jobId: string): Promise<TrustedLabGuardSnapshot>;
}

export interface LabExecutionExecutor {
  readonly profile: LabExecutionProfile;
  execute(input: {
    job: LabJobRecordV2;
    signal: AbortSignal;
    clock: LabClock;
    getGuard: () => Promise<TrustedLabGuardSnapshot>;
    readAsset: (evidenceId: string) => Promise<Uint8Array>;
    derivedFeatures?: TrustedLabDerivedFeatures;
  }): Promise<LabExecutionOutcome>;
}

export interface TrustedLabDerivedFeatures {
  version: 'classification-worker-derived-features.2';
  ocrTextByEvidenceId: Readonly<Record<string, {
    sourceHash: `sha256:${string}`;
    text: string;
  }>>;
  retrievalHints: readonly RetrievalHint[];
  historicalCandidates: readonly {
    candidateId: string;
    sourceContentId: string;
    sourceEvidenceId: string;
    sourceFaceId?: string;
    historicalContentId: string;
    historicalEvidenceId: string;
    kind: 'image_text_embedding' | 'face_embedding';
    rank: number;
    modelId: string;
    modelRevision: string;
    reasons: readonly string[];
    featureRefs: readonly string[];
    evidenceRefs: readonly string[];
    historicalProjection: {
      contentId: string;
      evidenceId: string;
      evidenceRevision: number;
      sourceHash: `sha256:${string}`;
      artifactId: string;
      mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';
      byteLength: number;
      consentRef: string;
      personConsentRef?: string;
      faceId?: string;
      observationRef?: string;
      confirmedReferenceIds: readonly string[];
      lifecycleState: 'active';
    };
  }[];
  embeddingRetrieval: 'batch_topk' | 'disabled_component_failure' | 'not_applicable';
  faceCandidatesByEvidenceId?: Readonly<Record<string, {
    sourceHash: `sha256:${string}`;
    detectorModelId: string;
    detectorModelRevision: string;
    embeddingModelId: string;
    embeddingModelRevision: string;
    dimensions: number;
    faces: readonly {
      faceId: string;
      bounds: { x: number; y: number; width: number; height: number };
      detectorScore?: number;
    }[];
  }>>;
  faceRetrieval?: 'batch_topk' | 'disabled_component_failure' | 'disabled_invalid_feature' | 'not_applicable';
  historicalRetrieval: 'historical_topk' | 'no_candidates' | 'disabled_component_failure' | 'not_configured' | 'not_applicable';
}

export interface TrustedLabExecutionContext {
  job: LabJobRecordV2;
  signal: AbortSignal;
  clock: LabClock;
  getGuard: () => Promise<TrustedLabGuardSnapshot>;
  readAsset: (evidenceId: string) => Promise<Uint8Array>;
  readModelInput?: (evidenceId: string) => Promise<{
    bytes: Uint8Array;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    derivedFromSourceHash: `sha256:${string}`;
    modelInputHash: `sha256:${string}`;
    transformVersion: string;
  } | undefined>;
  derivedFeatures?: TrustedLabDerivedFeatures;
}

export interface LabExecutionExecutorFactory {
  /** Credential-free and side-effect-free descriptor validation. */
  describe(profile: LabExecutionProfile): LabExecutionProfile;
  /** Called only after claim, profile validation, and the first trusted guard pass. */
  create(
    profile: LabExecutionProfile,
    context: TrustedLabExecutionContext
  ): LabExecutionExecutor | Promise<LabExecutionExecutor>;
}

export interface SubmitLabExecutionInput {
  built: BuiltLabSubmission;
  profile: LabExecutionProfile;
  guard: TrustedLabGuardSnapshot;
  semanticContext: SemanticContextV1;
  budgetPolicy: LabBudgetPolicy;
  attemptRevision: number;
  deadlineAt: string;
}

export class LabExecutionError extends Error {
  constructor(readonly code: string) { super(code); }
}

const terminalStatuses = new Set<LabJobStatusV2>([
  'succeeded', 'needs_review', 'failed_retryable', 'failed_terminal', 'cancelled'
]);
const controllerRegistry = new Map<string, AbortController>();

function fail(code: string): never { throw new LabExecutionError(code); }
function clone<T>(value: T): T { return structuredClone(value); }
function equal(left: unknown, right: unknown): boolean { return stable(left) === stable(right); }
function nowIso(clock: LabClock): string { return new Date(clock.nowMs()).toISOString(); }
function laterIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
async function controllerKey(store: FileClassificationLabV2Store, jobId: string): Promise<string> {
  return store.coordinationKey(jobId);
}
function errorCode(error: unknown, fallback: string): string {
  if(error instanceof LabExecutionError) return error.code;
  if(error instanceof z.ZodError) return 'INVALID_OUTPUT';
  const message = error instanceof Error ? error.message : '';
  const safe = new Set([
    'CANCELLED', 'AUTHORIZATION_REVOKED', 'AUTHORIZATION_CHANGED', 'INACTIVE_EVIDENCE',
    'EVIDENCE_CHANGED', 'STALE_RESULT', 'INVALID_OUTPUT', 'LAB_RUN_IDENTITY_MISMATCH',
    'LAB_RUN_TIMEOUT', 'LAB_RUN_INTERRUPTED', 'LAB_PROVIDER_UNAVAILABLE',
    'LAB_GUARD_UNAVAILABLE', 'LAB_STORE_CORRUPT', 'LAB_STORE_WRITE_FAILED'
  ]);
  return safe.has(message) ? message : fallback;
}

function assertGuardMatchesEnvelope(built: BuiltLabSubmission, guard: TrustedLabGuardSnapshot): void {
  if(!guard.active) fail('AUTHORIZATION_REVOKED');
  if(!guard.purposes.includes('classification')) fail('AUTHORIZATION_CHANGED');
  if(!equal(guard.scope, built.envelope.scope) || guard.actorId !== built.envelope.actorId) {
    fail('AUTHORIZATION_CHANGED');
  }
  const evidenceById = new Map(guard.evidence.map(value => [value.evidenceId, value]));
  if(evidenceById.size !== built.envelope.evidence.length) fail('EVIDENCE_CHANGED');
  for(const evidence of built.envelope.evidence) {
    if(evidence.lifecycleState === 'deleted') fail('INACTIVE_EVIDENCE');
    const trusted = evidenceById.get(evidence.evidenceId);
    if(!trusted
      || trusted.revision !== evidence.revision
      || trusted.sourceHash !== evidence.sourceHash
      || trusted.consentRef !== evidence.consentRef) fail('EVIDENCE_CHANGED');
    if(trusted.lifecycleState !== 'active') fail('INACTIVE_EVIDENCE');
    if(!guard.allowedConsentRefs.includes(evidence.consentRef)) fail('AUTHORIZATION_CHANGED');
  }
}

function validateLiveGuard(
  job: LabJobRecordV2,
  raw: TrustedLabGuardSnapshot,
  requiredPurpose: LabPurpose,
  requireInitialState: boolean
): TrustedLabGuardSnapshot {
  const guard = parseTrustedLabGuardSnapshot(raw);
  if(!guard.active) fail('AUTHORIZATION_REVOKED');
  if(!guard.purposes.includes(requiredPurpose)) fail('AUTHORIZATION_CHANGED');
  if(!equal(guard.scope, job.envelope.scope)
    || guard.actorId !== job.authorization.actorId
    || guard.authorityRef !== job.authorization.authorityRef
    || guard.authorizationRevision !== job.authorization.authorizationRevision
    || guard.contextRevision !== job.authorization.contextRevision
    || computeLabGrantDigest(guard) !== job.authorization.grantDigest) fail('AUTHORIZATION_CHANGED');

  const evidenceById = new Map(guard.evidence.map(value => [value.evidenceId, value]));
  if(evidenceById.size !== job.envelope.evidence.length) fail('EVIDENCE_CHANGED');
  for(const evidence of job.envelope.evidence) {
    if(evidence.lifecycleState === 'deleted') fail('INACTIVE_EVIDENCE');
    const trusted = evidenceById.get(evidence.evidenceId);
    if(!trusted
      || trusted.revision !== evidence.revision
      || trusted.sourceHash !== evidence.sourceHash
      || trusted.consentRef !== evidence.consentRef) fail('EVIDENCE_CHANGED');
    if(!guard.allowedConsentRefs.includes(evidence.consentRef)) fail('AUTHORIZATION_CHANGED');
    if(requireInitialState && trusted.lifecycleState !== 'active') fail('INACTIVE_EVIDENCE');
  }
  if(requireInitialState && guard.guardDigest !== job.authorization.initialGuardDigest) fail('AUTHORIZATION_CHANGED');
  return guard;
}

async function getExecutionGuard(
  job: LabJobRecordV2,
  provider: TrustedLabGuardProvider
): Promise<TrustedLabGuardSnapshot> {
  let raw: TrustedLabGuardSnapshot;
  try { raw = await provider.get(job.jobId); }
  catch { fail('LAB_GUARD_UNAVAILABLE'); }
  return validateLiveGuard(job, raw, 'classification', true);
}

async function getFencedExecutionGuard(
  job: LabJobRecordV2,
  provider: TrustedLabGuardProvider,
  store: FileClassificationLabV2Store
): Promise<TrustedLabGuardSnapshot> {
  const guard = await getExecutionGuard(job, provider);
  return store.withRootExclusive(() => store.withJobExclusive(job.jobId, async () => {
    const current = await store.get(job.jobId);
    if(!current) fail('LAB_JOB_NOT_FOUND');
    if(current.status !== job.status || current.revision !== job.revision) {
      fail(current.error?.code ?? 'STALE_RESULT');
    }
    if(!sameFrozenRun(job, current)) fail('LAB_STORE_CORRUPT');
    const events = await listEffectiveLabPrivacyEvents(current, store);
    if(events.some(event => event.kind === 'authorization_revoked')) fail('AUTHORIZATION_REVOKED');
    if(events.some(event => event.kind === 'evidence_deleted')) fail('INACTIVE_EVIDENCE');
    return guard;
  }));
}

function transitionReason(code: string, status: FailureStatus): LabJobRecordV2['transitions'][number]['reason'] {
  const supported = new Set([
    'CANCELLED', 'AUTHORIZATION_REVOKED', 'AUTHORIZATION_CHANGED', 'INACTIVE_EVIDENCE',
    'EVIDENCE_CHANGED', 'INVALID_OUTPUT', 'LAB_RUN_IDENTITY_MISMATCH', 'LAB_RUN_TIMEOUT',
    'LAB_RUN_INTERRUPTED', 'LAB_PROVIDER_UNAVAILABLE', 'LAB_GUARD_UNAVAILABLE', 'LAB_STORE_CORRUPT'
  ]);
  if(supported.has(code)) return code as LabJobRecordV2['transitions'][number]['reason'];
  if(status === 'cancelled') return 'CANCELLED';
  if(status === 'failed_retryable') return 'LAB_PROVIDER_UNAVAILABLE';
  return 'INVALID_OUTPUT';
}

function terminationFor(code: string, at: string): LabJobRecordV2['termination'] | undefined {
  if(code === 'LAB_RUN_TIMEOUT') return { requestedAt: at, reason: 'timeout' };
  if(code === 'CANCELLED') return { requestedAt: at, reason: 'user' };
  if(code === 'AUTHORIZATION_REVOKED' || code === 'AUTHORIZATION_CHANGED') {
    return { requestedAt: at, reason: 'authorization_revoked' };
  }
  if(code === 'INACTIVE_EVIDENCE' || code === 'EVIDENCE_CHANGED') {
    return { requestedAt: at, reason: 'evidence_changed' };
  }
  return undefined;
}

async function persistFailure(
  jobId: string,
  code: string,
  store: FileClassificationLabV2Store,
  clock: LabClock,
  runnerGeneration?: string
): Promise<{ record: LabJobRecordV2; written: boolean }> {
  const disposition = mapLabExecutionError(code);
  if(disposition.kind === 'throw') fail(disposition.code);
  let current = await store.get(jobId);
  if(!current) fail('LAB_JOB_NOT_FOUND');
  while(true) {
    if(disposition.kind === 'no_write' || terminalStatuses.has(current.status)) {
      return { record: current, written: false };
    }
    const at = laterIso(current.updatedAt, nowIso(clock));
    const termination = terminationFor(code, at);
    const cas = await store.compareAndSetTrusted(jobId, current.revision, value => ({
      ...value,
      status: disposition.status,
      updatedAt: at,
      finishedAt: at,
      ...(termination ? { termination } : {}),
      error: { code: disposition.code, retryable: disposition.retryable },
      transitions: [...value.transitions, {
        from: value.status,
        to: disposition.status,
        reason: transitionReason(code, disposition.status),
        at,
        revision: value.revision + 1,
        ...(runnerGeneration ? { runnerGeneration } : {})
      }]
    }));
    if(cas.ok) return { record: cas.record, written: true };
    current = cas.record;
  }
}

export function mapLabExecutionFailure(code: string): {
  status: FailureStatus | 'unchanged';
  retryable: boolean | null;
} {
  const disposition = mapLabExecutionError(code);
  if(disposition.kind === 'no_write') return { status: 'unchanged', retryable: null };
  if(disposition.kind === 'throw') throw new LabExecutionError(disposition.code);
  return { status: disposition.status, retryable: disposition.retryable };
}

export async function submitLabExecutionJob(
  raw: SubmitLabExecutionInput,
  store: FileClassificationLabV2Store,
  clock: LabClock
): Promise<LabJobRecordV2> {
  return store.withRootExclusive(async () => {
    const profile = LabExecutionProfileSchema.parse(raw.profile);
    const semanticContext = SemanticContextV1Schema.parse(raw.semanticContext);
    const budgetPolicy = LabBudgetPolicySchema.parse(raw.budgetPolicy);
    const guard = parseTrustedLabGuardSnapshot(raw.guard);
    assertGuardMatchesEnvelope(raw.built, guard);
    for(const event of await store.listPrivacyEvents()) {
      if(!matchesPrivacyEventForGuard(guard, event)) continue;
      if(event.kind === 'authorization_revoked') fail('AUTHORIZATION_REVOKED');
      fail('INACTIVE_EVIDENCE');
    }
    const contentIdentity = buildLabContentIdentity(raw.built);
    const contentDigest = computeLabContentDigest(contentIdentity);
    const grantDigest = computeLabGrantDigest(guard);
    const runIdentity = buildLabRunIdentity({
      contentDigest,
      attemptRevision: raw.attemptRevision,
      executionProfile: profile,
      authorizationGrantDigest: grantDigest,
      authorizationRevision: guard.authorizationRevision,
      contextRevision: guard.contextRevision,
      semanticContext,
      budgetPolicy
    });
    const runIdentityDigest = computeLabRunIdentityDigest(runIdentity);
    const ids = deriveLabRunIds(runIdentityDigest);
    const at = nowIso(clock);
    const envelope = parseIngestionEnvelope({
      ...clone(raw.built.envelope),
      authorizationRevision: guard.authorizationRevision
    });
    const record = parseLabJobV2({
    version: LAB_JOB_VERSION_V2,
    revision: 0,
    ...ids,
    contentDigest,
    runIdentityDigest,
    attemptRevision: raw.attemptRevision,
    status: 'pending',
    executionProfile: profile,
    semanticContext,
    budgetPolicy,
    authorization: {
      actorId: guard.actorId,
      authorityRef: guard.authorityRef,
      authorizationRevision: guard.authorizationRevision,
      contextRevision: guard.contextRevision,
      grantDigest,
      initialGuardDigest: computeLabGuardDigest(guard),
      state: 'active'
    },
    createdAt: at,
    updatedAt: at,
    deadlineAt: raw.deadlineAt,
    envelope,
    originalTextByEvidenceId: clone(raw.built.payloads.textByEvidenceId),
    assetRefs: raw.built.assets.map(asset => {
      const evidence = envelope.evidence.find(value => value.evidenceId === asset.evidenceId);
      if(!evidence) fail('EVIDENCE_CHANGED');
      if(evidence.lifecycleState === 'deleted') fail('INACTIVE_EVIDENCE');
      return {
        evidenceId: asset.evidenceId,
        filename: asset.filename,
        mimeType: asset.mimeType,
        byteLength: asset.bytes.byteLength,
        sourceHash: evidence.sourceHash
      };
    }),
    actions: [],
    privacyEvents: [],
    transitions: [{
      from: 'none',
      to: 'pending',
      reason: 'LAB_JOB_CREATED',
      at,
      revision: 0
    }]
    });
    return (await store.create(record, raw.built.assets)).record;
  });
}

function highImpactPersonLabel(raw: string): boolean {
  const label = raw.normalize('NFKC').trim();
  return !/^(?:未命名人物|unnamed_person|person_group_[A-Za-z0-9]+|人物(?:[A-Za-z0-9一二三四五六七八九十]+)?|[一二三四五六七八九十两\d]+(?:位|个)?人|有人|老人|老年人|中年人|年轻人|孩子|儿童|婴儿|男性|女性|男士|女士|[一两二三四五六七八九十]+位(?:老人|孩子|男性|女性))$/.test(label);
}

function highImpactPersonObservation(value: LabExecutionResult['output']['observations'][number]): boolean {
  if(value.facet !== 'person' || value.state === 'abstained') return false;
  return highImpactPersonLabel(value.rawValue)
    || (value.normalizedValue !== undefined && highImpactPersonLabel(value.normalizedValue));
}

function requiresReview(result: LabExecutionResult): boolean {
  const output = result.output;
  return output.organization.reviewItems.length > 0
    || output.highImpactClaims.length > 0
    || output.observations.some(value => value.state === 'conflicted' || highImpactPersonObservation(value))
    || output.organization.stories.some(value => value.state === 'needs_review'
      || value.facets.people.some(highImpactPersonLabel))
    || output.organization.associations.some(value => value.status === 'needs_review')
    || output.organization.decisionResults.some(value => value.action === 'review' || value.riskLevel === 'high');
}

function forceWorkflowGate(outcome: LabExecutionOutcome, profile: LabExecutionProfile): LabExecutionOutcome {
  const parsed = parseLabExecutionOutcome(outcome, profile);
  const workflowStatus = requiresReview(parsed.result) ? 'needs_review' : parsed.result.workflowStatus;
  return parseLabExecutionOutcome({
    ...parsed,
    result: { ...parsed.result, workflowStatus }
  }, profile);
}

function sameFrozenRun(left: LabJobRecordV2, right: LabJobRecordV2): boolean {
  return left.jobId === right.jobId
    && left.runId === right.runId
    && left.idempotencyKey === right.idempotencyKey
    && left.contentDigest === right.contentDigest
    && left.runIdentityDigest === right.runIdentityDigest
    && left.attemptRevision === right.attemptRevision
    && equal(left.executionProfile, right.executionProfile)
    && equal(left.semanticContext, right.semanticContext)
    && equal(left.budgetPolicy, right.budgetPolicy)
    && left.authorization.actorId === right.authorization.actorId
    && left.authorization.authorityRef === right.authorization.authorityRef
    && left.authorization.authorizationRevision === right.authorization.authorizationRevision
    && left.authorization.contextRevision === right.authorization.contextRevision
    && left.authorization.grantDigest === right.authorization.grantDigest;
}

type ExecutionStageStart<T> =
  | { kind: 'started'; value: T }
  | { kind: 'terminal'; record: LabJobRecordV2 };

function privacyFailureCode(events: readonly TrustedPrivacyControlEvent[]): string | undefined {
  if(events.some(event => event.kind === 'authorization_revoked')) return 'AUTHORIZATION_REVOKED';
  if(events.some(event => event.kind === 'evidence_deleted')) return 'INACTIVE_EVIDENCE';
  return undefined;
}

/**
 * Linearizes the final durable-state check with the synchronous start of a
 * factory/executor stage. Async work is returned inside a wrapper so the root
 * and job locks are released after invocation, never held across Provider I/O.
 */
async function startExecutionStage<T>(
  expected: LabJobRecordV2,
  store: FileClassificationLabV2Store,
  clock: LabClock,
  runnerGeneration: string,
  start: () => T
): Promise<ExecutionStageStart<T>> {
  return store.withRootExclusive(() => store.withJobExclusive(expected.jobId, async () => {
    const current = await store.get(expected.jobId);
    if(!current) fail('LAB_JOB_NOT_FOUND');
    if(current.status !== 'processing' || current.revision !== expected.revision) {
      return { kind: 'terminal', record: current };
    }
    if(!sameFrozenRun(expected, current)) fail('LAB_STORE_CORRUPT');
    if(clock.nowMs() >= Date.parse(current.deadlineAt)) {
      return {
        kind: 'terminal',
        record: (await persistFailure(
          current.jobId,
          'LAB_RUN_TIMEOUT',
          store,
          clock,
          runnerGeneration
        )).record
      };
    }
    const privacyCode = privacyFailureCode(await listEffectiveLabPrivacyEvents(current, store));
    if(privacyCode) {
      return {
        kind: 'terminal',
        record: (await persistFailure(current.jobId, privacyCode, store, clock, runnerGeneration)).record
      };
    }
    return { kind: 'started', value: start() };
  }));
}

async function readExecutionAsset(
  expected: LabJobRecordV2,
  evidenceId: string,
  options: {
    store: FileClassificationLabV2Store;
    guardProvider: TrustedLabGuardProvider;
    clock: LabClock;
    runnerGeneration: string;
  }
): Promise<Uint8Array> {
  await getExecutionGuard(expected, options.guardProvider);
  return options.store.withRootExclusive(() => options.store.withJobExclusive(expected.jobId, async () => {
    const current = await options.store.get(expected.jobId);
    if(!current) fail('LAB_JOB_NOT_FOUND');
    if(current.status !== 'processing' || current.revision !== expected.revision) {
      fail(current.error?.code ?? 'STALE_RESULT');
    }
    if(!sameFrozenRun(expected, current)) fail('LAB_STORE_CORRUPT');
    if(options.clock.nowMs() >= Date.parse(current.deadlineAt)) fail('LAB_RUN_TIMEOUT');
    const privacyCode = privacyFailureCode(await listEffectiveLabPrivacyEvents(current, options.store));
    if(privacyCode) fail(privacyCode);
    return (await options.store.readAsset(expected.jobId, evidenceId)).bytes;
  }));
}

export async function runPendingLabExecutionJob(
  jobId: string,
  options: {
    store: FileClassificationLabV2Store;
    factory: LabExecutionExecutorFactory;
    guardProvider: TrustedLabGuardProvider;
    clock: LabClock;
    runnerGeneration: string;
  }
): Promise<LabJobRecordV2> {
  const initial = await options.store.get(jobId);
  if(!initial) fail('LAB_JOB_NOT_FOUND');
  if(initial.version !== LAB_JOB_VERSION_V2) fail('LAB_LEGACY_JOB_READ_ONLY');
  if(initial.status !== 'pending') return initial;
  const claimedAt = laterIso(initial.updatedAt, nowIso(options.clock));
  const claimed = await options.store.compareAndSetTrusted(jobId, initial.revision, current => ({
    ...current,
    status: 'processing',
    startedAt: claimedAt,
    updatedAt: claimedAt,
    processingOwner: { runnerGeneration: options.runnerGeneration, claimedAt },
    transitions: [...current.transitions, {
      from: 'pending',
      to: 'processing',
      reason: 'LAB_JOB_CLAIMED',
      at: claimedAt,
      revision: current.revision + 1,
      runnerGeneration: options.runnerGeneration
    }]
  }));
  if(!claimed.ok) return claimed.record;
  let processing = claimed.record;
  const controller = new AbortController();
  const key = await controllerKey(options.store, jobId);
  controllerRegistry.set(key, controller);
  let timeoutHandle: unknown;
  try {
    type RaceResult<T> =
      | { kind: 'value'; value: T }
      | { kind: 'error'; error: unknown }
      | { kind: 'terminal'; record: LabJobRecordV2 };
    let resolveTerminal!: (value: RaceResult<never>) => void;
    const terminal = new Promise<RaceResult<never>>(resolve => { resolveTerminal = resolve; });
    controller.signal.addEventListener('abort', () => {
      void options.store.get(jobId).then(record => {
        if(record) resolveTerminal({ kind: 'terminal', record });
      }, error => resolveTerminal({ kind: 'error', error }));
    }, { once: true });
    const expire = (): void => {
      void persistFailure(jobId, 'LAB_RUN_TIMEOUT', options.store, options.clock, options.runnerGeneration)
        .then(({ record }) => {
          resolveTerminal({ kind: 'terminal', record });
          controller.abort();
        }, error => resolveTerminal({ kind: 'error', error }));
    };
    const delay = Math.max(0, Date.parse(processing.deadlineAt) - options.clock.nowMs());
    timeoutHandle = options.clock.setTimeout(expire, delay);
    const raceStage = async <T>(operation: Promise<T>): Promise<RaceResult<T>> => {
      const settled = Promise.resolve(operation)
        .then(value => ({ kind: 'value' as const, value }), error => ({ kind: 'error' as const, error }));
      return Promise.race([settled, terminal]);
    };

    const afterRegistration = await options.store.get(jobId);
    if(!afterRegistration) fail('LAB_JOB_NOT_FOUND');
    if(afterRegistration.status !== 'processing' || afterRegistration.revision !== processing.revision) {
      controller.abort();
      return afterRegistration;
    }
    processing = afterRegistration;
    if(options.clock.nowMs() >= Date.parse(processing.deadlineAt)) {
      const timedOut = await persistFailure(jobId, 'LAB_RUN_TIMEOUT', options.store, options.clock, options.runnerGeneration);
      controller.abort();
      return timedOut.record;
    }

    let describedProfile: LabExecutionProfile;
    try { describedProfile = LabExecutionProfileSchema.parse(options.factory.describe(clone(processing.executionProfile))); }
    catch {
      return (await persistFailure(jobId, 'LAB_RUN_IDENTITY_MISMATCH', options.store, options.clock, options.runnerGeneration)).record;
    }
    if(!equal(describedProfile, processing.executionProfile)) {
      return (await persistFailure(jobId, 'LAB_RUN_IDENTITY_MISMATCH', options.store, options.clock, options.runnerGeneration)).record;
    }

    const preflight = await raceStage(getFencedExecutionGuard(processing, options.guardProvider, options.store));
    if(preflight.kind === 'terminal') return preflight.record;
    if(preflight.kind === 'error') {
      return (await persistFailure(jobId, errorCode(preflight.error, 'LAB_GUARD_UNAVAILABLE'), options.store, options.clock, options.runnerGeneration)).record;
    }

    const context: TrustedLabExecutionContext = {
      job: clone(processing),
      signal: controller.signal,
      clock: options.clock,
      getGuard: () => getFencedExecutionGuard(processing, options.guardProvider, options.store),
      readAsset: evidenceId => readExecutionAsset(processing, evidenceId, options)
    };
    let factoryStart: ExecutionStageStart<{ promise: Promise<LabExecutionExecutor> }>;
    try {
      factoryStart = await startExecutionStage(
        processing,
        options.store,
        options.clock,
        options.runnerGeneration,
        () => ({ promise: Promise.resolve(options.factory.create(processing.executionProfile, context)) })
      );
    } catch(error) {
      return (await persistFailure(jobId, errorCode(error, 'LAB_PROVIDER_UNAVAILABLE'), options.store, options.clock, options.runnerGeneration)).record;
    }
    if(factoryStart.kind === 'terminal') return factoryStart.record;
    const created = await raceStage(factoryStart.value.promise);
    if(created.kind === 'terminal') return created.record;
    if(created.kind === 'error') {
      return (await persistFailure(jobId, errorCode(created.error, 'LAB_PROVIDER_UNAVAILABLE'), options.store, options.clock, options.runnerGeneration)).record;
    }
    const executor = created.value;
    let executorProfile: LabExecutionProfile;
    try { executorProfile = LabExecutionProfileSchema.parse(executor.profile); }
    catch {
      return (await persistFailure(jobId, 'LAB_RUN_IDENTITY_MISMATCH', options.store, options.clock, options.runnerGeneration)).record;
    }
    if(!equal(executorProfile, processing.executionProfile)) {
      return (await persistFailure(jobId, 'LAB_RUN_IDENTITY_MISMATCH', options.store, options.clock, options.runnerGeneration)).record;
    }
    let executorStart: ExecutionStageStart<{ promise: Promise<LabExecutionOutcome> }>;
    try {
      executorStart = await startExecutionStage(
        processing,
        options.store,
        options.clock,
        options.runnerGeneration,
        () => ({ promise: Promise.resolve(executor.execute(context)) })
      );
    } catch(error) {
      return (await persistFailure(jobId, errorCode(error, 'LAB_PROVIDER_UNAVAILABLE'), options.store, options.clock, options.runnerGeneration)).record;
    }
    if(executorStart.kind === 'terminal') return executorStart.record;
    const winner = await raceStage(executorStart.value.promise);
    if(winner.kind === 'terminal') return winner.record;
    if(winner.kind === 'error') {
      const latest = await options.store.get(jobId);
      if(latest && terminalStatuses.has(latest.status)) return latest;
      return (await persistFailure(jobId, errorCode(winner.error, 'LAB_PROVIDER_UNAVAILABLE'), options.store, options.clock, options.runnerGeneration)).record;
    }

    let outcome: LabExecutionOutcome;
    try {
      outcome = forceWorkflowGate(winner.value, processing.executionProfile);
      outcome = { ...outcome, result: validateLabExecutionResultAgainstEnvelope(
        outcome.result,
        processing.envelope,
        processing.executionProfile
      ) };
    }
    catch { return (await persistFailure(jobId, 'INVALID_OUTPUT', options.store, options.clock, options.runnerGeneration)).record; }
    const current = await options.store.get(jobId);
    if(!current) fail('LAB_JOB_NOT_FOUND');
    if(current.status !== 'processing' || current.revision !== processing.revision) return current;
    if(!sameFrozenRun(processing, current)) {
      return (await persistFailure(jobId, 'STALE_RESULT', options.store, options.clock, options.runnerGeneration)).record;
    }
    if(options.clock.nowMs() >= Date.parse(current.deadlineAt)) {
      const timedOut = await persistFailure(jobId, 'LAB_RUN_TIMEOUT', options.store, options.clock, options.runnerGeneration);
      controller.abort();
      return timedOut.record;
    }
    const commitGuard = await raceStage(getFencedExecutionGuard(current, options.guardProvider, options.store));
    if(commitGuard.kind === 'terminal') return commitGuard.record;
    if(commitGuard.kind === 'error') {
      return (await persistFailure(jobId, errorCode(commitGuard.error, 'LAB_GUARD_UNAVAILABLE'), options.store, options.clock, options.runnerGeneration)).record;
    }
    const result = outcome.result;
    const status = result.workflowStatus;
    return options.store.withRootExclusive(() => options.store.withJobExclusive(jobId, async () => {
      const latest = await options.store.get(jobId);
      if(!latest) fail('LAB_JOB_NOT_FOUND');
      if(latest.status !== 'processing' || latest.revision !== processing.revision) return latest;
      if(!sameFrozenRun(processing, latest)) fail('LAB_STORE_CORRUPT');
      if(options.clock.nowMs() >= Date.parse(latest.deadlineAt)) {
        const timedOut = await persistFailure(jobId, 'LAB_RUN_TIMEOUT', options.store, options.clock, options.runnerGeneration);
        controller.abort();
        return timedOut.record;
      }
      const privacyCode = privacyFailureCode(await listEffectiveLabPrivacyEvents(latest, options.store));
      if(privacyCode) {
        const fenced = await persistFailure(jobId, privacyCode, options.store, options.clock, options.runnerGeneration);
        controller.abort();
        return fenced.record;
      }
      const at = laterIso(latest.updatedAt, nowIso(options.clock));
      const committed = await options.store.compareAndSetTrusted(jobId, latest.revision, value => ({
        ...value,
        status,
        updatedAt: at,
        finishedAt: at,
        result,
        resultDigest: computeLabResultDigest(result),
        metrics: outcome.metrics,
        transitions: [...value.transitions, {
          from: 'processing',
          to: status,
          reason: status === 'needs_review' ? 'LAB_RUN_NEEDS_REVIEW' : 'LAB_RUN_SUCCEEDED',
          at,
          revision: value.revision + 1,
          runnerGeneration: options.runnerGeneration
        }]
      }));
      return committed.record;
    }));
  } finally {
    if(timeoutHandle !== undefined) options.clock.clearTimeout(timeoutHandle);
    if(controllerRegistry.get(key) === controller) controllerRegistry.delete(key);
  }
}

export async function cancelLabExecutionJob(
  jobId: string,
  options: { store: FileClassificationLabV2Store; clock: LabClock; reason?: 'user' }
): Promise<LabJobRecordV2> {
  const current = await options.store.get(jobId);
  if(!current) fail('LAB_JOB_NOT_FOUND');
  if(terminalStatuses.has(current.status)) fail('LAB_JOB_ALREADY_TERMINAL');
  const persisted = await persistFailure(jobId, 'CANCELLED', options.store, options.clock);
  if(!persisted.written) fail('LAB_JOB_ALREADY_TERMINAL');
  controllerRegistry.get(await controllerKey(options.store, jobId))?.abort();
  return persisted.record;
}

function redactedShell(job: LabJobRecordV2): LabRedactedJobShell {
  return LabRedactedJobShellSchema.parse({
    version: LAB_JOB_VERSION_V2,
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.error ? { error: { code: job.error.code } } : {}),
    redacted: true
  });
}

function productGuard(
  job: LabJobRecordV2,
  raw: TrustedLabGuardSnapshot,
  requiredPurpose: LabPurpose
): TrustedLabGuardSnapshot {
  if(job.authorization.state !== 'active') fail('AUTHORIZATION_REVOKED');
  return validateLiveGuard(job, raw, requiredPurpose, false);
}

function matchesPrivacyEventForGuard(
  guard: TrustedLabGuardSnapshot,
  event: TrustedPrivacyControlEvent
): boolean {
  if(guard.authorityRef !== event.authorityRef
    || guard.authorizationRevision !== event.authorizationRevision
    || !equal(guard.scope, event.scope)) return false;
  if(event.kind === 'authorization_revoked') return true;
  const evidence = new Set(guard.evidence.map(value => value.evidenceId));
  return event.evidenceIds.some(value => evidence.has(value));
}

export async function listEffectiveLabPrivacyEvents(
  job: LabJobRecordV2,
  store: FileClassificationLabV2Store
): Promise<TrustedPrivacyControlEvent[]> {
  const events = new Map<string, TrustedPrivacyControlEvent>();
  for(const event of [...await store.listPrivacyEvents(), ...job.privacyEvents]) {
    if(!matchesPrivacyEvent(job, event)) continue;
    const existing = events.get(event.eventId);
    if(existing && !equal(existing, event)) fail('LAB_PRIVACY_EVENT_ID_CONFLICT');
    events.set(event.eventId, event);
  }
  return [...events.values()];
}

function productEvidence(record: LabJobRecordV2['envelope']['evidence'][number]): unknown {
  if(record.lifecycleState === 'deleted') fail('INACTIVE_EVIDENCE');
  const common = {
    evidenceId: record.evidenceId,
    subjectId: record.subjectId,
    householdId: record.householdId,
    schemaVersion: record.schemaVersion,
    ownerId: record.ownerId,
    contributorId: record.contributorId,
    ...(record.circleId ? { circleId: record.circleId } : {}),
    consentRef: record.consentRef,
    visibility: record.visibility,
    ...(record.visibilityAuthorityRef ? { visibilityAuthorityRef: record.visibilityAuthorityRef } : {}),
    ingestedAt: record.ingestedAt,
    ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
    lifecycleState: record.lifecycleState,
    sourceRef: { kind: record.sourceRef.kind, id: record.sourceRef.id },
    sourceHash: record.sourceHash,
    revision: record.revision,
    byteLength: record.byteLength,
    modality: record.modality,
    mimeType: record.mimeType
  };
  if(record.modality === 'image') {
    return { ...common, dimensions: { width: record.dimensions.width, height: record.dimensions.height } };
  }
  if(record.modality === 'transcript') {
    return {
      ...common,
      asr: {
        final: true as const,
        producerVersion: record.asr.producerVersion,
        ...(record.asr.confidence !== undefined ? { confidence: record.asr.confidence } : {})
      }
    };
  }
  return common;
}

function productEnvelope(
  job: LabJobRecordV2,
  allowedEvidenceIds: Set<string>,
  allowedContentIds: Set<string>
): unknown {
  const value = job.envelope;
  return {
    specVersion: value.specVersion,
    contractVersion: value.contractVersion,
    ingestionId: value.ingestionId,
    batchId: value.batchId,
    scope: { householdId: value.scope.householdId, subjectId: value.scope.subjectId },
    actorId: value.actorId,
    context: value.context.kind === 'album_upload'
      ? { kind: 'album_upload' as const }
      : {
          kind: 'family_transfer' as const,
          senderId: value.context.senderId,
          recipientIds: [...(value.context.recipientIds ?? [])]
        },
    authorizationRevision: value.authorizationRevision,
    taxonomyVersion: value.taxonomyVersion,
    purposes: [...value.purposes],
    evidence: value.evidence.filter(item => allowedEvidenceIds.has(item.evidenceId)).map(productEvidence),
    contents: value.contents.filter(item => allowedContentIds.has(item.contentId)).map(item => ({
      contentId: item.contentId,
      evidenceId: item.evidenceId,
      modality: item.modality,
      lifecycleState: item.lifecycleState
    })),
    bindings: value.bindings.filter(binding =>
      allowedContentIds.has(binding.sourceContentId)
      && binding.evidenceRefs.every(id => allowedEvidenceIds.has(id))
      && (binding.target.kind === 'batch' || binding.target.contentIds.every(id => allowedContentIds.has(id)))
    ).map(binding => ({
      bindingId: binding.bindingId,
      sourceContentId: binding.sourceContentId,
      target: binding.target.kind === 'batch'
        ? { kind: 'batch' as const }
        : { kind: 'contents' as const, contentIds: [...binding.target.contentIds] },
      authority: binding.authority,
      state: binding.state,
      method: binding.method,
      evidenceRefs: [...binding.evidenceRefs],
      createdAt: binding.createdAt
    })),
    ...(value.reviewPolicy ? { reviewPolicy: {
      policyVersion: value.reviewPolicy.policyVersion,
      remindAfterDays: value.reviewPolicy.remindAfterDays,
      hideFromHomeAfterDays: value.reviewPolicy.hideFromHomeAfterDays,
      highRiskRetention: value.reviewPolicy.highRiskRetention
    } } : {}),
    createdAt: value.createdAt
  };
}

export async function getLabProductJobView(
  jobId: string,
  options: {
    store: FileClassificationLabV2Store;
    guardProvider: TrustedLabGuardProvider;
    requiredPurpose: LabPurpose;
  }
): Promise<LabProductJobView | LabRedactedJobShell> {
  const initial = await options.store.get(jobId);
  if(!initial) fail('LAB_JOB_NOT_FOUND');
  let guard: TrustedLabGuardSnapshot;
  try { guard = productGuard(initial, await options.guardProvider.get(jobId), options.requiredPurpose); }
  catch { return redactedShell(initial); }
  return options.store.withRootExclusive(() => options.store.withJobExclusive(jobId, async () => {
    const job = await options.store.get(jobId);
    if(!job) fail('LAB_JOB_NOT_FOUND');
    let privacyEvents: TrustedPrivacyControlEvent[];
    try {
      privacyEvents = await listEffectiveLabPrivacyEvents(job, options.store);
      guard = productGuard(job, guard, options.requiredPurpose);
    } catch { return redactedShell(job); }
    if(privacyEvents.some(event => event.kind === 'authorization_revoked')) return redactedShell(job);
    const durablyDeleted = new Set(privacyEvents.flatMap(event => event.kind === 'evidence_deleted' ? event.evidenceIds : []));
    const allowedEvidenceIds = new Set(guard.evidence
      .filter(value => value.lifecycleState === 'active' && !durablyDeleted.has(value.evidenceId))
      .map(value => value.evidenceId));
    if(!allowedEvidenceIds.size) return redactedShell(job);
    const allowedContentIds = new Set(job.envelope.contents
      .filter(value => allowedEvidenceIds.has(value.evidenceId))
      .map(value => value.contentId));
    const envelope = productEnvelope(job, allowedEvidenceIds, allowedContentIds);
    const partial = allowedEvidenceIds.size !== job.envelope.evidence.length;
    // Story facets/title/summary do not yet carry field-level provenance. On a
    // partial delete the only safe projection is to suppress the derived result
    // until E3c reprocesses the remaining Evidence.
    const result = partial ? undefined : job.result;
    try {
      return LabProductJobViewSchema.parse({
        version: LAB_JOB_VERSION_V2,
        revision: job.revision,
        jobId: job.jobId,
        runId: job.runId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        authorizationState: job.authorization.state,
        envelope,
        originalTextByEvidenceId: Object.fromEntries(Object.entries(job.originalTextByEvidenceId)
          .filter(([evidenceId]) => allowedEvidenceIds.has(evidenceId))),
        assetRefs: job.assetRefs.filter(value => allowedEvidenceIds.has(value.evidenceId)),
        ...(result ? { result } : {}),
        ...(job.metrics ? { metrics: job.metrics } : {}),
        ...(job.error ? { error: { code: job.error.code } } : {}),
        actionCount: job.actions.length,
        redacted: false
      });
    } catch {
      return redactedShell(job);
    }
  }));
}

export async function listLabProductJobViews(options: {
  store: FileClassificationLabV2Store;
  guardProvider: TrustedLabGuardProvider;
  requiredPurpose: LabPurpose;
  limit?: number;
}): Promise<Array<LabProductJobView | LabRedactedJobShell>> {
  const records = await options.store.list(options.limit ?? 20);
  return Promise.all(records.map(record => getLabProductJobView(record.jobId, options)));
}

export async function readLabProductAsset(
  jobId: string,
  evidenceId: string,
  options: {
    store: FileClassificationLabV2Store;
    guardProvider: TrustedLabGuardProvider;
    requiredPurpose: LabPurpose;
  }
): Promise<{ bytes: Buffer; ref: LabJobRecordV2['assetRefs'][number] }> {
  const initial = await options.store.get(jobId);
  if(!initial) fail('LAB_JOB_NOT_FOUND');
  let guard: TrustedLabGuardSnapshot;
  try { guard = productGuard(initial, await options.guardProvider.get(jobId), options.requiredPurpose); }
  catch(error) { fail(errorCode(error, 'NOT_AUTHORIZED')); }
  return options.store.withRootExclusive(() => options.store.withJobExclusive(jobId, async () => {
    const job = await options.store.get(jobId);
    if(!job) fail('LAB_JOB_NOT_FOUND');
    guard = productGuard(job, guard, options.requiredPurpose);
    const privacyEvents = await listEffectiveLabPrivacyEvents(job, options.store);
    if(privacyEvents.some(event => event.kind === 'authorization_revoked'
      || (event.kind === 'evidence_deleted' && event.evidenceIds.includes(evidenceId)))) fail('INACTIVE_EVIDENCE');
    const evidence = guard.evidence.find(value => value.evidenceId === evidenceId);
    if(!evidence || evidence.lifecycleState !== 'active') fail('INACTIVE_EVIDENCE');
    return options.store.readAsset(jobId, evidenceId);
  }));
}

function matchesPrivacyEvent(job: LabJobRecordV2, event: TrustedPrivacyControlEvent): boolean {
  if(job.authorization.authorityRef !== event.authorityRef
    || job.authorization.authorizationRevision !== event.authorizationRevision
    || !equal(job.envelope.scope, event.scope)) return false;
  if(event.kind === 'authorization_revoked') return true;
  const evidence = new Set(job.envelope.evidence.map(value => value.evidenceId));
  return event.evidenceIds.some(value => evidence.has(value));
}

async function verifyPrivacyEvent(
  event: TrustedPrivacyControlEvent,
  target: LabJobRecordV2,
  provider: TrustedLabGuardProvider
): Promise<void> {
  let guard: TrustedLabGuardSnapshot;
  try { guard = parseTrustedLabGuardSnapshot(await provider.get(target.jobId)); }
  catch { fail('LAB_PRIVACY_EVENT_UNVERIFIED'); }
  if(guard.guardDigest !== event.guardDigest
    || guard.authorityRef !== event.authorityRef
    || guard.authorizationRevision !== event.authorizationRevision
    || !equal(guard.scope, event.scope)) fail('LAB_PRIVACY_EVENT_UNVERIFIED');
  if(event.kind === 'authorization_revoked') {
    if(guard.active) fail('LAB_PRIVACY_EVENT_UNVERIFIED');
    return;
  }
  const state = new Map(guard.evidence.map(value => [value.evidenceId, value.lifecycleState]));
  if(event.evidenceIds.some(evidenceId => state.get(evidenceId) !== 'deleted')) {
    fail('LAB_PRIVACY_EVENT_UNVERIFIED');
  }
}

export async function applyTrustedPrivacyEvent(
  raw: TrustedPrivacyControlEvent,
  options: {
    store: FileClassificationLabV2Store;
    guardProvider: TrustedLabGuardProvider;
    clock: LabClock;
  }
): Promise<{ matched: number; updated: number }> {
  const event = TrustedPrivacyControlEventSchema.parse(raw);
  return options.store.withRootExclusive(async () => {
    const existingLedgerEvent = (await options.store.listPrivacyEvents())
      .find(value => value.eventId === event.eventId);
    if(existingLedgerEvent && !equal(existingLedgerEvent, event)) fail('LAB_PRIVACY_EVENT_ID_CONFLICT');
    const records: LabJobRecordV2[] = [];
    for await (const entry of options.store.scanAll()) if(entry.kind === 'record') records.push(entry.record);
    const targets = records.filter(job => matchesPrivacyEvent(job, event));
    if(!targets.length) fail('LAB_PRIVACY_EVENT_UNVERIFIED');
    if(!existingLedgerEvent) await verifyPrivacyEvent(event, targets[0], options.guardProvider);
    await options.store.recordVerifiedPrivacyEvent(event);
    let updated = 0;
    for(const original of targets) {
      let current = await options.store.get(original.jobId);
      while(current) {
        const existing = current.privacyEvents.find(value => value.eventId === event.eventId);
        if(existing) {
          if(!equal(existing, event)) fail('LAB_PRIVACY_EVENT_ID_CONFLICT');
          break;
        }
        const active = !terminalStatuses.has(current.status);
        const effectiveAt = laterIso(current.updatedAt, event.occurredAt);
        const code = event.kind === 'authorization_revoked' ? 'AUTHORIZATION_REVOKED' : 'EVIDENCE_CHANGED';
        const status = active ? 'cancelled' as const : current.status;
        const cas = await options.store.compareAndSetTrusted(current.jobId, current.revision, value => ({
          ...value,
          status,
          updatedAt: effectiveAt,
          ...(active ? {
            finishedAt: effectiveAt,
            termination: {
              requestedAt: event.occurredAt,
              reason: event.kind === 'authorization_revoked' ? 'authorization_revoked' as const : 'evidence_changed' as const
            },
            error: { code, retryable: false },
            transitions: [...value.transitions, {
              from: value.status,
              to: 'cancelled' as const,
              reason: code,
              at: effectiveAt,
              revision: value.revision + 1
            }]
          } : {}),
          authorization: event.kind === 'authorization_revoked'
            ? { ...value.authorization, state: 'revoked' as const, revokedAt: event.occurredAt }
            : value.authorization,
          privacyEvents: [...value.privacyEvents, event]
        }));
        if(cas.ok) {
          updated++;
          if(active) controllerRegistry.get(await controllerKey(options.store, current.jobId))?.abort();
          break;
        }
        current = cas.record;
      }
    }
    return { matched: targets.length, updated };
  });
}

export async function recoverInterruptedLabJobs(options: {
  store: FileClassificationLabV2Store;
  guardProvider: TrustedLabGuardProvider;
  clock: LabClock;
  runnerGeneration: string;
}): Promise<{
  scanned: number;
  pending: number;
  interrupted: number;
  reconciled: number;
  corrupt: number;
  privacyEventsReplayed: number;
  orphanTempsRemoved: number;
  orphanTempsCorrupt: number;
  executorCalls: 0;
}> {
  const cleanup = await options.store.cleanupOrphanPending();
  const report = {
    scanned: 0,
    pending: 0,
    interrupted: 0,
    reconciled: 0,
    corrupt: 0,
    privacyEventsReplayed: 0,
    orphanTempsRemoved: cleanup.removed,
    orphanTempsCorrupt: cleanup.corrupt,
    executorCalls: 0 as const
  };
  for(const event of await options.store.listPrivacyEvents()) {
    const replay = await applyTrustedPrivacyEvent(event, {
      store: options.store,
      guardProvider: options.guardProvider,
      clock: options.clock
    });
    report.privacyEventsReplayed += replay.updated;
  }
  for await (const entry of options.store.scanAll()) {
    report.scanned++;
    if(entry.kind === 'corrupt') { report.corrupt++; continue; }
    let job = entry.record;
    if(terminalStatuses.has(job.status)) continue;
    try { await getFencedExecutionGuard(job, options.guardProvider, options.store); }
    catch(error) {
      const code = errorCode(error, 'LAB_GUARD_UNAVAILABLE');
      if(code !== 'LAB_GUARD_UNAVAILABLE' || job.status === 'processing') {
        const reconciled = await persistFailure(job.jobId, code, options.store, options.clock, options.runnerGeneration);
        if(terminalStatuses.has(reconciled.record.status)) report.reconciled++;
      }
      continue;
    }
    job = (await options.store.get(job.jobId)) ?? job;
    if(job.status === 'pending') { report.pending++; continue; }
    if(job.status === 'processing' && job.processingOwner?.runnerGeneration !== options.runnerGeneration) {
      const interrupted = await persistFailure(job.jobId, 'LAB_RUN_INTERRUPTED', options.store, options.clock, options.runnerGeneration);
      if(interrupted.record.error?.code === 'LAB_RUN_INTERRUPTED') report.interrupted++;
    }
  }
  return report;
}
