import { buildLabSubmission, CLASSIFICATION_LAB_VERSION, type LabSubmission } from './lab-contract';
import { createConfiguredLabProvider, type ClassificationLabProvider } from './lab-provider';
import { FileClassificationLabStore, LAB_JOB_VERSION, type LabJobRecord } from './lab-store';

function safeErrorCode(error: unknown): string {
  const value = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : 'LAB_INTERNAL_ERROR';
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(value) ? value : 'LAB_INTERNAL_ERROR';
}

export async function submitClassificationLabJob(
  submission: LabSubmission,
  store = new FileClassificationLabStore(),
  provider: ClassificationLabProvider = createConfiguredLabProvider()
): Promise<LabJobRecord> {
  const built = buildLabSubmission(submission);
  const initial: LabJobRecord = {
    version: LAB_JOB_VERSION,
    jobId: built.jobId,
    idempotencyKey: built.idempotencyKey,
    status: 'pending',
    scope: built.envelope.scope,
    createdAt: built.envelope.createdAt,
    updatedAt: built.envelope.createdAt,
    envelope: built.envelope,
    originalTextByEvidenceId: { ...built.payloads.textByEvidenceId },
    assetRefs: built.assets.map(asset => ({ evidenceId: asset.evidenceId, filename: asset.filename, mimeType: asset.mimeType, byteLength: asset.bytes.length })),
    actions: []
  };
  const created = await store.create(initial, built.assets);
  if(!created.created) return created.record;
  const startedAt = Date.now();
  await store.update(built.jobId, current => ({ ...current, status: 'processing', updatedAt: new Date().toISOString() }));
  try {
    const result = await provider.run(built.envelope, built.payloads);
    const current = await store.get(built.jobId);
    if(!current) throw new Error('LAB_JOB_NOT_FOUND');
    if(current.status === 'cancelled') return current;
    const needsReview = result.organization.reviewItems.length > 0 || result.organization.decisionResults.some(decision => decision.riskLevel === 'high');
    return await store.update(built.jobId, job => ({
      ...job,
      status: needsReview ? 'needs_review' : 'succeeded',
      updatedAt: new Date().toISOString(),
      result,
      metrics: { latencyMs: Date.now() - startedAt, modelRequests: 0, costCny: 0 },
      error: undefined
    }));
  } catch(error) {
    return await store.update(built.jobId, job => ({
      ...job,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: { code: safeErrorCode(error) }
    }));
  }
}

export function classificationLabCapabilities() {
  return {
    version: CLASSIFICATION_LAB_VERSION,
    enabled: process.env.CLASSIFICATION_LAB_ENABLED === 'true',
    providerMode: process.env.CLASSIFICATION_LAB_PROVIDER ?? 'deterministic',
    providerEvidence: 'integration_baseline_only',
    accuracyClaim: 'not_evaluated',
    realProviderConfigured: false,
    persistence: 'local_file_adapter',
    productionDatabase: false,
    productionQueue: false
  } as const;
}
