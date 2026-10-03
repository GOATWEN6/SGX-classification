import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { ScopeSchema, stable, type Scope } from './stage-a-contract';

export const HISTORICAL_RETRIEVAL_SCHEMA_VERSION = '2.0';
export const HISTORICAL_RETRIEVAL_CONTRACT_VERSION = 'classification-historical-retrieval.1';
export const HISTORICAL_RETRIEVAL_STORE_VERSION = 'classification-historical-retrieval-store.1';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });
const faceId = z.string().regex(/^face_[a-f0-9]{32}$/);
const featureKind = z.enum(['image_text_embedding', 'face_embedding']);
const lifecycleState = z.enum(['active', 'invalidated', 'withdrawn']);
const finiteNumber = z.number().finite();
const versionFields = {
  schemaVersion: z.literal(HISTORICAL_RETRIEVAL_SCHEMA_VERSION),
  contractVersion: z.literal(HISTORICAL_RETRIEVAL_CONTRACT_VERSION),
};

export const HistoricalProjectionSchema = z.object({
  contentId: id,
  evidenceId: id,
  evidenceRevision: z.number().int().positive(),
  sourceHash: sha256,
  artifactId: id,
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
  byteLength: z.number().int().positive(),
  consentRef: id,
  personConsentRef: id.optional(),
  faceId: faceId.optional(),
  observationRef: id.optional(),
  confirmedReferenceIds: z.array(id).max(32).default([]),
  lifecycleState: z.literal('active'),
}).strict();

export const HistoricalFeatureRecordSchema = z.object({
  ...versionFields,
  recordId: id,
  featureId: id,
  scope: ScopeSchema,
  authorizationRevision: id,
  contentId: id,
  evidenceId: id,
  evidenceRevision: z.number().int().positive(),
  sourceHash: sha256,
  kind: featureKind,
  modelId: id,
  modelRevision: id,
  dimensions: z.number().int().positive().max(65536),
  normalized: z.literal(true),
  vector: z.array(finiteNumber).min(1).max(65536),
  lifecycleState,
  projection: HistoricalProjectionSchema,
  createdAt: dateTime,
  updatedAt: dateTime,
}).strict().superRefine((value, ctx) => {
  if(value.vector.length !== value.dimensions) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'VECTOR_DIMENSION_MISMATCH' });
  }
  if(value.contentId !== value.projection.contentId
    || value.evidenceId !== value.projection.evidenceId
    || value.evidenceRevision !== value.projection.evidenceRevision
    || value.sourceHash !== value.projection.sourceHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PROJECTION_IDENTITY_MISMATCH' });
  }
  if(value.kind === 'face_embedding'
    && (!value.projection.personConsentRef || !value.projection.faceId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PERSON_CONSENT_REQUIRED' });
  }
  if(value.kind !== 'face_embedding'
    && (value.projection.personConsentRef || value.projection.faceId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PERSON_DATA_NOT_APPLICABLE' });
  }
});

export const HistoricalRetrievalSourceSchema = z.object({
  sourceContentId: id,
  sourceEvidenceId: id,
  kind: featureKind,
  modelId: id,
  modelRevision: id,
  dimensions: z.number().int().positive().max(65536),
  normalized: z.literal(true),
  vector: z.array(finiteNumber).min(1).max(65536),
  personConsentRef: id.optional(),
}).strict().superRefine((value, ctx) => {
  if(value.vector.length !== value.dimensions) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'VECTOR_DIMENSION_MISMATCH' });
  }
  if(value.kind === 'face_embedding' && !value.personConsentRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PERSON_CONSENT_REQUIRED' });
  }
  if(value.kind !== 'face_embedding' && value.personConsentRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PERSON_DATA_NOT_APPLICABLE' });
  }
});

export const HistoricalRetrievalQuerySchema = z.object({
  ...versionFields,
  scope: ScopeSchema,
  authorizationRevision: id,
  sources: z.array(HistoricalRetrievalSourceSchema).min(1).max(256),
  maxCandidatesPerSource: z.number().int().min(1).max(32),
  excludeEvidenceIds: z.array(id).max(5000).default([]),
}).strict();

export const HistoricalRetrievalCandidateSchema = z.object({
  candidateId: id,
  sourceContentId: id,
  sourceEvidenceId: id,
  historicalContentId: id,
  historicalEvidenceId: id,
  kind: featureKind,
  rank: z.number().int().positive().max(32),
  modelId: id,
  modelRevision: id,
  reasons: z.array(id).min(1).max(8),
  featureRefs: z.array(id).min(1).max(32),
  evidenceRefs: z.array(id).min(2).max(32),
  historicalProjection: HistoricalProjectionSchema,
}).strict();

