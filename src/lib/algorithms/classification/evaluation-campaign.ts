import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const EVALUATION_CAMPAIGN_POINTER_VERSION = 'classification-real-batch-pointer.2';
export const EVALUATION_CAMPAIGN_LEDGER_VERSION = 'classification-evaluation-campaign-ledger.1';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });

export const CampaignCapsSchema = z.object({
  maxRequests: z.number().int().min(1).max(150),
  maxCostCny: z.number().positive().max(25),
  maxRetries: z.literal(0),
}).strict();

export const BatchCapsBindingSchema = z.object({
  maxRequests: z.number().int().min(1).max(150),
  maxCostCny: z.number().positive().max(25),
  maxRetries: z.literal(0),
}).strict();

export const EvaluationCampaignPointerSchema = z.object({
  version: z.literal(EVALUATION_CAMPAIGN_POINTER_VERSION),
  campaignId: id,
  phase: z.enum(['exploration', 'validation']),
  batchId: id,
  manifestPath: z.string().min(1),
  approvalPath: z.string().min(1),
  outputPath: z.string().min(1),
  manifestHash: sha,
  approvalHash: sha,
  datasetRootDigest: sha,
  provider: z.enum(['qwen', 'glm']),
  model: z.string().min(1),
  batchCaps: BatchCapsBindingSchema,
  campaignCaps: CampaignCapsSchema,
  allowPersonMatching: z.boolean(),
  expiresAt: dateTime,
  authorizationEvidenceRef: z.string().min(1),
}).strict();

export const EvaluationCampaignApprovalSchema = z.object({
  version: z.literal('sgx-eval-approval.2'),
  campaignId: id,
  phase: z.enum(['exploration', 'validation']),
  batchId: id,
  manifestHash: sha,
  datasetRootDigest: sha,
  approvedBy: z.string().min(1),
  authorizationEvidenceRef: z.string().min(1),
  expiresAt: dateTime,
  provider: z.enum(['qwen', 'glm']),
  model: z.string().min(1),
  photoIds: z.array(id),
  caps: z.object({
    maxRequests: z.number().int().positive().max(1000),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxCostCny: z.number().nonnegative(),
    maxDurationSeconds: z.number().int().positive().max(3600),
    maxRetries: z.literal(0),
  }).strict(),
  campaignCaps: CampaignCapsSchema,
  allowExternalImages: z.literal(true),
  allowPersonMatching: z.boolean(),
}).strict();

const AccountedUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  costMicroCny: z.number().int().nonnegative(),
}).strict();

const CampaignBatchSchema = z.object({
  batchId: id,
  phase: z.enum(['exploration', 'validation']),
  manifestHash: sha,
  approvalHash: sha,
  runIds: z.array(id).min(1),
  status: z.enum(['reserved', 'completed', 'completed_with_case_failures', 'halted']),
  reserved: AccountedUsageSchema,
  actual: AccountedUsageSchema.optional(),
  startedAt: dateTime,
  finishedAt: dateTime.optional(),
  stopReason: z.string().min(1).optional(),
}).strict();

const CampaignLedgerSchema = z.object({
  version: z.literal(EVALUATION_CAMPAIGN_LEDGER_VERSION),
  campaignId: id,
  caps: z.object({
    maxRequests: z.number().int().min(1).max(150),
    maxCostMicroCny: z.number().int().positive().max(25_000_000),
    maxRetries: z.literal(0),
  }).strict(),
  state: z.enum(['active', 'halted']),
  batches: z.array(CampaignBatchSchema),
  updatedAt: dateTime,
}).strict();

export type EvaluationCampaignPointer = z.infer<typeof EvaluationCampaignPointerSchema>;
export type EvaluationCampaignApproval = z.infer<typeof EvaluationCampaignApprovalSchema>;
export type CampaignLedger = z.infer<typeof CampaignLedgerSchema>;
export type CampaignBatchFinishStatus = 'completed' | 'completed_with_case_failures' | 'halted';

