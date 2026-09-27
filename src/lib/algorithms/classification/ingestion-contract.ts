import { z } from 'zod';
import type { EvidenceRecord } from './types';
import { parseContract } from './validation';

export const INGESTION_SPEC_VERSION = '2.0.0';
export const INGESTION_CONTRACT_VERSION = 'classification-ingestion.2';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const dateTime = z.string().datetime({ offset: true });
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

export const IngestionScopeSchema = z.object({ householdId: id, subjectId: id }).strict();

export const IngestionContextSchema = z.object({
  kind: z.enum(['album_upload', 'family_transfer']),
  senderId: id.optional(),
  recipientIds: z.array(id).min(1).max(100).refine(unique, 'DUPLICATE_RECIPIENT').optional()
}).strict().superRefine((value, ctx) => {
  if(value.kind === 'family_transfer' && (!value.senderId || !value.recipientIds?.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FAMILY_TRANSFER_PARTIES_REQUIRED' });
  }
  if(value.kind === 'album_upload' && (value.senderId || value.recipientIds)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ALBUM_UPLOAD_HAS_TRANSFER_PARTIES' });
  }
});

export const IngestionContentSchema = z.object({
  contentId: id,
  evidenceId: id,
  modality: z.enum(['image', 'user_text', 'final_asr']),
  lifecycleState: z.enum(['active', 'withdrawn'])
}).strict();

export const EvidenceBindingSchema = z.object({
  bindingId: id,
  sourceContentId: id,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('batch') }).strict(),
    z.object({ kind: z.literal('contents'), contentIds: z.array(id).min(1).max(5000).refine(unique, 'DUPLICATE_TARGET_CONTENT') }).strict()
  ]),
  authority: z.enum(['user_explicit', 'ai_candidate']),
  state: z.enum(['active', 'withdrawn']),
  method: id,
  evidenceRefs: z.array(id).min(1).max(64).refine(unique, 'DUPLICATE_EVIDENCE_REF'),
  createdAt: dateTime
}).strict().superRefine((value, ctx) => {
  if(value.authority === 'ai_candidate' && value.target.kind !== 'contents') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'AI_BINDING_REQUIRES_CONTENT_TARGETS' });
  }
});

export const IngestionEnvelopeStructureSchema = z.object({
  specVersion: z.literal(INGESTION_SPEC_VERSION),
  contractVersion: z.literal(INGESTION_CONTRACT_VERSION),
  ingestionId: id,
  batchId: id,
  scope: IngestionScopeSchema,
  actorId: id,
  context: IngestionContextSchema,
  authorizationRevision: id,
  taxonomyVersion: id,
  purposes: z.array(z.enum(['classification', 'album_organization', 'search_candidate', 'interview_candidate'])).min(1).max(4).refine(unique, 'DUPLICATE_PURPOSE'),
  evidence: z.array(z.unknown()).min(1).max(5000),
  contents: z.array(IngestionContentSchema).min(1).max(5000),
  bindings: z.array(EvidenceBindingSchema).max(10000),
  reviewPolicy: z.object({
    policyVersion: z.literal('family-inbox.1'),
    remindAfterDays: z.literal(3),
    hideFromHomeAfterDays: z.literal(7),
    highRiskRetention: z.literal('until_resolved')
  }).strict().optional(),
  createdAt: dateTime
}).strict();

export type IngestionContext = z.infer<typeof IngestionContextSchema>;
export type IngestionContent = z.infer<typeof IngestionContentSchema>;
export type EvidenceBinding = z.infer<typeof EvidenceBindingSchema>;
export type IngestionEnvelope = Omit<z.infer<typeof IngestionEnvelopeStructureSchema>, 'evidence'> & { evidence: EvidenceRecord[] };

export class IngestionContractError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function fail(code: string): never { throw new IngestionContractError(code); }
function evidenceModality(record: EvidenceRecord): IngestionContent['modality'] | 'deleted' {
  if(record.lifecycleState === 'deleted') return 'deleted';
  if(record.modality === 'transcript') return 'final_asr';
  if(record.modality === 'text') return 'user_text';
  return 'image';
}
function bindingFingerprint(binding: EvidenceBinding): string {
  const target = binding.target.kind === 'batch'
    ? 'batch'
    : `contents:${[...binding.target.contentIds].sort().join(',')}`;
  return [binding.sourceContentId, target, binding.authority, binding.state].join('/');
}

