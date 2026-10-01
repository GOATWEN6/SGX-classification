import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const REAL_BATCH_POINTER_VERSION = 'classification-real-batch-pointer.1';

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });
const RealBatchPointerSchema = z.object({
  version: z.literal(REAL_BATCH_POINTER_VERSION),
  batchId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  manifestPath: z.string().min(1),
  approvalPath: z.string().min(1),
  outputPath: z.string().min(1),
  manifestHash: hash,
  datasetRootDigest: hash,
  model: z.literal('qwen3.7-flash-2026-07-15'),
  maxRequests: z.number().int().min(1).max(20),
  maxCostCny: z.number().positive().max(5),
  automaticRetries: z.literal(0),
  allowPersonMatching: z.literal(false),
  expiresAt: dateTime,
  authorizationEvidenceRef: z.string().min(1)
}).strict();

export type RealBatchPointer = z.infer<typeof RealBatchPointerSchema>;

function dataRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.CLASSIFICATION_LAB_DATA_DIR || path.join(tmpdir(), 'sgx-classification-lab'));
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
  const pointer = RealBatchPointerSchema.parse(JSON.parse(await readFile(realBatchPointerPath(env), 'utf8')));
  if(Date.now() >= Date.parse(pointer.expiresAt)) throw new Error('REAL_BATCH_APPROVAL_EXPIRED');
  return pointer;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function getAuthorizedRealBatchStatus(env: NodeJS.ProcessEnv = process.env): Promise<{
  configured: true;
  pointer: RealBatchPointer;
  started: boolean;
  ledger?: unknown;
}> {
  const pointer = await loadPointer(env);
  const root = dataRoot(env);
  const manifestPath = await verifiedPath(root, pointer.manifestPath);
  if(sha256(await readFile(manifestPath)) !== pointer.manifestHash) throw new Error('REAL_BATCH_MANIFEST_CHANGED');
  const outputPath = path.resolve(pointer.outputPath);
  if(!inside(root, outputPath)) throw new Error('REAL_BATCH_PATH_FORBIDDEN');
  try {
    const ledger = JSON.parse(await readFile(path.join(outputPath, 'ledger.json'), 'utf8'));
    return { configured: true, pointer, started: true, ledger };
  } catch(error) {
    if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await access(outputPath); return { configured: true, pointer, started: true }; }
    catch { return { configured: true, pointer, started: false }; }
  }
}

export async function runAuthorizedRealBatch(env: NodeJS.ProcessEnv = process.env): Promise<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  pointer: RealBatchPointer;
}> {
  if(!env.SGX_D4_API_KEY) throw new Error('MODEL_NOT_CONFIGURED');
  const pointer = await loadPointer(env);
  const root = dataRoot(env);
  const manifestPath = await verifiedPath(root, pointer.manifestPath);
  const approvalPath = await verifiedPath(root, pointer.approvalPath);
  const outputPath = path.resolve(pointer.outputPath);
  if(!inside(root, outputPath)) throw new Error('REAL_BATCH_PATH_FORBIDDEN');
  if(sha256(await readFile(manifestPath)) !== pointer.manifestHash) throw new Error('REAL_BATCH_MANIFEST_CHANGED');
  try { await access(outputPath); throw new Error('REAL_BATCH_ALREADY_STARTED'); }
  catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

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
    '--approval', approvalPath
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
