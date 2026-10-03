import {
  LabExecutionProfileSchema,
  LAB_EXECUTION_RESULT_VERSION,
  type LabExecutionOutcome,
  type LabExecutionProfile,
  type TrustedLabGuardSnapshot
} from './lab-execution-contract';
import type {
  LabExecutionExecutor,
  LabExecutionExecutorFactory,
  TrustedLabExecutionContext
} from './lab-execution';
import {
  buildStageALabPlan,
  composeStageALabResult,
  computePlaceKindPolicyDigest,
  STAGE_A_LAB_COMPOSITION_VERSION,
  type PlaceKindPolicy
} from './lab-stage-a-composition';
import { organizeSparseContent } from './content-organization';
import { buildCrossRoundAssociations } from './cross-round-association';
import { mergeRetrievalCandidates, retrieveExactCandidates } from './exact-retrieval';
import { DeterministicTextExtractor } from './text-extractor';
import {
  ACTIVE_EVIDENCE_RULE_POLICY_VERSION,
  buildActiveEvidenceRulePolicy,
  collectEvidenceRuleReviewItems
} from './evidence-rule-policy';
import { ApiVisionProvider, PROVIDER_ENDPOINTS, type Transport } from './stage-a-provider';
import { ClassificationEngine, type StageResult } from './stage-a-pipeline';
import {
  PROMPT_VERSION,
  STAGE_A_VALIDATION_VERSION,
  StageError,
  stable,
  type StageDiagnostic
} from './stage-a-contract';

export const STAGE_A_LAB_EXECUTOR_VERSION = 'classification-lab-stage-a-executor.1';
export const STAGE_A_LAB_DECISION_POLICY_VERSION = ACTIVE_EVIDENCE_RULE_POLICY_VERSION;
const STAGE_OUTPUT_VALIDATION_CODES = new Set([
  'CROSS_SCOPE', 'DUPLICATE_CONFLICT', 'DUPLICATE_FACE', 'DUPLICATE_FACET',
  'DUPLICATE_RELATION', 'DUPLICATE_RELATION_PAIR', 'DUPLICATE_STAGE_A_EDGE', 'EVENT_WITH_FACE', 'FACET_COVERAGE',
  'FACE_WITHOUT_VISUAL', 'FOREIGN_PHOTO', 'FOREIGN_SOURCE', 'IDENTITY_WITHOUT_VISUAL',
  'INVALID_RELATION_PAIR', 'INVALID_TIME', 'MENTION_WITHOUT_TEXT',
  'MODEL_RELATION_CONTRADICTION', 'OBSERVATION_COVERAGE',
  'PERSON_MATCHING_NOT_AUTHORIZED', 'RELATION_COVERAGE', 'RELATION_MISSING_SOURCE',
  'SCAN_NOT_CAPTURE', 'SELF_RELATION_PAIR', 'TEXT_SUPPORT_REQUIRES_EVIDENCE',
  'UNKNOWN_FACE', 'UNREQUESTED_PAIR', 'UNSUPPORTED_EXIF', 'UNSUPPORTED_QUOTE',
  'UNSUPPORTED_TIME', 'UNSUPPORTED_TIME_PRECISION'
]);

export type StageALabProviderMode = 'stage_a_mock' | 'stage_a_real';

export interface StageALabExecutorFactoryOptions {
  profile: LabExecutionProfile;
  provider: 'qwen' | 'glm';
  model: string;
  inputCnyPerMillion: number;
  outputCnyPerMillion: number;
  placeKindPolicy: Omit<PlaceKindPolicy, 'policyDigest'>;
  transport?: Transport;
  credential?: () => string;
  recordProviderResponse?: (input: {
    jobId: string;
    runId: string;
    responseId: string;
    model: string;
    raw: unknown;
  }) => void;
}

function clone<T>(value: T): T { return structuredClone(value); }
function equal(left: unknown, right: unknown): boolean { return stable(left) === stable(right); }
type DiagnosableError = Error & { diagnostic?: StageDiagnostic };

