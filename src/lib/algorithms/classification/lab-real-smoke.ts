import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildLabSubmission, type LabSubmission } from './lab-contract';
import {
  buildStageALabPlan,
  composeStageALabResult,
  computePlaceKindPolicyDigest
} from './lab-stage-a-composition';
import { ApiVisionProvider, PROVIDER_ENDPOINTS, type Transport } from './stage-a-provider';
import { ClassificationEngine } from './stage-a-pipeline';
import { PROMPT_VERSION, StageError, digest } from './stage-a-contract';
import { DeterministicTextExtractor } from './text-extractor';
import { retrieveExactCandidates } from './exact-retrieval';
import { organizeSparseContent } from './content-organization';

export const REAL_SMOKE_VERSION = 'classification-real-smoke.1';
export const REAL_SMOKE_MODEL = 'qwen3.7-flash-2026-07-15';
export const REAL_SMOKE_PROVIDER_VERSION = `qwen/${REAL_SMOKE_MODEL}/${PROMPT_VERSION}`;
export const REAL_SMOKE_MAX_IMAGE_BYTES = 1024 * 1024;

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });

const RealSmokeConfigSchema = z.object({
  enabled: z.literal(true),
  approvalRef: z.string().min(1).max(256),
  expiresAt: dateTime,
  maxRequests: z.number().int().min(1).max(20),
  maxCostCny: z.number().positive().max(30),
  dataRoot: z.string().min(1),
  model: z.literal(REAL_SMOKE_MODEL),
  inputCnyPerMillion: z.number().nonnegative(),
  outputCnyPerMillion: z.number().nonnegative()
}).strict();

export type RealSmokeConfig = z.infer<typeof RealSmokeConfigSchema>;

const LedgerEntrySchema = z.object({
  runId: z.string().min(1),
  status: z.enum(['reserved', 'succeeded', 'needs_review', 'failed']),
  startedAt: dateTime,
  finishedAt: dateTime.optional(),
  sourceHash: hash,
  requests: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costCny: z.number().min(0),
  errorCode: z.string().optional()
}).strict();

const LedgerSchema = z.object({
  version: z.literal(REAL_SMOKE_VERSION),
  approvalRef: z.string(),
  model: z.literal(REAL_SMOKE_MODEL),
  promptVersion: z.literal(PROMPT_VERSION),
  maxRequests: z.number().int().positive(),
  maxCostCny: z.number().positive(),
  entries: z.array(LedgerEntrySchema)
}).strict();

export type RealSmokeLedger = z.infer<typeof LedgerSchema>;

export interface RealSmokeResult {
  version: typeof REAL_SMOKE_VERSION;
  runId: string;
  workflowStatus: 'succeeded' | 'needs_review';
  provider: {
    mode: 'real_api';
    providerVersion: string;
    modelVersion: typeof REAL_SMOKE_MODEL;
    promptVersion: typeof PROMPT_VERSION;
    accuracyClaim: 'not_evaluated';
  };
  organization: ReturnType<typeof organizeSparseContent>;
  observations: ReturnType<typeof composeStageALabResult>['observations'];
  reviewItems: string[];
  unresolvedTemporalObservations: ReturnType<typeof composeStageALabResult>['unresolvedTemporalObservations'];
  usage: {
    requests: number;
    images: number;
    inputTokens: number;
    outputTokens: number;
    costCny: number;
    latencyMs: number;
  };
  audit: {
    approvalRef: string;
    inputDigest: string;
    rawResponsePath: string;
    personMatching: false;
    automaticRetries: 0;
  };
}

export interface RealSmokeDependencies {
  credential: () => string;
  transport?: Transport;
  now?: () => number;
}

let ledgerQueue: Promise<void> = Promise.resolve();

function fail(code: string): never { throw new StageError(code); }
function nowIso(now: () => number): string { return new Date(now()).toISOString(); }
function asPositiveNumber(value: string | undefined): number { return Number(value); }

export function realSmokeConfigFromEnv(env = process.env): RealSmokeConfig {
  if(env.CLASSIFICATION_LAB_REAL_ENABLED !== 'true') fail('REAL_SMOKE_DISABLED');
  try {
    return RealSmokeConfigSchema.parse({
      enabled: true,
      approvalRef: env.CLASSIFICATION_LAB_REAL_APPROVAL_REF,
      expiresAt: env.CLASSIFICATION_LAB_REAL_EXPIRES_AT,
      maxRequests: asPositiveNumber(env.CLASSIFICATION_LAB_REAL_MAX_REQUESTS),
      maxCostCny: asPositiveNumber(env.CLASSIFICATION_LAB_REAL_MAX_COST_CNY),
      dataRoot: env.CLASSIFICATION_LAB_DATA_DIR || path.join(tmpdir(), 'sgx-classification-lab'),
      model: env.CLASSIFICATION_LAB_REAL_MODEL || REAL_SMOKE_MODEL,
      inputCnyPerMillion: asPositiveNumber(env.CLASSIFICATION_LAB_REAL_INPUT_CNY_PER_MILLION || '1.2'),
      outputCnyPerMillion: asPositiveNumber(env.CLASSIFICATION_LAB_REAL_OUTPUT_CNY_PER_MILLION || '4.8')
    });
  } catch(error) {
    if(error instanceof StageError) throw error;
    fail('REAL_SMOKE_CONFIG_INVALID');
  }
}

