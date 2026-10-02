import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EvaluationCampaignPointer,
  EvaluationCampaignPointerSchema,
  EVALUATION_CAMPAIGN_POINTER_VERSION,
  evaluationCampaignDataRoot,
  readCampaignLedger,
  validateCampaignBindings,
} from './evaluation-campaign';

export const REAL_BATCH_POINTER_VERSION = EVALUATION_CAMPAIGN_POINTER_VERSION;
export type RealBatchPointer = EvaluationCampaignPointer;

function dataRoot(env: NodeJS.ProcessEnv): string {
  return evaluationCampaignDataRoot(env);
}

export function realBatchPointerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRoot(env), 'real-batch', 'active.json');
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function verifiedPath(root: string, target: string): Promise<string> {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(target);
  if(!inside(rootResolved, resolved)) throw new Error('REAL_BATCH_PATH_FORBIDDEN');
  const [actualRoot, actual] = await Promise.all([realpath(rootResolved), realpath(resolved)]);
  if(!inside(actualRoot, actual)) throw new Error('REAL_BATCH_PATH_FORBIDDEN');
  return actual;
}

async function loadPointer(env: NodeJS.ProcessEnv): Promise<RealBatchPointer> {
  const pointer = EvaluationCampaignPointerSchema.parse(JSON.parse(await readFile(realBatchPointerPath(env), 'utf8')));
  if(Date.now() >= Date.parse(pointer.expiresAt)) throw new Error('REAL_BATCH_APPROVAL_EXPIRED');
  return pointer;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function loadBoundBatch(env: NodeJS.ProcessEnv): Promise<{
  pointer: RealBatchPointer;
  root: string;
  manifestPath: string;
  approvalPath: string;
  outputPath: string;
}> {
  const pointer = await loadPointer(env);
  const root = dataRoot(env);
  const manifestPath = await verifiedPath(root, pointer.manifestPath);
  const approvalPath = await verifiedPath(root, pointer.approvalPath);
  const outputPath = path.resolve(pointer.outputPath);
  if(!inside(root, outputPath)) throw new Error('REAL_BATCH_PATH_FORBIDDEN');
  const [manifestBytes, approvalBytes] = await Promise.all([readFile(manifestPath), readFile(approvalPath)]);
  const manifestHash = sha256(manifestBytes);
  if(manifestHash !== pointer.manifestHash) throw new Error('REAL_BATCH_MANIFEST_CHANGED');
  validateCampaignBindings({
    pointer,
    manifest: JSON.parse(manifestBytes.toString('utf8')),
    manifestHash,
    approval: JSON.parse(approvalBytes.toString('utf8')),
    approvalBytes,
  });
  return { pointer, root, manifestPath, approvalPath, outputPath };
}

export async function getAuthorizedRealBatchStatus(env: NodeJS.ProcessEnv = process.env): Promise<{
  configured: true;
  pointer: RealBatchPointer;
  started: boolean;
  ledger?: unknown;
  campaignLedger?: unknown;
}> {
  const { pointer, outputPath } = await loadBoundBatch(env);
  const campaignLedger = await readCampaignLedger(pointer.campaignId, env);
  try {
    const ledger = JSON.parse(await readFile(path.join(outputPath, 'ledger.json'), 'utf8'));
    return { configured: true, pointer, started: true, ledger, ...(campaignLedger ? { campaignLedger } : {}) };
  } catch(error) {
    if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await access(outputPath); return { configured: true, pointer, started: true, ...(campaignLedger ? { campaignLedger } : {}) }; }
    catch { return { configured: true, pointer, started: false, ...(campaignLedger ? { campaignLedger } : {}) }; }
  }
}

export async function runAuthorizedRealBatch(env: NodeJS.ProcessEnv = process.env): Promise<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  pointer: RealBatchPointer;
}> {
  const { pointer, root, manifestPath, approvalPath, outputPath } = await loadBoundBatch(env);
  try { await access(outputPath); throw new Error('REAL_BATCH_ALREADY_STARTED'); }
  catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if(!env.SGX_D4_API_KEY) throw new Error('MODEL_NOT_CONFIGURED');

  const logRoot = path.join(root, 'real-batch', 'logs');
  await mkdir(logRoot, { recursive: true, mode: 0o700 });
  const logPath = path.join(logRoot, `${pointer.batchId}.log`);
  await writeFile(logPath, '', { mode: 0o600, flag: 'wx' });
  const child = spawn(process.execPath, [
    'scripts/classification-stage-a.mjs',
    '--eval',
    '--manifest', manifestPath,
    '--out', outputPath,
    '--execute',
    '--approval', approvalPath,
    '--pointer', realBatchPointerPath(env),
  ], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const finished = await new Promise<{ exitCode: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ exitCode: code ?? 2, signal }));
  });
  await writeFile(logPath, Buffer.concat(chunks), { mode: 0o600 });
  return { ...finished, pointer };
}
