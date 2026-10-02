import {
  buildTrustedLabGuardSnapshot,
  type LabBudgetPolicy,
  type LabExecutionProfile,
  type LabProductJobView,
  type LabRedactedJobShell,
  type SemanticContextV1
} from './lab-execution-contract';
import { FileClassificationLabV2Store } from './lab-execution-store';
import { FileTrustedLabGuardStore } from './lab-execution-guard-store';
import {
  cancelLabExecutionJob,
  getLabProductJobView,
  listLabProductJobViews,
  runPendingLabExecutionJob,
  submitLabExecutionJob,
  type LabClock
} from './lab-execution';
import {
  StageALabExecutorFactory,
  stageALabProviderVersion,
  type StageALabProviderMode
} from './lab-stage-a-executor';
import {
  computePlaceKindPolicyDigest,
  STAGE_A_LAB_COMPOSITION_VERSION
} from './lab-stage-a-composition';
import { buildLabSubmission, type LabSubmission } from './lab-contract';
import {
  PROMPT_VERSION,
  digest,
  type Correction,
  type Reference
} from './stage-a-contract';
import type { Transport } from './stage-a-provider';

export const CLASSIFICATION_LAB_V2_RUNTIME_VERSION = 'classification-lab-v2-runtime.1';
export const CLASSIFICATION_LAB_V2_MOCK_MODEL = 'sgx-stage-a-local-mock.1';

export interface ClassificationLabV2RuntimeOptions {
  dataRoot?: string;
  providerMode?: StageALabProviderMode;
  provider?: 'qwen' | 'glm';
  model?: string;
  inputCnyPerMillion?: number;
  outputCnyPerMillion?: number;
  transport?: Transport;
  credential?: () => string;
  recordProviderResponse?: ConstructorParameters<typeof StageALabExecutorFactory>[0]['recordProviderResponse'];
  clock?: LabClock;
}

export interface ClassificationLabV2PersonMatchingAuthorization {
  enabled: true;
  /** One explicit consent reference per uploaded image, in upload order. */
  personConsentRefsByImageIndex: readonly string[];
  /** Confirmed references only. Model-generated names or relationships are not accepted here. */
  references?: readonly Reference[];
  corrections?: readonly Correction[];
}

export interface ClassificationLabV2Capabilities {
  version: typeof CLASSIFICATION_LAB_V2_RUNTIME_VERSION;
  asyncExecution: true;
  providerMode: StageALabProviderMode;
  personMatching: 'consent_gated';
  automaticRetries: 0;
  maxImages: 20;
}

function localClock(): LabClock {
  return {
    nowMs: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
}

function localDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms));
}

function mockTransport(model: string): Transport {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ content: unknown }>;
    };
    const user = body.messages[1]?.content;
    if(!Array.isArray(user) || typeof user[0] !== 'object' || user[0] === null || !('text' in user[0])) {
      return new Response('{}', { status: 500 });
    }
    const call = JSON.parse(String((user[0] as { text: unknown }).text)) as {
      stage: 'extract' | 'relate';
      untrustedContext: {
        requestedPhotoIds?: string[];
        requestedPairs?: string[][];
      };
    };
    const value = call.stage === 'extract'
      ? {
        observations: (call.untrustedContext.requestedPhotoIds ?? []).map(photoId => ({
          photoId,
          people: [],
          mentions: [],
          times: [],
          places: [],
          events: [],
          scenes: [],
          unknownFacets: ['person', 'time', 'place', 'event', 'scene'],
          conflicts: []
        }))
      }
      : {
        relations: (call.untrustedContext.requestedPairs ?? []).map(([left, right]) => ({
          kind: 'event',
          left: { photoId: left },
          right: { photoId: right },
          decision: 'unknown',
          supports: [left, right].map(photoId => ({
            photoId,
            source: 'visual',
            quote: '本地 mock 未形成同一事件证据'
          })),
          rationale: '本地 mock 仅验证集成契约，不判断真实语义'
        }))
      };
    return new Response(JSON.stringify({
      id: `local_mock_${Date.now()}`,
      model,
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }]
    }), { status: 200 });
  };
}