function ledgerPath(config: RealSmokeConfig): string {
  return path.join(path.resolve(config.dataRoot), 'real-smoke', 'ledger.json');
}

async function loadLedger(config: RealSmokeConfig): Promise<RealSmokeLedger> {
  const filename = ledgerPath(config);
  try { return LedgerSchema.parse(JSON.parse(await readFile(filename, 'utf8'))); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return LedgerSchema.parse({
      version: REAL_SMOKE_VERSION,
      approvalRef: config.approvalRef,
      model: config.model,
      promptVersion: PROMPT_VERSION,
      maxRequests: config.maxRequests,
      maxCostCny: config.maxCostCny,
      entries: []
    });
  }
}

async function saveLedger(config: RealSmokeConfig, ledger: RealSmokeLedger): Promise<void> {
  const filename = ledgerPath(config);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(LedgerSchema.parse(ledger), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}

async function withLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = ledgerQueue;
  ledgerQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(); }
  finally { release(); }
}

function assertLedgerConfig(ledger: RealSmokeLedger, config: RealSmokeConfig): void {
  if(ledger.approvalRef !== config.approvalRef
    || ledger.model !== config.model
    || ledger.maxRequests !== config.maxRequests
    || ledger.maxCostCny !== config.maxCostCny) fail('REAL_SMOKE_APPROVAL_CHANGED');
}

async function updateLedger<T>(config: RealSmokeConfig, operation: (ledger: RealSmokeLedger) => Promise<T>): Promise<T> {
  return withLedgerLock(async () => {
    const ledger = await loadLedger(config);
    assertLedgerConfig(ledger, config);
    const result = await operation(ledger);
    await saveLedger(config, ledger);
    return result;
  });
}

function totals(ledger: RealSmokeLedger): { requests: number; costCny: number } {
  return ledger.entries.reduce((sum, entry) => ({
    requests: sum.requests + (entry.status === 'reserved' ? 1 : entry.requests),
    costCny: sum.costCny + entry.costCny
  }), { requests: 0, costCny: 0 });
}

export async function getRealSmokeStatus(config: RealSmokeConfig): Promise<{
  enabled: true;
  model: string;
  promptVersion: string;
  maxRequests: number;
  usedRequests: number;
  remainingRequests: number;
  maxCostCny: number;
  usedCostCny: number;
  expiresAt: string;
}> {
  const ledger = await loadLedger(config);
  assertLedgerConfig(ledger, config);
  const used = totals(ledger);
  return {
    enabled: true,
    model: config.model,
    promptVersion: PROMPT_VERSION,
    maxRequests: config.maxRequests,
    usedRequests: used.requests,
    remainingRequests: Math.max(0, config.maxRequests - used.requests),
    maxCostCny: config.maxCostCny,
    usedCostCny: used.costCny,
    expiresAt: config.expiresAt
  };
}

function authorizationFor(built: ReturnType<typeof buildLabSubmission>, config: RealSmokeConfig) {
  return {
    actorId: built.envelope.actorId,
    authorityRef: config.approvalRef,
    scope: built.envelope.scope,
    authorizationRevision: built.envelope.authorizationRevision,
    contextRevision: `context_${built.idempotencyKey.slice(7, 31)}`,
    active: true,
    allowedEvidenceIds: built.envelope.evidence.map(item => item.evidenceId),
    allowedConsentRefs: [...new Set(built.envelope.evidence.flatMap(item => item.lifecycleState === 'active' ? [item.consentRef] : []))],
    allowedCorrectionIds: [],
    allowPersonMatching: false
  } as const;
}

function errorCode(error: unknown): string {
  if(error instanceof StageError) return error.code;
  if(error instanceof z.ZodError) return 'REAL_SMOKE_INVALID_INPUT';
  return 'REAL_SMOKE_FAILED';
}