export function parseIngestionEnvelope(raw: unknown): IngestionEnvelope {
  const structure = IngestionEnvelopeStructureSchema.parse(raw);
  if(!structure.purposes.includes('classification') || !structure.purposes.includes('album_organization')) {
    fail('REQUIRED_PURPOSE_MISSING');
  }
  if(structure.context.kind === 'family_transfer' && !structure.reviewPolicy) fail('FAMILY_TRANSFER_REVIEW_POLICY_REQUIRED');
  if(structure.context.kind === 'album_upload' && structure.reviewPolicy) fail('ALBUM_UPLOAD_REVIEW_POLICY_NOT_APPLICABLE');

  const evidence = structure.evidence.map(value => parseContract('EvidenceRecord', value));
  const evidenceById = new Map<string, EvidenceRecord>();
  for(const record of evidence) {
    if(evidenceById.has(record.evidenceId)) fail('DUPLICATE_EVIDENCE');
    evidenceById.set(record.evidenceId, record);
    if(record.householdId !== structure.scope.householdId || record.subjectId !== structure.scope.subjectId) fail('CROSS_SCOPE');
  }

  const contentById = new Map<string, IngestionContent>();
  const usedEvidence = new Set<string>();
  for(const content of structure.contents) {
    if(contentById.has(content.contentId)) fail('DUPLICATE_CONTENT');
    if(usedEvidence.has(content.evidenceId)) fail('EVIDENCE_USED_BY_MULTIPLE_CONTENTS');
    contentById.set(content.contentId, content);
    usedEvidence.add(content.evidenceId);
    const record = evidenceById.get(content.evidenceId);
    if(!record) fail('MISSING_CONTENT_EVIDENCE');
    const modality = evidenceModality(record);
    if(modality !== content.modality && !(content.lifecycleState === 'withdrawn' && modality === 'deleted')) fail('CONTENT_MODALITY_MISMATCH');
    if(content.lifecycleState === 'active' && record.lifecycleState !== 'active') fail('INACTIVE_EVIDENCE');
    if(content.lifecycleState === 'withdrawn' && record.lifecycleState === 'active') fail('WITHDRAWN_CONTENT_HAS_ACTIVE_EVIDENCE');
  }
  if(evidence.some(record => !usedEvidence.has(record.evidenceId))) fail('UNBOUND_EVIDENCE');

  const bindingIds = new Set<string>();
  const authoritativeBindings = new Map<string, number>();
  const bindingFingerprints = new Set<string>();
  for(const binding of structure.bindings) {
    if(bindingIds.has(binding.bindingId)) fail('DUPLICATE_BINDING');
    bindingIds.add(binding.bindingId);
    const source = contentById.get(binding.sourceContentId);
    if(!source || source.lifecycleState !== 'active') fail('BINDING_SOURCE_INACTIVE_OR_MISSING');
    if(source.modality === 'image') fail('IMAGE_CANNOT_BE_BINDING_SOURCE');
    if(!binding.evidenceRefs.includes(source.evidenceId)) fail('BINDING_MISSING_SOURCE_EVIDENCE');
    if(binding.evidenceRefs.some(ref => !evidenceById.has(ref))) fail('FOREIGN_BINDING_EVIDENCE');
    if(binding.target.kind === 'contents') {
      for(const targetId of binding.target.contentIds) {
        const target = contentById.get(targetId);
        if(!target || target.lifecycleState !== 'active') fail('BINDING_TARGET_INACTIVE_OR_MISSING');
        if(targetId === source.contentId) fail('SELF_BINDING');
      }
    }
    if(binding.authority === 'user_explicit' && binding.state === 'active') {
      authoritativeBindings.set(source.contentId, (authoritativeBindings.get(source.contentId) ?? 0) + 1);
    }
    const fingerprint = bindingFingerprint(binding);
    if(bindingFingerprints.has(fingerprint)) fail('DUPLICATE_BINDING_SEMANTICS');
    bindingFingerprints.add(fingerprint);
  }
  for(const content of structure.contents.filter(item => item.lifecycleState === 'active' && item.modality !== 'image')) {
    const count = authoritativeBindings.get(content.contentId) ?? 0;
    if(count === 0) fail('MISSING_AUTHORITATIVE_BINDING');
    if(count > 1) fail('MULTIPLE_AUTHORITATIVE_BINDINGS');
  }

  return { ...structure, evidence } as IngestionEnvelope;
}
