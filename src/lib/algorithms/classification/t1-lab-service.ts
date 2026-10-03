import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildTrustedLabGuardSnapshot,
  type LabBudgetPolicy,
  type LabExecutionProfile,
  type LabProductJobView,
  type LabRedactedJobShell,
  type SemanticContextV1,
} from './lab-execution-contract';
import { FileTrustedLabGuardStore } from './lab-execution-guard-store';
import { FileClassificationLabV2Store } from './lab-execution-store';
import {
  getLabProductJobView,
  listLabProductJobViews,
  submitLabExecutionJob,
} from './lab-execution';
import { buildLabSubmission, type LabSubmission } from './lab-contract';
import {
  computePlaceKindPolicyDigest,
  STAGE_A_LAB_COMPOSITION_VERSION,
} from './lab-stage-a-composition';
import { stageALabProviderVersion } from './lab-stage-a-executor';
import { PROMPT_VERSION, digest } from './stage-a-contract';
import type { EvidenceRecord } from './types';
import {
  FileClassificationT1SessionStore,
  type ClassificationT1Session,
} from './t1-session-store';

export const CLASSIFICATION_T1_LAB_VERSION = 'classification-t1-lab.1' as const;
export const CLASSIFICATION_T1_MAX_IMAGES = 8;
type ActiveImageEvidence = Extract<EvidenceRecord, { modality: 'image' }>;

export interface ClassificationT1SubmitInput {
  sessionId?: string;
  submission: LabSubmission;
  personMatchingAuthorized: boolean;
}

export interface ClassificationT1SubmitResult {
  version: typeof CLASSIFICATION_T1_LAB_VERSION;
  session: ClassificationT1Session;
  round: number;
  job: LabProductJobView | LabRedactedJobShell;
}

export interface ClassificationT1LabConfig {
  dataRoot: string;
  provider: 'qwen' | 'glm';
  model: string;
  inputCnyPerMillion: number;
  outputCnyPerMillion: number;
}

function localDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if(!Number.isFinite(value) || value < 0) throw new Error('T1_LAB_CONFIG_INVALID');
  return value;
}

export function classificationT1LabConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClassificationT1LabConfig {
  const provider = env.SGX_VLM_PROVIDER === 'glm' ? 'glm' as const : 'qwen' as const;
  return {
    dataRoot: path.resolve(env.CLASSIFICATION_LAB_DATA_DIR || path.join(tmpdir(), 'sgx-classification-lab')),
    provider,
    model: env.SGX_VLM_MODEL || env.CLASSIFICATION_LAB_REAL_MODEL || 'qwen3.7-flash-2026-07-15',
    inputCnyPerMillion: positiveNumber(env.SGX_VLM_INPUT_CNY_PER_MILLION, 1.2),
    outputCnyPerMillion: positiveNumber(env.SGX_VLM_OUTPUT_CNY_PER_MILLION, 4.8),
  };
}

function profile(config: ClassificationT1LabConfig, taxonomyVersion: string): LabExecutionProfile {
  const placeKindPolicy = {
    policyVersion: 'classification-place-kind.1',
    taxonomyVersion,
    genericLabels: ['家中', '室内', '户外'],
  };
  return {
    providerMode: 'stage_a_real',
    providerVersion: stageALabProviderVersion(config.provider, config.model),
    modelVersion: config.model,
    promptVersion: PROMPT_VERSION,
    guardVersion: 'classification-lab-guard.1',
    adapterVersion: STAGE_A_LAB_COMPOSITION_VERSION,
    taxonomyVersion,
    placeKindPolicyDigest: computePlaceKindPolicyDigest(placeKindPolicy),
    scorerVersion: 'classification-semantic-score.2',
    configDigest: digest({
      version: CLASSIFICATION_T1_LAB_VERSION,
      provider: config.provider,
      model: config.model,
      inputCnyPerMillion: config.inputCnyPerMillion,
      outputCnyPerMillion: config.outputCnyPerMillion,
      placeKindPolicy,
    }) as `sha256:${string}`,
  };
}

function budget(): LabBudgetPolicy {
  return {
    // Eight extracts plus bounded sparse relation review. This is an execution
    // ceiling, not a request target and never enables automatic retries.
    maxRequests: 40,
    maxInputTokens: 3_000_000,
    maxOutputTokens: 160_000,
    maxCostCny: 5,
    maxCandidatesPerContent: 5,
    maxCallDurationMs: 60_000,
  };
}

function semanticContext(nowMs: number): SemanticContextV1 {
  return {
    version: 'classification-lab-semantic-context.1',
    referenceDate: localDate(nowMs),
    timeZone: 'Asia/Shanghai',
    relativeTimePolicyVersion: 'relative-time.1',
  };
}

function personConsentRef(session: ClassificationT1Session, sourceHash: string): string {
  return `person_consent_${createHash('sha256')
    .update(`${session.sessionId}/${session.authorizationRevision}/${sourceHash}`)
    .digest('hex').slice(0, 24)}`;
}

function isActiveImageEvidence(value: EvidenceRecord): value is ActiveImageEvidence {
  return value.lifecycleState === 'active' && value.modality === 'image';
}

export class ClassificationT1LabService {
  readonly config: ClassificationT1LabConfig;
  readonly store: FileClassificationLabV2Store;
  readonly guardStore: FileTrustedLabGuardStore;
  readonly sessions: FileClassificationT1SessionStore;