export const HistoricalRetrievalResultSchema = z.object({
  ...versionFields,
  scope: ScopeSchema,
  authorizationRevision: id,
  candidates: z.array(HistoricalRetrievalCandidateSchema).max(8192),
  traces: z.array(z.object({
    sourceContentId: id,
    sourceEvidenceId: id,
    eligibleCount: z.number().int().nonnegative(),
    selectedCandidateIds: z.array(id).max(32),
    coverage: z.enum(['complete', 'truncated']),
  }).strict()).max(256),
  scoreMeaning: z.literal('retrieval_order_not_probability'),
}).strict();

const StoreSnapshotSchema = z.object({
  version: z.literal(HISTORICAL_RETRIEVAL_STORE_VERSION),
  scope: ScopeSchema,
  records: z.array(HistoricalFeatureRecordSchema).max(100000),
}).strict();

export type HistoricalFeatureRecord = z.infer<typeof HistoricalFeatureRecordSchema>;
export type HistoricalRetrievalQuery = z.infer<typeof HistoricalRetrievalQuerySchema>;
export type HistoricalRetrievalResult = z.infer<typeof HistoricalRetrievalResultSchema>;

function scopeKey(scope: Scope): string {
  return createHash('sha256').update(stable(scope)).digest('hex');
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.householdId === right.householdId && left.subjectId === right.subjectId;
}

function normalizedVector(value: readonly number[]): number[] {
  const norm = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  if(!Number.isFinite(norm) || norm <= 0) throw new Error('INVALID_VECTOR_NORM');
  return value.map(item => item / norm);
}

function candidateId(parts: readonly string[]): string {
  const suffix = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
  return `historical_${suffix}`;
}