function fail(code: string, diagnostic?: StageDiagnostic): never {
  const error: DiagnosableError = new Error(code);
  if(diagnostic) error.diagnostic = clone(diagnostic);
  throw error;
}

export function stageALabProviderVersion(provider: 'qwen' | 'glm', model: string): string {
  return `${provider}:${model}:${PROMPT_VERSION}:${STAGE_A_VALIDATION_VERSION}`;
}

function validateFactoryOptions(options: StageALabExecutorFactoryOptions): LabExecutionProfile {
  const profile = LabExecutionProfileSchema.parse(options.profile);
  if(profile.providerMode !== 'stage_a_mock' && profile.providerMode !== 'stage_a_real') {
    fail('LAB_RUN_IDENTITY_MISMATCH');
  }
  if(!options.model
    || options.model !== profile.modelVersion
    || profile.promptVersion !== PROMPT_VERSION
    || profile.providerVersion !== stageALabProviderVersion(options.provider, options.model)
    || profile.adapterVersion !== STAGE_A_LAB_COMPOSITION_VERSION) {
    fail('LAB_RUN_IDENTITY_MISMATCH');
  }
  const policyDigest = computePlaceKindPolicyDigest(options.placeKindPolicy);
  if(policyDigest !== profile.placeKindPolicyDigest) fail('LAB_RUN_IDENTITY_MISMATCH');
  if(![options.inputCnyPerMillion, options.outputCnyPerMillion]
    .every(value => Number.isFinite(value) && value >= 0)) fail('LAB_RUN_IDENTITY_MISMATCH');
  if(profile.providerMode === 'stage_a_mock' && !options.transport) fail('LAB_PROVIDER_UNAVAILABLE');
  if(profile.providerMode === 'stage_a_mock' && options.credential) fail('LAB_RUN_IDENTITY_MISMATCH');
  if(profile.providerMode === 'stage_a_real' && !options.credential) fail('LAB_PROVIDER_UNAVAILABLE');
  return profile;
}

function authorizationFromGuard(
  context: TrustedLabExecutionContext,
  guard: TrustedLabGuardSnapshot
) {
  return {
    actorId: guard.actorId,
    authorityRef: guard.authorityRef,
    scope: guard.scope,
    authorizationRevision: guard.authorizationRevision,
    contextRevision: guard.contextRevision,
    active: guard.active && context.job.authorization.state === 'active',
    allowedEvidenceIds: guard.evidence
      .filter(item => item.lifecycleState === 'active')
      .map(item => item.evidenceId)
      .sort(),
    allowedConsentRefs: [...guard.allowedConsentRefs].sort(),
    allowedCorrectionIds: [...guard.allowedCorrectionIds].sort(),
    allowPersonMatching: guard.allowPersonMatching,
    personMatchingEvidenceIds: [...(guard.personMatchingEvidenceIds ?? [])].sort(),
    personConsentRefsByEvidenceId: Object.fromEntries(guard.evidence
      .filter(item => item.lifecycleState === 'active' && item.personConsentRef)
      .map(item => [item.evidenceId, item.personConsentRef!])
      .sort(([left], [right]) => left.localeCompare(right)))
  } as const;
}

function mapStageFailure(stage: StageResult): never {
  const first = stage.errors[0];
  const code = first?.code ?? (stage.workflowStatus === 'cancelled' ? 'CANCELLED' : 'LAB_PROVIDER_UNAVAILABLE');
  if(code === 'CANCELLED') fail('CANCELLED');
  if(code === 'AUTHORIZATION_CHANGED' || code === 'CALL_NOT_AUTHORIZED') fail('AUTHORIZATION_CHANGED');
  if(code === 'SOURCE_OR_AUTHORIZATION_CHANGED') fail('EVIDENCE_CHANGED');
  if(code === 'TIMEOUT') fail('LAB_RUN_TIMEOUT');
  if(code === 'INVALID_OUTPUT' || code === 'MODEL_VERSION_MISMATCH' || code === 'MISSING_USAGE_OR_PROVENANCE') {
    fail('INVALID_OUTPUT', first?.diagnostic);
  }
  if(['BUDGET_EXHAUSTED', 'BUDGET_OVERRUN', 'RESERVATION_OVERRUN', 'OUTPUT_TRUNCATED',
    'RESPONSE_LIMIT', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED',
    'MODEL_NOT_CONFIGURED', 'AUTHORIZATION_CHECK_REQUIRED'].includes(code)) fail(code);
  if(STAGE_OUTPUT_VALIDATION_CODES.has(code)) {
    fail('INVALID_OUTPUT', { phase: 'schema', issues: [{ path: '$', code }] });
  }
  fail('LAB_PROVIDER_UNAVAILABLE');
}