  constructor(
    config: ClassificationT1LabConfig = classificationT1LabConfig(),
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.config = config;
    this.store = new FileClassificationLabV2Store(config.dataRoot);
    this.guardStore = new FileTrustedLabGuardStore(config.dataRoot);
    this.sessions = new FileClassificationT1SessionStore(config.dataRoot, nowMs);
  }

  capabilities() {
    return {
      version: CLASSIFICATION_T1_LAB_VERSION,
      providerMode: 'stage_a_real' as const,
      model: this.config.model,
      promptVersion: PROMPT_VERSION,
      execution: 'worker_pull' as const,
      automaticRetries: 0 as const,
      maxImagesPerRound: CLASSIFICATION_T1_MAX_IMAGES,
      personMatching: 'explicit_consent_per_round' as const,
      rawAudio: 'pcm_wav_via_worker_asr_prejob' as const,
    };
  }

  async submit(input: ClassificationT1SubmitInput): Promise<ClassificationT1SubmitResult> {
    if(input.submission.images.length > CLASSIFICATION_T1_MAX_IMAGES) {
      throw new Error('T1_TOO_MANY_IMAGES');
    }
    const session = input.sessionId
      ? await this.sessions.requireActive({
        sessionId: input.sessionId,
        scope: input.submission.scope,
        actorId: input.submission.actorId,
      })
      : await this.sessions.create({
        scope: input.submission.scope,
        actorId: input.submission.actorId,
      });
    const reserved = await this.sessions.reserveRound({
      sessionId: session.sessionId,
      scope: session.scope,
      actorId: session.actorId,
    });
    const built = buildLabSubmission(input.submission, {
      consentRef: reserved.session.consentRef,
      authorizationRevision: reserved.session.authorizationRevision,
    });
    const imageEvidence = built.envelope.evidence.filter(isActiveImageEvidence);
    const consentByEvidence = new Map(imageEvidence.map(value => [
      value.evidenceId,
      personConsentRef(reserved.session, value.sourceHash),
    ]));
    const guard = buildTrustedLabGuardSnapshot({
      scope: built.envelope.scope,
      actorId: built.envelope.actorId,
      authorityRef: `t1_authority_${reserved.session.sessionId}`,
      purposes: ['classification', 'album_organization', 'search_candidate', 'interview_candidate'],
      authorizationRevision: reserved.session.authorizationRevision,
      contextRevision: reserved.session.contextRevision,
      active: true,
      allowedConsentRefs: [...new Set(built.envelope.evidence
        .filter((value): value is Exclude<typeof value, { lifecycleState: 'deleted' }> => value.lifecycleState === 'active')
        .map(value => value.consentRef))].sort(),
      allowedCorrectionIds: [],
      allowPersonMatching: input.personMatchingAuthorized,
      ...(input.personMatchingAuthorized ? {
        personMatchingEvidenceIds: imageEvidence.map(value => value.evidenceId),
      } : {}),
      evidence: built.envelope.evidence
        .filter((value): value is Exclude<typeof value, { lifecycleState: 'deleted' }> => value.lifecycleState === 'active')
        .map(value => ({
          evidenceId: value.evidenceId,
          revision: value.revision,
          sourceHash: value.sourceHash,
          consentRef: value.consentRef,
          ...(input.personMatchingAuthorized && consentByEvidence.has(value.evidenceId)
            ? { personConsentRef: consentByEvidence.get(value.evidenceId)! }
            : {}),
          lifecycleState: 'active' as const,
        }))
        .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    });
    const record = await submitLabExecutionJob({
      built,
      profile: profile(this.config, built.envelope.taxonomyVersion),
      guard,
      semanticContext: semanticContext(this.nowMs()),
      budgetPolicy: budget(),
      attemptRevision: 1,
      deadlineAt: new Date(this.nowMs() + 20 * 60_000).toISOString(),
    }, this.store, {
      nowMs: this.nowMs,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    await this.guardStore.put(record.jobId, guard);
    const job = await this.get(reserved.session.sessionId, record.jobId);
    if(!job) throw new Error('T1_JOB_NOT_FOUND');
    return {
      version: CLASSIFICATION_T1_LAB_VERSION,
      session: reserved.session,
      round: reserved.round,
      job,
    };
  }

  async get(sessionId: string, jobId: string): Promise<LabProductJobView | LabRedactedJobShell | undefined> {
    const session = await this.sessions.get(sessionId);
    if(!session) throw new Error('T1_SESSION_NOT_FOUND');
    const record = await this.store.get(jobId);
    if(!record) return undefined;
    if(record.authorization.authorizationRevision !== session.authorizationRevision
      || record.authorization.actorId !== session.actorId
      || record.envelope.scope.householdId !== session.scope.householdId
      || record.envelope.scope.subjectId !== session.scope.subjectId) {
      throw new Error('T1_SESSION_SCOPE_MISMATCH');
    }
    return getLabProductJobView(jobId, {
      store: this.store,
      guardProvider: this.guardStore,
      requiredPurpose: 'classification',
    });
  }

  async list(sessionId: string, limit = 50): Promise<Array<LabProductJobView | LabRedactedJobShell>> {
    const session = await this.sessions.get(sessionId);
    if(!session) throw new Error('T1_SESSION_NOT_FOUND');
    const views = await listLabProductJobViews({
      store: this.store,
      guardProvider: this.guardStore,
      requiredPurpose: 'classification',
      limit: 100,
    });
    return views.filter(view => (
      'envelope' in view
      && view.envelope.authorizationRevision === session.authorizationRevision
      && view.envelope.actorId === session.actorId
      && view.envelope.scope.householdId === session.scope.householdId
      && view.envelope.scope.subjectId === session.scope.subjectId
    )).slice(0, limit);
  }
}