export async function runRealSmoke(
  submission: LabSubmission,
  configInput: RealSmokeConfig,
  dependencies: RealSmokeDependencies
): Promise<RealSmokeResult> {
  const config = RealSmokeConfigSchema.parse(configInput);
  const now = dependencies.now ?? Date.now;
  if(now() >= Date.parse(config.expiresAt)) fail('REAL_SMOKE_APPROVAL_EXPIRED');
  if(submission.images.length !== 1) fail('REAL_SMOKE_ONE_IMAGE_REQUIRED');
  if(submission.images[0].bytes.length > REAL_SMOKE_MAX_IMAGE_BYTES) fail('REAL_SMOKE_IMAGE_TOO_LARGE');
  const built = buildLabSubmission(submission, 'classification_real_smoke_local_consent');
  const image = built.envelope.evidence.find(item => item.lifecycleState === 'active' && item.modality === 'image');
  if(!image || image.lifecycleState !== 'active') fail('REAL_SMOKE_IMAGE_REQUIRED');
  const runId = `real_${randomUUID().replaceAll('-', '')}`;
  const runDirectory = path.join(path.resolve(config.dataRoot), 'real-smoke', 'runs', runId);
  const rawResponsePath = path.join(runDirectory, 'provider-responses.jsonl');
  const startedAt = nowIso(now);
  const reservedCost = (24576 * config.inputCnyPerMillion + 4096 * config.outputCnyPerMillion) / 1_000_000;

  await updateLedger(config, async ledger => {
    const used = totals(ledger);
    if(used.requests >= config.maxRequests) fail('REAL_SMOKE_REQUEST_LIMIT');
    if(used.costCny + reservedCost > config.maxCostCny) fail('REAL_SMOKE_COST_LIMIT');
    ledger.entries.push({
      runId,
      status: 'reserved',
      startedAt,
      sourceHash: image.sourceHash,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costCny: reservedCost
    });
  });

  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(runDirectory, 'input-manifest.json'), `${JSON.stringify({
    version: REAL_SMOKE_VERSION,
    runId,
    approvalRef: config.approvalRef,
    model: config.model,
    promptVersion: PROMPT_VERSION,
    sourceHash: image.sourceHash,
    byteLength: image.byteLength,
    mimeType: image.mimeType,
    textEvidenceIds: built.envelope.evidence.filter(item => item.lifecycleState === 'active' && item.modality !== 'image').map(item => item.evidenceId),
    personMatching: false,
    automaticRetries: 0,
    startedAt
  }, null, 2)}\n`, { mode: 0o600 });

  let stageUsage = { requests: 0, images: 0, inputTokens: 0, outputTokens: 0, costCny: reservedCost, latencyMs: 0 };
  try {
    const authorization = authorizationFor(built, config);
    const genericLabels = ['家中', '室内', '户外'];
    const placeKindPolicyBase = {
      policyVersion: 'classification-place-kind.1',
      taxonomyVersion: built.envelope.taxonomyVersion,
      genericLabels
    };
    const budget = {
      maxRequests: 1,
      maxInputTokens: 100_000,
      maxOutputTokens: 4096,
      maxCostCny: Math.min(config.maxCostCny, 0.25),
      deadlineAt: config.expiresAt,
      candidatesPerPhoto: 1,
      maxOutputPerRequest: 4096,
      stageOutputTokens: { extract: 4096, relate: 1024 },
      maxCallDurationMs: 60_000
    };
    const imageBytesByEvidenceId = Object.fromEntries(built.assets
      .filter(asset => asset.mimeType !== 'text/plain')
      .map(asset => [asset.evidenceId, new Uint8Array(asset.bytes)]));
    const plan = buildStageALabPlan({
      envelope: built.envelope,
      payloads: built.payloads,
      imageBytesByEvidenceId,
      authorization,
      placeKindPolicy: {
        ...placeKindPolicyBase,
        policyDigest: computePlaceKindPolicyDigest(placeKindPolicyBase)
      },
      runId,
      trigger: 'upload',
      budget,
      createdAt: submission.submittedAt
    });
    if(!plan.stageA) fail('REAL_SMOKE_IMAGE_REQUIRED');
    const provider = new ApiVisionProvider({
      provider: 'qwen',
      model: config.model,
      resolver: plan.stageA.resolveImage,
      ...(dependencies.transport ? { transport: dependencies.transport } : {}),
      credential: dependencies.credential,
      grant: {
        destination: PROVIDER_ENDPOINTS.qwen,
        model: config.model,
        expiresAt: config.expiresAt,
        photoIds: plan.stageA.request.photos.map(photo => photo.photoId)
      },
      inputCnyPerMillion: config.inputCnyPerMillion,
      outputCnyPerMillion: config.outputCnyPerMillion,
      record: entry => appendFileSync(rawResponsePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    });
    const engine = new ClassificationEngine(provider);
    const stage = await engine.process(plan.stageA.request, () => plan.stageA!.authorization);
    stageUsage = stage.usage;
    if(stage.workflowStatus === 'failed' || !stage.snapshot) fail(stage.errors[0]?.code ?? 'REAL_SMOKE_FAILED');

    const textExtractor = new DeterministicTextExtractor();
    const textObservations = plan.baseOrganization.contents.flatMap(content =>
      content.lifecycle === 'active' && (content.modality === 'user_text' || content.modality === 'final_asr')
        ? textExtractor.extract({ scope: built.envelope.scope, content, taxonomyVersion: built.envelope.taxonomyVersion }).observations
        : []);
    const composed = composeStageALabResult({ plan, stageResult: stage, textObservations, createdAt: submission.submittedAt });
    const retrieval = retrieveExactCandidates({
      schemaVersion: '1.0',
      contractVersion: 'classification-hybrid.1',
      scope: built.envelope.scope,
      contents: composed.contents,
      observations: composed.observations,
      explicitAssociations: composed.explicitAssociations,
      maxCandidatesPerContent: 8,
      includeZeroSignalFallback: false,
      createdAt: submission.submittedAt
    });
    const organization = organizeSparseContent({
      schemaVersion: '1.0',
      contractVersion: 'classification-hybrid.1',
      scope: built.envelope.scope,
      contents: composed.contents,
      observations: composed.observations,
      retrievalCandidates: [...composed.retrievalCandidates, ...retrieval.candidates],
      explicitAssociations: composed.explicitAssociations,
      decisionPolicy: {
        schemaVersion: '1.0',
        contractVersion: 'classification-hybrid.1',
        policyVersion: 'classification-real-smoke-shadow.1',
        mode: 'shadow',
        calibrated: false,
        maxCandidatesPerContent: 8,
        riskPolicyVersion: 'impact-risk.1',
        createdAt: submission.submittedAt
      },
      createdAt: submission.submittedAt
    });
    const workflowStatus = stage.workflowStatus === 'needs_review'
      || composed.reviewItems.length > 0
      || organization.reviewItems.length > 0 ? 'needs_review' as const : 'succeeded' as const;
    const result: RealSmokeResult = {
      version: REAL_SMOKE_VERSION,
      runId,
      workflowStatus,
      provider: {
        mode: 'real_api',
        providerVersion: provider.version,
        modelVersion: config.model,
        promptVersion: PROMPT_VERSION,
        accuracyClaim: 'not_evaluated'
      },
      organization,
      observations: composed.observations,
      reviewItems: [...new Set([...stage.reviewItems, ...composed.reviewItems, ...organization.reviewItems])],
      unresolvedTemporalObservations: composed.unresolvedTemporalObservations,
      usage: stage.usage,
      audit: {
        approvalRef: config.approvalRef,
        inputDigest: plan.audit.inputDigest,
        rawResponsePath,
        personMatching: false,
        automaticRetries: 0
      }
    };
    await writeFile(path.join(runDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    await updateLedger(config, async ledger => {
      const entry = ledger.entries.find(item => item.runId === runId);
      if(!entry) fail('REAL_SMOKE_LEDGER_CORRUPT');
      Object.assign(entry, {
        status: workflowStatus,
        finishedAt: nowIso(now),
        requests: stage.usage.requests,
        inputTokens: stage.usage.inputTokens,
        outputTokens: stage.usage.outputTokens,
        costCny: stage.usage.costCny
      });
    });
    return result;
  } catch(error) {
    const code = errorCode(error);
    await updateLedger(config, async ledger => {
      const entry = ledger.entries.find(item => item.runId === runId);
      if(!entry) return;
      Object.assign(entry, {
        status: 'failed',
        finishedAt: nowIso(now),
        requests: Math.max(1, stageUsage.requests),
        inputTokens: stageUsage.inputTokens,
        outputTokens: stageUsage.outputTokens,
        costCny: stageUsage.costCny,
        errorCode: code
      });
    });
    await writeFile(path.join(runDirectory, 'failure.json'), `${JSON.stringify({ code, runId, usage: stageUsage }, null, 2)}\n`, { mode: 0o600 });
    throw error instanceof StageError ? error : new StageError(code);
  }
}

export function realSmokeConfigDigest(config: RealSmokeConfig): string {
  return digest({
    approvalRef: config.approvalRef,
    expiresAt: config.expiresAt,
    maxRequests: config.maxRequests,
    maxCostCny: config.maxCostCny,
    model: config.model,
    inputCnyPerMillion: config.inputCnyPerMillion,
    outputCnyPerMillion: config.outputCnyPerMillion
  });
}