function mapThrownError(error: unknown): never {
  const code = error instanceof StageError ? error.code : error instanceof Error ? error.message : '';
  const diagnostic = error instanceof StageError
    ? error.diagnostic
    : (error as DiagnosableError | undefined)?.diagnostic;
  if(code === 'CANCELLED') fail('CANCELLED');
  if(code === 'AUTHORIZATION_REVOKED') fail('AUTHORIZATION_REVOKED');
  if(code === 'AUTHORIZATION_CHANGED' || code === 'CALL_NOT_AUTHORIZED') fail('AUTHORIZATION_CHANGED');
  if(code === 'SOURCE_OR_AUTHORIZATION_CHANGED' || code === 'INACTIVE_EVIDENCE' || code === 'EVIDENCE_CHANGED') {
    fail(code === 'INACTIVE_EVIDENCE' ? 'INACTIVE_EVIDENCE' : 'EVIDENCE_CHANGED');
  }
  if(code === 'TIMEOUT') fail('LAB_RUN_TIMEOUT');
  if(code === 'INVALID_OUTPUT'
    || code === 'MODEL_VERSION_MISMATCH'
    || code === 'MISSING_USAGE_OR_PROVENANCE'
    || (error instanceof Error && error.name === 'ZodError')) {
    fail('INVALID_OUTPUT', diagnostic);
  }
  if(['BUDGET_EXHAUSTED', 'BUDGET_OVERRUN', 'RESERVATION_OVERRUN', 'OUTPUT_TRUNCATED',
    'RESPONSE_LIMIT', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED',
    'MODEL_NOT_CONFIGURED', 'AUTHORIZATION_CHECK_REQUIRED'].includes(code)) fail(code);
  if(STAGE_OUTPUT_VALIDATION_CODES.has(code)) {
    fail('INVALID_OUTPUT', { phase: 'schema', issues: [{ path: '$', code }] });
  }
  if(code === 'LAB_RUN_IDENTITY_MISMATCH') fail(code);
  if(code === 'LAB_RUN_TIMEOUT' || code === 'LAB_PROVIDER_UNAVAILABLE') fail(code);
  fail('LAB_PROVIDER_UNAVAILABLE');
}

class StageALabExecutor implements LabExecutionExecutor {
  readonly profile: LabExecutionProfile;

  constructor(
    profile: LabExecutionProfile,
    private readonly options: StageALabExecutorFactoryOptions
  ) {
    this.profile = clone(profile);
  }