type ManifestBinding = {
  batchId: string;
  partition: 'exploration' | 'holdout';
  provider: 'qwen' | 'glm';
  model: string;
  datasetRootDigest?: string;
  caps: { maxRequests: number; maxCostCny: number; maxRetries: number };
};

export function sha256Bytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function ensure(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}

function sameCaps(
  left: { maxRequests: number; maxCostCny: number; maxRetries: number },
  right: { maxRequests: number; maxCostCny: number; maxRetries: number },
): boolean {
  return left.maxRequests === right.maxRequests
    && left.maxCostCny === right.maxCostCny
    && left.maxRetries === right.maxRetries;
}

export function validateCampaignBindings(input: {
  pointer: unknown;
  manifest: ManifestBinding;
  manifestHash: string;
  approval: unknown;
  approvalBytes: Uint8Array;
}): { pointer: EvaluationCampaignPointer; approval: EvaluationCampaignApproval } {
  const pointer = EvaluationCampaignPointerSchema.parse(input.pointer);
  ensure(Date.now() < Date.parse(pointer.expiresAt), 'REAL_BATCH_APPROVAL_EXPIRED');
  ensure(pointer.manifestHash === input.manifestHash, 'REAL_BATCH_MANIFEST_CHANGED');
  ensure(pointer.approvalHash === sha256Bytes(input.approvalBytes), 'REAL_BATCH_APPROVAL_CHANGED');
  const approval = EvaluationCampaignApprovalSchema.parse(input.approval);
  const expectedPhase = input.manifest.partition === 'exploration' ? 'exploration' : 'validation';
  ensure(pointer.batchId === input.manifest.batchId && approval.batchId === input.manifest.batchId, 'CAMPAIGN_BATCH_MISMATCH');
  ensure(pointer.campaignId === approval.campaignId, 'CAMPAIGN_ID_MISMATCH');
  ensure(pointer.phase === expectedPhase && approval.phase === expectedPhase, 'CAMPAIGN_PHASE_MISMATCH');
  ensure(approval.manifestHash === input.manifestHash, 'APPROVAL_MANIFEST_MISMATCH');
  ensure(input.manifest.datasetRootDigest === pointer.datasetRootDigest, 'CAMPAIGN_DATASET_MISMATCH');
  ensure(pointer.datasetRootDigest === approval.datasetRootDigest, 'CAMPAIGN_DATASET_MISMATCH');
  ensure(pointer.provider === input.manifest.provider && approval.provider === input.manifest.provider, 'APPROVAL_MODEL_MISMATCH');
  ensure(pointer.model === input.manifest.model && approval.model === input.manifest.model, 'APPROVAL_MODEL_MISMATCH');
  ensure(sameCaps(pointer.batchCaps, input.manifest.caps), 'APPROVAL_CAP_MISMATCH');
  ensure(sameCaps(pointer.batchCaps, approval.caps), 'APPROVAL_CAP_MISMATCH');
  ensure(sameCaps(pointer.campaignCaps, approval.campaignCaps), 'CAMPAIGN_CAP_MISMATCH');
  ensure(pointer.allowPersonMatching === approval.allowPersonMatching, 'PERSON_MATCHING_APPROVAL_MISMATCH');
  ensure(pointer.expiresAt === approval.expiresAt, 'APPROVAL_EXPIRY_MISMATCH');
  ensure(pointer.authorizationEvidenceRef === approval.authorizationEvidenceRef, 'AUTHORIZATION_EVIDENCE_MISMATCH');
  return { pointer, approval };
}

function toMicroCny(value: number): number {
  ensure(Number.isFinite(value) && value >= 0, 'INVALID_CAMPAIGN_USAGE');
  const result = Math.ceil(value * 1_000_000 - Number.EPSILON);
  ensure(Number.isSafeInteger(result), 'INVALID_CAMPAIGN_USAGE');
  return result;
}