function pairSimilarity(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, item, index) => sum + item * right[index], 0);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class FileHistoricalRetrievalAdapter {
  private readonly pendingWrites = new Map<string, Promise<unknown>>();

  constructor(public readonly root: string) {
    if(!path.isAbsolute(root)) throw new Error('HISTORICAL_RETRIEVAL_ROOT_NOT_ABSOLUTE');
  }

  private filePath(scope: Scope): string {
    return path.join(this.root, `${scopeKey(scope)}.json`);
  }

  private async read(scope: Scope): Promise<z.infer<typeof StoreSnapshotSchema>> {
    try {
      const parsed = StoreSnapshotSchema.parse(JSON.parse(await readFile(this.filePath(scope), 'utf8')));
      if(!sameScope(parsed.scope, scope)) throw new Error('CROSS_SCOPE');
      return parsed;
    } catch(error) {
      if((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: HISTORICAL_RETRIEVAL_STORE_VERSION, scope: copy(scope), records: [] };
      }
      throw error;
    }
  }

  private async write(snapshot: z.infer<typeof StoreSnapshotSchema>): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.filePath(snapshot.scope);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(StoreSnapshotSchema.parse(snapshot))}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, target);
  }

  private async serialize<T>(scope: Scope, operation: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope);
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.pendingWrites.set(key, current);
    try {
      return await current;
    } finally {
      if(this.pendingWrites.get(key) === current) this.pendingWrites.delete(key);
    }
  }

  async upsert(input: {
    scope: Scope;
    authorizationRevision: string;
    records: HistoricalFeatureRecord[];
  }): Promise<{ upsertedRecords: number }> {
    const scope = ScopeSchema.parse(input.scope);
    const records = z.array(HistoricalFeatureRecordSchema).min(1).max(4096).parse(input.records);
    if(records.some(record => !sameScope(record.scope, scope))) throw new Error('CROSS_SCOPE');
    if(records.some(record => record.authorizationRevision !== input.authorizationRevision)) {
      throw new Error('AUTHORIZATION_CHANGED');
    }
    for(const record of records) normalizedVector(record.vector);
    return this.serialize(scope, async () => {
      const snapshot = await this.read(scope);
      const byId = new Map(snapshot.records.map(record => [record.recordId, record]));
      for(const record of records) byId.set(record.recordId, copy(record));
      await this.write({ ...snapshot, records: [...byId.values()].sort((a, b) => a.recordId.localeCompare(b.recordId)) });
      return { upsertedRecords: records.length };
    });
  }

  async query(raw: unknown): Promise<HistoricalRetrievalResult> {
    const input = HistoricalRetrievalQuerySchema.parse(raw);
    const pending = this.pendingWrites.get(scopeKey(input.scope));
    if(pending) await pending;
    const snapshot = await this.read(input.scope);
    const excluded = new Set(input.excludeEvidenceIds);
    const candidates: Array<z.infer<typeof HistoricalRetrievalCandidateSchema>> = [];
    const traces: HistoricalRetrievalResult['traces'] = [];

    for(const source of input.sources) {
      const sourceVector = normalizedVector(source.vector);
      const perContent = new Map<string, { record: HistoricalFeatureRecord; similarity: number }>();
      for(const record of snapshot.records) {
        if(record.lifecycleState !== 'active'
          || record.authorizationRevision !== input.authorizationRevision
          || record.evidenceId === source.sourceEvidenceId
          || record.contentId === source.sourceContentId
          || excluded.has(record.evidenceId)
          || record.kind !== source.kind
          || record.modelId !== source.modelId
          || record.modelRevision !== source.modelRevision
          || record.dimensions !== source.dimensions) continue;
        if(source.kind === 'face_embedding'
          && (!source.personConsentRef || !record.projection.personConsentRef)) continue;
        const similarity = pairSimilarity(sourceVector, normalizedVector(record.vector));
        const previous = perContent.get(record.contentId);
        if(!previous || similarity > previous.similarity
          || (similarity === previous.similarity && record.recordId.localeCompare(previous.record.recordId) < 0)) {
          perContent.set(record.contentId, { record, similarity });
        }
      }
      const ranked = [...perContent.values()].sort((left, right) => (
        right.similarity - left.similarity
        || left.record.contentId.localeCompare(right.record.contentId)
        || left.record.recordId.localeCompare(right.record.recordId)
      ));
      const selected = ranked.slice(0, input.maxCandidatesPerSource);
      const selectedCandidateIds: string[] = [];
      selected.forEach(({ record }, index) => {
        const idValue = candidateId([
          input.authorizationRevision,
          source.sourceEvidenceId,
          record.evidenceId,
          source.kind,
          source.modelId,
          source.modelRevision,
        ]);
        selectedCandidateIds.push(idValue);
        candidates.push(HistoricalRetrievalCandidateSchema.parse({
          candidateId: idValue,
          sourceContentId: source.sourceContentId,
          sourceEvidenceId: source.sourceEvidenceId,
          historicalContentId: record.contentId,
          historicalEvidenceId: record.evidenceId,
          kind: source.kind,
          rank: index + 1,
          modelId: source.modelId,
          modelRevision: source.modelRevision,
          reasons: source.kind === 'face_embedding'
            ? ['anonymous_person_candidate', 'historical_projection_authorized']
            : ['semantic_neighbor', 'historical_projection_authorized'],
          featureRefs: [record.featureId],
          evidenceRefs: [source.sourceEvidenceId, record.evidenceId],
          historicalProjection: record.projection,
        }));
      });
      traces.push({
        sourceContentId: source.sourceContentId,
        sourceEvidenceId: source.sourceEvidenceId,
        eligibleCount: ranked.length,
        selectedCandidateIds,
        coverage: ranked.length > selected.length ? 'truncated' : 'complete',
      });
    }

    return HistoricalRetrievalResultSchema.parse({
      schemaVersion: HISTORICAL_RETRIEVAL_SCHEMA_VERSION,
      contractVersion: HISTORICAL_RETRIEVAL_CONTRACT_VERSION,
      scope: input.scope,
      authorizationRevision: input.authorizationRevision,
      candidates,
      traces,
      scoreMeaning: 'retrieval_order_not_probability',
    });
  }

  async revokeEvidence(input: {
    scope: Scope;
    authorizationRevision: string;
    evidenceId: string;
    lifecycleState: 'invalidated' | 'withdrawn';
    updatedAt: string;
  }): Promise<{ updatedRecords: number }> {
    const scope = ScopeSchema.parse(input.scope);
    id.parse(input.authorizationRevision);
    id.parse(input.evidenceId);
    dateTime.parse(input.updatedAt);
    return this.serialize(scope, async () => {
      const snapshot = await this.read(scope);
      let updatedRecords = 0;
      const records = snapshot.records.map(record => {
        if(record.evidenceId !== input.evidenceId
          || record.authorizationRevision !== input.authorizationRevision
          || record.lifecycleState !== 'active') return record;
        updatedRecords += 1;
        return HistoricalFeatureRecordSchema.parse({
          ...record,
          lifecycleState: input.lifecycleState,
          updatedAt: input.updatedAt,
        });
      });
      if(updatedRecords) await this.write({ ...snapshot, records });
      return { updatedRecords };
    });
  }

  async deleteEvidence(input: {
    scope: Scope;
    evidenceId: string;
  }): Promise<{ deletedRecords: number }> {
    const scope = ScopeSchema.parse(input.scope);
    id.parse(input.evidenceId);
    return this.serialize(scope, async () => {
      const snapshot = await this.read(scope);
      const records = snapshot.records.filter(record => record.evidenceId !== input.evidenceId);
      const deletedRecords = snapshot.records.length - records.length;
      if(deletedRecords) await this.write({ ...snapshot, records });
      return { deletedRecords };
    });
  }
}