  async execute(context: TrustedLabExecutionContext): Promise<LabExecutionOutcome> {
    try {
      if(context.signal.aborted) fail('CANCELLED');
      const guard = await context.getGuard();
      if(context.signal.aborted) fail('CANCELLED');
      const imageEvidence = context.job.envelope.evidence.filter(item =>
        item.lifecycleState === 'active' && item.modality === 'image');
      const imageBytesByEvidenceId = Object.fromEntries(await Promise.all(imageEvidence.map(async evidence => [
        evidence.evidenceId,
        await context.readAsset(evidence.evidenceId)
      ])));
      if(context.signal.aborted) fail('CANCELLED');

      const maxOutputPerRequest = Math.min(8192, Math.max(256, context.job.budgetPolicy.maxOutputTokens));
      const plan = buildStageALabPlan({
        envelope: context.job.envelope,
        payloads: { textByEvidenceId: clone(context.job.originalTextByEvidenceId) },
        imageBytesByEvidenceId,
        authorization: authorizationFromGuard(context, guard),
        placeKindPolicy: {
          ...this.options.placeKindPolicy,
          policyDigest: computePlaceKindPolicyDigest(this.options.placeKindPolicy)
        },
        runId: context.job.runId,
        trigger: 'upload',
        budget: {
          maxRequests: context.job.budgetPolicy.maxRequests,
          maxInputTokens: context.job.budgetPolicy.maxInputTokens,
          maxOutputTokens: context.job.budgetPolicy.maxOutputTokens,
          maxCostCny: context.job.budgetPolicy.maxCostCny,
          deadlineAt: context.job.deadlineAt,
          candidatesPerPhoto: Math.min(12, context.job.budgetPolicy.maxCandidatesPerContent),
          maxOutputPerRequest,
          stageOutputTokens: {
            extract: maxOutputPerRequest,
            // A consented multi-person pair can require one event edge plus
            // several anonymous face-pair candidates. 1024 tokens truncated a
            // real two-image response before its JSON object closed.
            relate: Math.min(maxOutputPerRequest, 2048)
          },
          maxCallDurationMs: context.job.budgetPolicy.maxCallDurationMs
        },
        createdAt: context.job.envelope.createdAt,
        references: guard.personReferences ?? [],
        corrections: guard.personCorrections ?? [],
        ...(context.derivedFeatures ? {
          derivedOcrTextByEvidenceId: context.derivedFeatures.ocrTextByEvidenceId,
          retrievalHints: [...context.derivedFeatures.retrievalHints]
        } : {})
      });

      let stage: StageResult | undefined;
      if(plan.stageA) {
        const expectedEvidenceStatus = this.profile.providerMode === 'stage_a_real' ? 'real_api' : 'mock_transport';
        const provider = new ApiVisionProvider({
          provider: this.options.provider,
          model: this.options.model,
          resolver: plan.stageA.resolveImage,
          mode: expectedEvidenceStatus,
          ...(this.options.transport ? { transport: this.options.transport } : {}),
          ...(this.options.credential ? { credential: this.options.credential } : {}),
          grant: {
            destination: PROVIDER_ENDPOINTS[this.options.provider],
            model: this.options.model,
            expiresAt: context.job.deadlineAt,
            photoIds: plan.stageA.request.photos.map(photo => photo.photoId)
          },
          inputCnyPerMillion: this.options.inputCnyPerMillion,
          outputCnyPerMillion: this.options.outputCnyPerMillion,
          record: entry => this.options.recordProviderResponse?.({
            jobId: context.job.jobId,
            runId: context.job.runId,
            ...entry
          })
        });
        if(provider.version !== `${this.options.provider}/${this.options.model}/${PROMPT_VERSION}/${STAGE_A_VALIDATION_VERSION}`
          || provider.mode !== expectedEvidenceStatus) {
          fail('LAB_RUN_IDENTITY_MISMATCH');
        }
        stage = await new ClassificationEngine(provider).process(
          plan.stageA.request,
          () => plan.stageA!.authorization,
          context.signal
        );
        if(stage.workflowStatus === 'failed' || stage.workflowStatus === 'cancelled' || !stage.snapshot) {
          mapStageFailure(stage);
        }
        if(stage.evidenceStatus !== expectedEvidenceStatus) fail('INVALID_OUTPUT');
      }

      const textExtractor = new DeterministicTextExtractor();
      const textObservations = plan.baseOrganization.contents.flatMap(content =>
        content.lifecycle === 'active' && (content.modality === 'user_text' || content.modality === 'final_asr')
          ? textExtractor.extract({
            scope: context.job.envelope.scope,
            content,
            taxonomyVersion: context.job.envelope.taxonomyVersion
          }).observations
          : []);
      const composed = composeStageALabResult({
        plan,
        ...(stage ? { stageResult: stage } : {}),
        textObservations,
        createdAt: context.job.envelope.createdAt
      });
      const retrieval = retrieveExactCandidates({
        schemaVersion: '2.0',
        contractVersion: 'classification-hybrid.2',
        scope: context.job.envelope.scope,
        contents: composed.contents,
        observations: composed.observations,
        explicitAssociations: composed.explicitAssociations,
        maxCandidatesPerContent: context.job.budgetPolicy.maxCandidatesPerContent,
        includeZeroSignalFallback: false,
        createdAt: context.job.envelope.createdAt
      });
      const organized = organizeSparseContent({
        schemaVersion: '2.0',
        contractVersion: 'classification-hybrid.2',
        scope: context.job.envelope.scope,
        contents: composed.contents,
        observations: composed.observations,
        retrievalCandidates: mergeRetrievalCandidates(composed.retrievalCandidates,retrieval.candidates),
        explicitAssociations: composed.explicitAssociations,
        decisionPolicy: buildActiveEvidenceRulePolicy({
          maxCandidatesPerContent: context.job.budgetPolicy.maxCandidatesPerContent,
          createdAt: context.job.envelope.createdAt
        }),
        createdAt: context.job.envelope.createdAt
      });
      const organization = {
        ...organized,
        reviewItems: collectEvidenceRuleReviewItems(
          stage?.reviewItems,
          composed.reviewItems,
          organized.reviewItems
        )
      };
      const crossRoundAssociations = buildCrossRoundAssociations({
        scope: context.job.envelope.scope,
        authorizationRevision: context.job.envelope.authorizationRevision,
        contents: composed.contents,
        candidates: context.derivedFeatures?.historicalCandidates ?? [],
        createdAt: context.job.envelope.createdAt,
      });
      const workflowStatus = organization.reviewItems.length > 0 || stage?.workflowStatus === 'needs_review'
        ? 'needs_review' as const
        : 'succeeded' as const;
      const usage = stage?.usage ?? {
        requests: 0,
        images: 0,
        inputTokens: 0,
        outputTokens: 0,
        costCny: 0,
        latencyMs: 0,
        records: []
      };
      return {
        result: {
          version: LAB_EXECUTION_RESULT_VERSION,
          workflowStatus,
          profile: clone(this.profile) as LabExecutionOutcome['result']['profile'],
          output: {
            provider: {
              mode: this.profile.providerMode,
              providerVersion: this.profile.providerVersion,
              modelVersion: this.profile.modelVersion,
              promptVersion: this.profile.promptVersion,
              evidenceStatus: this.profile.providerMode === 'stage_a_real' ? 'real_api' : 'mock_transport',
              accuracyClaim: 'not_evaluated'
            },
            organization,
            observations: composed.observations,
            batchBindings: composed.batchBindings,
            highImpactClaims: [],
            crossRoundAssociations,
            retrieval: {
              candidateCount: organization.retrievalAudit.candidateCount,
              comparisonCount: retrieval.audit.comparisonCount,
              maxCandidatesPerContent: organization.retrievalAudit.maxCandidatesPerContent,
              scoreMeaning: 'retrieval_heuristic_not_probability'
            }
          }
        } as LabExecutionOutcome['result'],
        metrics: {
          latencyMs: usage.latencyMs,
          modelRequests: usage.requests,
          imageRequests: usage.images,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costCny: usage.costCny
        }
      };
    } catch(error) {
      mapThrownError(error);
    }
  }
}

/**
 * A strict factory for the v2 lifecycle. describe() is credential-free and
 * side-effect-free. create() stores the credential getter but does not invoke
 * it; ApiVisionProvider reads it only immediately before an authorized call.
 */
export class StageALabExecutorFactory implements LabExecutionExecutorFactory {
  private readonly profile: LabExecutionProfile;

  constructor(private readonly options: StageALabExecutorFactoryOptions) {
    this.profile = validateFactoryOptions(options);
  }

  describe(profile: LabExecutionProfile): LabExecutionProfile {
    const parsed = LabExecutionProfileSchema.parse(profile);
    if(!equal(parsed, this.profile)) fail('LAB_RUN_IDENTITY_MISMATCH');
    return clone(this.profile);
  }

  create(profile: LabExecutionProfile, _context: TrustedLabExecutionContext): LabExecutionExecutor {
    const described = this.describe(profile);
    return new StageALabExecutor(described, this.options);
  }
}