function pathIsInsideOrSame(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function evaluationCampaignDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  ensure(Boolean(env.CLASSIFICATION_LAB_DATA_DIR), 'PERSISTENT_DATA_ROOT_REQUIRED');
  const dataRoot = path.resolve(env.CLASSIFICATION_LAB_DATA_DIR!);
  if (env.CLASSIFICATION_EVAL_ALLOW_EPHEMERAL_TEST_ROOT !== '1') {
    const ephemeralRoots = [tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']
      .map(candidate => path.resolve(candidate));
    ensure(!ephemeralRoots.some(root => pathIsInsideOrSame(root, dataRoot)), 'PERSISTENT_DATA_ROOT_REQUIRED');
  }
  return dataRoot;
}

function campaignRoot(env: NodeJS.ProcessEnv, campaignId: string): string {
  return path.join(evaluationCampaignDataRoot(env), 'real-batch', 'campaigns', campaignId);
}

function ledgerPath(root: string): string {
  return path.join(root, 'campaign-ledger.json');
}

async function readLedger(root: string): Promise<CampaignLedger | undefined> {
  try {
    return CampaignLedgerSchema.parse(JSON.parse(await readFile(ledgerPath(root), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeLedger(root: string, ledger: CampaignLedger): Promise<void> {
  const destination = ledgerPath(root);
  const temporary = `${destination}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, destination);
}

export function accountedCampaignUsage(ledger: CampaignLedger): { requests: number; costMicroCny: number } {
  return ledger.batches.reduce((totals, batch) => {
    const usage = batch.status === 'completed' || batch.status === 'completed_with_case_failures'
      ? batch.actual ?? batch.reserved
      : {
          requests: Math.max(batch.reserved.requests, batch.actual?.requests ?? 0),
          costMicroCny: Math.max(batch.reserved.costMicroCny, batch.actual?.costMicroCny ?? 0),
        };
    totals.requests += usage.requests;
    totals.costMicroCny += usage.costMicroCny;
    return totals;
  }, { requests: 0, costMicroCny: 0 });
}

export type CampaignReservation = {
  root: string;
  lockPath: string;
  token: string;
  campaignId: string;
  batchId: string;
};

export async function beginCampaignBatch(input: {
  env?: NodeJS.ProcessEnv;
  pointer: EvaluationCampaignPointer;
  runIds: string[];
}): Promise<CampaignReservation> {
  const env = input.env ?? process.env;
  const pointer = EvaluationCampaignPointerSchema.parse(input.pointer);
  ensure(new Set(input.runIds).size === input.runIds.length && input.runIds.length > 0, 'DUPLICATE_RUN');
  const root = campaignRoot(env, pointer.campaignId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, 'campaign.lock');
  const token = randomUUID();
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('CAMPAIGN_LOCKED_OR_UNCERTAIN');
    throw error;
  }
  await lock.writeFile(`${JSON.stringify({ token, campaignId: pointer.campaignId, batchId: pointer.batchId, acquiredAt: new Date().toISOString() })}\n`);
  await lock.close();
  let committed = false;
  try {
    const maxCostMicroCny = toMicroCny(pointer.campaignCaps.maxCostCny);
    let ledger = await readLedger(root);
    if (!ledger) {
      ledger = {
        version: EVALUATION_CAMPAIGN_LEDGER_VERSION,
        campaignId: pointer.campaignId,
        caps: { maxRequests: pointer.campaignCaps.maxRequests, maxCostMicroCny, maxRetries: 0 },
        state: 'active',
        batches: [],
        updatedAt: new Date().toISOString(),
      };
    }
    ensure(ledger.campaignId === pointer.campaignId, 'CAMPAIGN_ID_MISMATCH');
    ensure(ledger.state === 'active', 'CAMPAIGN_HALTED');
    ensure(ledger.caps.maxRequests === pointer.campaignCaps.maxRequests
      && ledger.caps.maxCostMicroCny === maxCostMicroCny
      && ledger.caps.maxRetries === 0, 'CAMPAIGN_CAP_MISMATCH');
    ensure(!ledger.batches.some(batch => batch.status === 'reserved' || batch.status === 'halted'), 'CAMPAIGN_LOCKED_OR_UNCERTAIN');
    ensure(!ledger.batches.some(batch => batch.batchId === pointer.batchId), 'DUPLICATE_CAMPAIGN_BATCH');
    ensure(!ledger.batches.some(batch => batch.manifestHash === pointer.manifestHash), 'DUPLICATE_CAMPAIGN_MANIFEST');
    const usedRunIds = new Set(ledger.batches.flatMap(batch => batch.runIds));
    ensure(!input.runIds.some(runId => usedRunIds.has(runId)), 'DUPLICATE_RUN');
    if (pointer.phase === 'validation') {
      ensure(ledger.batches.some(batch => batch.phase === 'exploration'
        && ['completed', 'completed_with_case_failures'].includes(batch.status)), 'VALIDATION_REQUIRES_EXPLORATION');
      ensure(!ledger.batches.some(batch => batch.phase === 'validation'), 'DUPLICATE_VALIDATION_PHASE');
    }
    const reserved = {
      requests: pointer.batchCaps.maxRequests,
      costMicroCny: toMicroCny(pointer.batchCaps.maxCostCny),
    };
    const accounted = accountedCampaignUsage(ledger);
    ensure(accounted.requests + reserved.requests <= ledger.caps.maxRequests
      && accounted.costMicroCny + reserved.costMicroCny <= ledger.caps.maxCostMicroCny, 'CAMPAIGN_BUDGET_EXHAUSTED');
    ledger.batches.push({
      batchId: pointer.batchId,
      phase: pointer.phase,
      manifestHash: pointer.manifestHash,
      approvalHash: pointer.approvalHash,
      runIds: [...input.runIds],
      status: 'reserved',
      reserved,
      startedAt: new Date().toISOString(),
    });
    ledger.updatedAt = new Date().toISOString();
    await writeLedger(root, ledger);
    committed = true;
    return { root, lockPath, token, campaignId: pointer.campaignId, batchId: pointer.batchId };
  } finally {
    if (!committed) await unlink(lockPath).catch(() => undefined);
  }
}

export async function finishCampaignBatch(input: {
  reservation: CampaignReservation;
  status: CampaignBatchFinishStatus;
  actualRequests: number;
  actualCostCny: number;
  stopReason?: string;
}): Promise<CampaignLedger> {
  ensure(Number.isInteger(input.actualRequests) && input.actualRequests >= 0, 'INVALID_CAMPAIGN_USAGE');
  const lock = JSON.parse(await readFile(input.reservation.lockPath, 'utf8')) as { token?: string };
  ensure(lock.token === input.reservation.token, 'CAMPAIGN_LOCK_MISMATCH');
  const ledger = await readLedger(input.reservation.root);
  ensure(ledger, 'CAMPAIGN_LEDGER_MISSING');
  const batch = ledger.batches.find(candidate => candidate.batchId === input.reservation.batchId);
  ensure(batch && batch.status === 'reserved', 'CAMPAIGN_RESERVATION_MISSING');
  const actual = { requests: input.actualRequests, costMicroCny: toMicroCny(input.actualCostCny) };
  if (actual.requests > batch.reserved.requests || actual.costMicroCny > batch.reserved.costMicroCny) {
    batch.status = 'halted';
    batch.stopReason = 'CAMPAIGN_RESERVATION_OVERRUN';
    ledger.state = 'halted';
  } else {
    batch.status = input.status;
    if (input.status === 'halted') ledger.state = 'halted';
    if (input.stopReason) batch.stopReason = input.stopReason;
  }
  batch.actual = actual;
  batch.finishedAt = new Date().toISOString();
  ledger.updatedAt = new Date().toISOString();
  await writeLedger(input.reservation.root, ledger);
  await unlink(input.reservation.lockPath);
  return ledger;
}

export async function readCampaignLedger(
  campaignId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CampaignLedger | undefined> {
  id.parse(campaignId);
  return readLedger(campaignRoot(env, campaignId));
}
