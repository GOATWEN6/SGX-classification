import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ContentObservationSchema, SparseOrganizationResultSchema } from './content-organization';
import { parseIngestionEnvelope, type IngestionEnvelope } from './ingestion-contract';
import type { LabAsset } from './lab-contract';
import type { LabProviderResult } from './lab-provider';

export const LAB_JOB_VERSION = 'classification-lab-job.1';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });

export const LabActionSchema = z.object({
  actionId: id,
  kind: z.enum(['accept_story', 'reject_association', 'remove_content', 'split_content', 'merge_stories', 'delete_evidence', 'revoke_authorization']),
  targetIds: z.array(id).min(1).max(100),
  actorId: id,
  createdAt: dateTime
}).strict();

const LabJobStructureSchema = z.object({
  version: z.literal(LAB_JOB_VERSION),
  jobId: id,
  idempotencyKey: hash,
  status: z.enum(['pending', 'processing', 'succeeded', 'needs_review', 'failed', 'cancelled']),
  scope: z.object({ householdId: id, subjectId: id }).strict(),
  createdAt: dateTime,
  updatedAt: dateTime,
  envelope: z.unknown(),
  originalTextByEvidenceId: z.record(id, z.string().max(65536)),
  assetRefs: z.array(z.object({ evidenceId: id, filename: z.string().min(1).max(160), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'text/plain']), byteLength: z.number().int().positive() }).strict()).max(5000),
  result: z.unknown().optional(),
  metrics: z.object({ latencyMs: z.number().int().nonnegative(), modelRequests: z.number().int().nonnegative(), costCny: z.number().nonnegative() }).strict().optional(),
  error: z.object({ code: id }).strict().optional(),
  actions: z.array(LabActionSchema).max(10000)
}).strict();

export type LabAction = z.infer<typeof LabActionSchema>;
export type LabJobStatus = z.infer<typeof LabJobStructureSchema>['status'];
export interface LabAssetRef { evidenceId: string; filename: string; mimeType: LabAsset['mimeType']; byteLength: number; }
export interface LabJobRecord {
  version: typeof LAB_JOB_VERSION;
  jobId: string;
  idempotencyKey: string;
  status: LabJobStatus;
  scope: { householdId: string; subjectId: string };
  createdAt: string;
  updatedAt: string;
  envelope: IngestionEnvelope;
  originalTextByEvidenceId: Record<string, string>;
  assetRefs: LabAssetRef[];
  result?: LabProviderResult;
  metrics?: { latencyMs: number; modelRequests: number; costCny: number };
  error?: { code: string };
  actions: LabAction[];
}

function parseLabJob(raw: unknown): LabJobRecord {
  const structure = LabJobStructureSchema.parse(raw);
  const envelope = parseIngestionEnvelope(structure.envelope);
  let result: LabProviderResult | undefined;
  if(structure.result) {
    const value = structure.result as LabProviderResult;
    if(value.provider?.mode !== 'deterministic' || value.provider.accuracyClaim !== 'not_evaluated') throw new Error('INVALID_LAB_PROVIDER_RESULT');
    result = {
      ...value,
      organization: SparseOrganizationResultSchema.parse(value.organization),
      observations: z.array(ContentObservationSchema).parse(value.observations)
    };
  }
  for(const evidenceId of Object.keys(structure.originalTextByEvidenceId)) {
    const record = envelope.evidence.find(value => value.evidenceId === evidenceId);
    if(!record || record.lifecycleState === 'deleted' || record.modality === 'image') throw new Error('FOREIGN_LAB_TEXT_PAYLOAD');
  }
  return { ...structure, envelope, ...(result ? { result } : {}) } as LabJobRecord;
}

function jobPath(root: string, jobId: string): string {
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId)) throw new Error('INVALID_JOB_ID');
  return path.join(root, jobId);
}

export class FileClassificationLabStore {
  readonly root: string;
  constructor(root = process.env.CLASSIFICATION_LAB_DATA_DIR || path.join(tmpdir(), 'sgx-classification-lab')) {
    this.root = path.resolve(root);
  }

  private async ensureRoot(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); }

  async get(jobId: string): Promise<LabJobRecord | undefined> {
    try { return parseLabJob(JSON.parse(await readFile(path.join(jobPath(this.root, jobId), 'job.json'), 'utf8'))); }
    catch(error) {
      if((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async create(record: LabJobRecord, assets: LabAsset[]): Promise<{ record: LabJobRecord; created: boolean }> {
    await this.ensureRoot();
    const existing = await this.get(record.jobId);
    if(existing) return { record: existing, created: false };
    const temporary = path.join(this.root, `.pending-${record.jobId}-${randomUUID()}`);
    await mkdir(path.join(temporary, 'assets'), { recursive: true, mode: 0o700 });
    try {
      for(const asset of assets) await writeFile(path.join(temporary, 'assets', asset.evidenceId), asset.bytes, { mode: 0o600 });
      await writeFile(path.join(temporary, 'job.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      try { await rename(temporary, jobPath(this.root, record.jobId)); }
      catch(error) {
        if((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
        await rm(temporary, { recursive: true, force: true });
        const raced = await this.get(record.jobId);
        if(!raced) throw error;
        return { record: raced, created: false };
      }
      return { record, created: true };
    } catch(error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async update(jobId: string, transform: (current: LabJobRecord) => LabJobRecord): Promise<LabJobRecord> {
    const current = await this.get(jobId);
    if(!current) throw new Error('LAB_JOB_NOT_FOUND');
    const next = parseLabJob(transform(current));
    if(next.jobId !== current.jobId || next.idempotencyKey !== current.idempotencyKey) throw new Error('LAB_JOB_IDENTITY_CHANGED');
    const filename = path.join(jobPath(this.root, jobId), `job-${randomUUID()}.tmp`);
    await writeFile(filename, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(filename, path.join(jobPath(this.root, jobId), 'job.json'));
    return next;
  }

  async list(limit = 20): Promise<LabJobRecord[]> {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    const jobs = await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.pending-')).map(entry => this.get(entry.name)));
    return jobs.filter((job): job is LabJobRecord => Boolean(job)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, Math.max(1, Math.min(limit, 100)));
  }

  async readAsset(jobId: string, evidenceId: string): Promise<{ bytes: Buffer; ref: LabAssetRef }> {
    const job = await this.get(jobId);
    if(!job) throw new Error('LAB_JOB_NOT_FOUND');
    const ref = job.assetRefs.find(value => value.evidenceId === evidenceId);
    if(!ref) throw new Error('LAB_ASSET_NOT_FOUND');
    const bytes = await readFile(path.join(jobPath(this.root, jobId), 'assets', evidenceId));
    if(bytes.length !== ref.byteLength) throw new Error('LAB_ASSET_LENGTH_MISMATCH');
    return { bytes, ref };
  }
}