function trustedGuard(
  built: ReturnType<typeof buildLabSubmission>,
  personMatching?: ClassificationLabV2PersonMatchingAuthorization
) {
  const imageEvidenceIds = built.envelope.contents
    .filter(item => item.lifecycleState === 'active' && item.modality === 'image')
    .map(item => item.evidenceId);
  if(personMatching && (personMatching.personConsentRefsByImageIndex.length !== imageEvidenceIds.length
    || personMatching.personConsentRefsByImageIndex.some(value => !value))) {
    throw new Error('PERSON_CONSENT_MISSING');
  }
  const personConsentByEvidenceId = new Map(imageEvidenceIds.map((evidenceId, index) => [
    evidenceId,
    personMatching?.personConsentRefsByImageIndex[index]
  ]));
  const references = personMatching?.references ? [...personMatching.references] : [];
  const corrections = personMatching?.corrections ? [...personMatching.corrections] : [];
  return buildTrustedLabGuardSnapshot({
    scope: built.envelope.scope,
    actorId: built.envelope.actorId,
    authorityRef: 'classification_lab_local_authority',
    purposes: ['classification', 'album_organization', 'search_candidate', 'interview_candidate'],
    authorizationRevision: built.envelope.authorizationRevision,
    contextRevision: `classification_lab_context_${built.idempotencyKey.slice(7, 31)}`,
    active: true,
    allowedConsentRefs: [...new Set(built.envelope.evidence
      .filter((item): item is Exclude<typeof item, { lifecycleState: 'deleted' }> => item.lifecycleState === 'active')
      .map(item => item.consentRef))].sort(),
    allowedCorrectionIds: corrections.map(item => item.correctionId),
    allowPersonMatching: Boolean(personMatching),
    ...(personMatching ? {
      personMatchingEvidenceIds: imageEvidenceIds,
      personReferences: references,
      personCorrections: corrections
    } : {}),
    evidence: built.envelope.evidence
      .filter((item): item is Exclude<typeof item, { lifecycleState: 'deleted' }> => item.lifecycleState === 'active')
      .map(item => ({
      evidenceId: item.evidenceId,
      revision: item.revision,
      sourceHash: item.sourceHash,
      consentRef: item.consentRef,
      ...(personConsentByEvidenceId.get(item.evidenceId)
        ? { personConsentRef: personConsentByEvidenceId.get(item.evidenceId)! }
        : {}),
      lifecycleState: 'active' as const
    })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
  });
}

export class ClassificationLabV2Runtime {
  readonly store: FileClassificationLabV2Store;
  readonly guardStore: FileTrustedLabGuardStore;
  readonly clock: LabClock;
  readonly providerMode: StageALabProviderMode;
  readonly provider: 'qwen' | 'glm';
  readonly model: string;
  private readonly transport?: Transport;
  private readonly credential?: () => string;
  private readonly inputCnyPerMillion: number;
  private readonly outputCnyPerMillion: number;
  private readonly recordProviderResponse?: ClassificationLabV2RuntimeOptions['recordProviderResponse'];
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: ClassificationLabV2RuntimeOptions = {}) {
    this.store = new FileClassificationLabV2Store(options.dataRoot);
    this.guardStore = new FileTrustedLabGuardStore(options.dataRoot);
    this.clock = options.clock ?? localClock();
    this.providerMode = options.providerMode ?? 'stage_a_mock';
    this.provider = options.provider ?? 'qwen';
    this.model = options.model ?? (this.providerMode === 'stage_a_mock'
      ? CLASSIFICATION_LAB_V2_MOCK_MODEL
      : process.env.CLASSIFICATION_LAB_REAL_MODEL ?? 'qwen3.7-flash-2026-07-15');
    this.inputCnyPerMillion = options.inputCnyPerMillion ?? (this.providerMode === 'stage_a_mock' ? 0 : 1.2);
    this.outputCnyPerMillion = options.outputCnyPerMillion ?? (this.providerMode === 'stage_a_mock' ? 0 : 4.8);
    this.transport = options.transport ?? (this.providerMode === 'stage_a_mock' ? mockTransport(this.model) : undefined);
    this.credential = options.credential;
    this.recordProviderResponse = options.recordProviderResponse;
    if(this.providerMode === 'stage_a_real' && !this.credential) throw new Error('MODEL_NOT_CONFIGURED');
  }

  capabilities(): ClassificationLabV2Capabilities {
    return {
      version: CLASSIFICATION_LAB_V2_RUNTIME_VERSION,
      asyncExecution: true,
      providerMode: this.providerMode,
      personMatching: 'consent_gated',
      automaticRetries: 0,
      maxImages: 20
    };
  }

  private placePolicy(taxonomyVersion: string) {
    return {
      policyVersion: 'classification-place-kind.1',
      taxonomyVersion,
      genericLabels: ['家中', '室内', '户外']
    };
  }

  private profile(taxonomyVersion: string): LabExecutionProfile {
    const placeKindPolicy = this.placePolicy(taxonomyVersion);
    return {
      providerMode: this.providerMode,
      providerVersion: stageALabProviderVersion(this.provider, this.model),
      modelVersion: this.model,
      promptVersion: PROMPT_VERSION,
      guardVersion: 'classification-lab-guard.1',
      adapterVersion: STAGE_A_LAB_COMPOSITION_VERSION,
      taxonomyVersion,
      placeKindPolicyDigest: computePlaceKindPolicyDigest(placeKindPolicy),
      scorerVersion: 'classification-semantic-score.2',
      configDigest: digest({
        version: CLASSIFICATION_LAB_V2_RUNTIME_VERSION,
        providerMode: this.providerMode,
        provider: this.provider,
        model: this.model,
        inputCnyPerMillion: this.inputCnyPerMillion,
        outputCnyPerMillion: this.outputCnyPerMillion,
        placeKindPolicy
      }) as `sha256:${string}`
    };
  }

  private factory(profile: LabExecutionProfile): StageALabExecutorFactory {
    return new StageALabExecutorFactory({
      profile,
      provider: this.provider,
      model: this.model,
      inputCnyPerMillion: this.inputCnyPerMillion,
      outputCnyPerMillion: this.outputCnyPerMillion,
      placeKindPolicy: this.placePolicy(profile.taxonomyVersion),
      ...(this.transport ? { transport: this.transport } : {}),
      ...(this.credential ? { credential: this.credential } : {}),
      ...(this.recordProviderResponse ? { recordProviderResponse: this.recordProviderResponse } : {})
    });
  }

  private budget(): LabBudgetPolicy {
    return {
      maxRequests: this.providerMode === 'stage_a_mock' ? 100 : 1,
      maxInputTokens: 200_000,
      maxOutputTokens: 8192,
      maxCostCny: this.providerMode === 'stage_a_mock' ? 0 : 0.25,
      maxCandidatesPerContent: 8,
      maxCallDurationMs: 60_000
    };
  }

  private semanticContext(): SemanticContextV1 {
    return {
      version: 'classification-lab-semantic-context.1',
      referenceDate: localDate(this.clock.nowMs()),
      timeZone: 'Asia/Shanghai',
      relativeTimePolicyVersion: 'relative-time.1'
    };
  }

  private schedule(jobId: string): void {
    if(this.inFlight.has(jobId)) return;
    const task = new Promise<void>(resolve => {
      this.clock.setTimeout(() => {
        void this.run(jobId).then(() => resolve(), () => resolve());
      }, 0);
    }).finally(() => { this.inFlight.delete(jobId); });
    this.inFlight.set(jobId, task);
  }

  private async run(jobId: string): Promise<void> {
    const record = await this.store.get(jobId);
    if(!record || record.status !== 'pending') return;
    await runPendingLabExecutionJob(jobId, {
      store: this.store,
      factory: this.factory(record.executionProfile),
      guardProvider: this.guardStore,
      clock: this.clock,
      runnerGeneration: 'classification_lab_v2_local_runner'
    });
  }

  async submit(
    submission: LabSubmission,
    personMatching?: ClassificationLabV2PersonMatchingAuthorization
  ): Promise<LabProductJobView | LabRedactedJobShell> {
    const built = buildLabSubmission(submission);
    if(this.providerMode === 'stage_a_real' && built.envelope.contents.filter(item => item.modality === 'image').length !== 1) {
      throw new Error('REAL_SMOKE_ONE_IMAGE_REQUIRED');
    }
    const guard = trustedGuard(built, personMatching);
    const record = await submitLabExecutionJob({
      built,
      profile: this.profile(built.envelope.taxonomyVersion),
      guard,
      semanticContext: this.semanticContext(),
      budgetPolicy: this.budget(),
      attemptRevision: 1,
      deadlineAt: new Date(this.clock.nowMs() + 65_000).toISOString()
    }, this.store, this.clock);
    await this.guardStore.put(record.jobId, guard);
    this.schedule(record.jobId);
    return (await this.get(record.jobId))!;
  }

  async get(jobId: string): Promise<LabProductJobView | LabRedactedJobShell | undefined> {
    if(!await this.store.get(jobId)) return undefined;
    return getLabProductJobView(jobId, {
      store: this.store,
      guardProvider: this.guardStore,
      requiredPurpose: 'classification'
    });
  }

  async list(limit = 20): Promise<Array<LabProductJobView | LabRedactedJobShell>> {
    return listLabProductJobViews({
      store: this.store,
      guardProvider: this.guardStore,
      requiredPurpose: 'classification',
      limit
    });
  }

  async cancel(jobId: string): Promise<LabProductJobView | LabRedactedJobShell> {
    await cancelLabExecutionJob(jobId, { store: this.store, clock: this.clock });
    return (await this.get(jobId))!;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __sgxClassificationLabV2Runtime: ClassificationLabV2Runtime | undefined;
}

export function localClassificationLabV2Runtime(): ClassificationLabV2Runtime {
  if(!globalThis.__sgxClassificationLabV2Runtime) {
    const mode = process.env.CLASSIFICATION_LAB_V2_PROVIDER_MODE === 'stage_a_real'
      ? 'stage_a_real' as const
      : 'stage_a_mock' as const;
    globalThis.__sgxClassificationLabV2Runtime = new ClassificationLabV2Runtime({
      providerMode: mode,
      ...(mode === 'stage_a_real' ? {
        credential: () => {
          const value = process.env.SGX_D4_API_KEY;
          if(!value) throw new Error('MODEL_NOT_CONFIGURED');
          return value;
        }
      } : {})
    });
  }
  return globalThis.__sgxClassificationLabV2Runtime;
}
