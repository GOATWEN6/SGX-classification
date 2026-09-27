import { createHash } from 'node:crypto';
import {
  AssociationCandidateSchema,
  ContentItemSchema,
  type AssociationCandidate,
  type ContentItem
} from './content-organization';
import {
  HYBRID_CONTRACT_VERSION,
  HYBRID_SCHEMA_VERSION,
  RetrievalCandidateSchema,
  type RetrievalCandidate
} from './hybrid-contract';
import {
  parseIngestionEnvelope,
  type EvidenceBinding,
  type IngestionEnvelope
} from './ingestion-contract';
import { digest } from './stage-a-contract';

export const INGESTION_ORGANIZATION_ADAPTER_VERSION = 'ingestion-organization-adapter.1';

export interface IngestionPayloads {
  textByEvidenceId: Record<string, string>;
}

export interface BatchEvidenceBinding {
  bindingId: string;
  sourceContentId: string;
  authority: EvidenceBinding['authority'];
  state: EvidenceBinding['state'];
  evidenceRefs: string[];
}

export interface IngestionOrganizationOutput {
  envelope: IngestionEnvelope;
  contents: ContentItem[];
  explicitAssociations: AssociationCandidate[];
  retrievalCandidates: RetrievalCandidate[];
  batchBindings: BatchEvidenceBinding[];
  audit: {
    adapterVersion: typeof INGESTION_ORGANIZATION_ADAPTER_VERSION;
    ingestionId: string;
    contentCount: number;
    authoritativePairCount: number;
    aiCandidatePairCount: number;
    preservedBatchBindingCount: number;
  };
}

export class IngestionOrganizationError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function fail(code: string): never { throw new IngestionOrganizationError(code); }
function textHash(text: string): string { return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`; }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }

function pairEvidenceRefs(binding: EvidenceBinding, targetContentId: string, envelope: IngestionEnvelope): string[] {
  const source = envelope.contents.find(item => item.contentId === binding.sourceContentId);
  const target = envelope.contents.find(item => item.contentId === targetContentId);
  if(!source || !target) fail('BINDING_CONTENT_NOT_FOUND');
  const allowed = new Set([source.evidenceId, target.evidenceId]);
  return unique([
    source.evidenceId,
    target.evidenceId,
    ...binding.evidenceRefs.filter(evidenceId => allowed.has(evidenceId))
  ]);
}

function requireTextPayload(envelope: IngestionEnvelope, evidenceId: string, payloads: IngestionPayloads): string {
  const record = envelope.evidence.find(item => item.evidenceId === evidenceId);
  if(!record || record.lifecycleState === 'deleted' || record.modality === 'image') fail('TEXT_EVIDENCE_REQUIRED');
  const text = payloads.textByEvidenceId[evidenceId];
  if(text === undefined) fail('MISSING_TEXT_PAYLOAD');
  if(Buffer.byteLength(text, 'utf8') !== record.byteLength) fail('SOURCE_LENGTH_MISMATCH');
  if(textHash(text) !== record.sourceHash) fail('SOURCE_HASH_MISMATCH');
  return text;
}

function associationForBinding(binding: EvidenceBinding, targetContentId: string, envelope: IngestionEnvelope): AssociationCandidate {
  return AssociationCandidateSchema.parse({
    associationId: `assoc_${digest([INGESTION_ORGANIZATION_ADAPTER_VERSION, binding.bindingId, targetContentId]).slice(7, 31)}`,
    fromContentId: binding.sourceContentId,
    toContentId: targetContentId,
    relation: 'supports',
    source: 'user_explicit',
    status: binding.state === 'active' ? 'user_confirmed' : 'rejected',
    method: binding.method,
    evidenceRefs: pairEvidenceRefs(binding, targetContentId, envelope),
    createdAt: binding.createdAt
  });
}

function candidateForBinding(binding: EvidenceBinding, targetContentId: string, envelope: IngestionEnvelope): RetrievalCandidate {
  return RetrievalCandidateSchema.parse({
    schemaVersion: HYBRID_SCHEMA_VERSION,
    contractVersion: HYBRID_CONTRACT_VERSION,
    candidateId: `candidate_${digest([INGESTION_ORGANIZATION_ADAPTER_VERSION, binding.bindingId, targetContentId]).slice(7, 31)}`,
    scope: envelope.scope,
    fromContentId: binding.sourceContentId,
    toContentId: targetContentId,
    relation: 'related',
    rank: 1,
    stageDecision: 'unknown',
    method: binding.method,
    coverage: 'selected',
    reasons: ['ai_binding_candidate', 'not_user_confirmed'],
    featureRefs: [],
    evidenceRefs: pairEvidenceRefs(binding, targetContentId, envelope),
    createdAt: binding.createdAt
  });
}

export function adaptIngestionForOrganization(raw: unknown, payloads: IngestionPayloads): IngestionOrganizationOutput {
  const envelope = parseIngestionEnvelope(raw);
  const contents = envelope.contents.map(item => {
    const originalText = item.lifecycleState === 'active' && item.modality !== 'image'
      ? requireTextPayload(envelope, item.evidenceId, payloads)
      : undefined;
    return ContentItemSchema.parse({
      contentId: item.contentId,
      scope: envelope.scope,
      modality: item.modality === 'image' ? 'photo' : item.modality,
      evidenceIds: [item.evidenceId],
      ...(originalText !== undefined ? { originalText } : {}),
      lifecycle: item.lifecycleState === 'active' ? 'active' : 'withdrawn'
    });
  });
  const explicitAssociations: AssociationCandidate[] = [];
  const retrievalCandidates: RetrievalCandidate[] = [];
  const batchBindings: BatchEvidenceBinding[] = [];

  for(const binding of envelope.bindings) {
    if(binding.target.kind === 'batch') {
      batchBindings.push({
        bindingId: binding.bindingId,
        sourceContentId: binding.sourceContentId,
        authority: binding.authority,
        state: binding.state,
        evidenceRefs: [...binding.evidenceRefs]
      });
      continue;
    }
    for(const targetContentId of binding.target.contentIds) {
      if(binding.authority === 'user_explicit') explicitAssociations.push(associationForBinding(binding, targetContentId, envelope));
      else retrievalCandidates.push(candidateForBinding(binding, targetContentId, envelope));
    }
  }

  return {
    envelope,
    contents,
    explicitAssociations,
    retrievalCandidates,
    batchBindings,
    audit: {
      adapterVersion: INGESTION_ORGANIZATION_ADAPTER_VERSION,
      ingestionId: envelope.ingestionId,
      contentCount: contents.length,
      authoritativePairCount: explicitAssociations.length,
      aiCandidatePairCount: retrievalCandidates.length,
      preservedBatchBindingCount: batchBindings.length
    }
  };
}
