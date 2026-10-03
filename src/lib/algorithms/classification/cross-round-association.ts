import { z } from 'zod';

import {
  ContentItemSchema,
  type ContentItem,
  type Scope,
} from './content-organization';
import {
  HistoricalRetrievalCandidateSchema,
} from './historical-retrieval';
import { digest } from './stage-a-contract';

export const CROSS_ROUND_ASSOCIATION_VERSION = 'classification-cross-round-association.1' as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });
const scope = z.object({ householdId: id, subjectId: id }).strict();

/**
 * A cross-round association is a low-impact retrieval candidate. It may help
 * search and album suggestions, but it is never an identity, relationship,
 * same-event claim, or grouping edge by itself.
 */
export const CrossRoundAssociationCandidateSchema = z.object({
  version: z.literal(CROSS_ROUND_ASSOCIATION_VERSION),
  associationId: id,
  scope,
  authorizationRevision: id,
  sourceContentId: id,
  sourceEvidenceId: id,
  historicalContentId: id,
  historicalEvidenceId: id,
  relation: z.literal('possibly_related'),
  authority: z.literal('ai_candidate'),
  status: z.literal('candidate_only'),
  decisionBasis: z.literal('retrieval_only'),
  method: z.enum(['image_text_embedding_topk', 'authorized_face_embedding_topk']),
  rank: z.number().int().positive().max(32),
  model: z.object({ id, revision: id }).strict(),
  reasons: z.array(id).min(1).max(8),
  currentEvidenceRefs: z.array(id).min(1).max(32),
  historicalEvidenceRefs: z.array(id).min(1).max(32),
  historicalProjectionDigest: hash,
  personBasis: z.enum(['not_applicable', 'consent_gated_anonymous_candidate']),
  allowedUses: z.tuple([
    z.literal('album_suggestion'),
    z.literal('search_candidate'),
  ]),
  createdAt: dateTime,
}).strict().superRefine((value, ctx) => {
  if(!value.currentEvidenceRefs.includes(value.sourceEvidenceId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CURRENT_EVIDENCE_REF_MISSING' });
  }
  if(!value.historicalEvidenceRefs.includes(value.historicalEvidenceId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'HISTORICAL_EVIDENCE_REF_MISSING' });
  }
  if(value.sourceEvidenceId === value.historicalEvidenceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CROSS_ROUND_SELF_REFERENCE' });
  }
  if(value.method === 'authorized_face_embedding_topk'
    && value.personBasis !== 'consent_gated_anonymous_candidate') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PERSON_BASIS_REQUIRED' });
  }
  if(value.method === 'image_text_embedding_topk' && value.personBasis !== 'not_applicable') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PERSON_BASIS_NOT_APPLICABLE' });
  }
});

export type CrossRoundAssociationCandidate = z.infer<typeof CrossRoundAssociationCandidateSchema>;
type HistoricalRetrievalCandidate = z.infer<typeof HistoricalRetrievalCandidateSchema>;

export interface BuildCrossRoundAssociationsInput {
  scope: Scope;
  authorizationRevision: string;
  contents: readonly ContentItem[];
  candidates: readonly unknown[];
  createdAt: string;
}

function canonical(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildCrossRoundAssociations(
  raw: BuildCrossRoundAssociationsInput,
): CrossRoundAssociationCandidate[] {
  const contents = raw.contents.map(value => ContentItemSchema.parse(value));
  const contentById = new Map(contents.map(value => [value.contentId, value]));
  const seenCandidateIds = new Set<string>();
  const candidates = raw.candidates
    .map(value => HistoricalRetrievalCandidateSchema.parse(value))
    .sort((left, right) => (
      left.sourceContentId.localeCompare(right.sourceContentId)
      || left.rank - right.rank
      || left.kind.localeCompare(right.kind)
      || left.historicalContentId.localeCompare(right.historicalContentId)
      || left.candidateId.localeCompare(right.candidateId)
    ));

  return candidates.map(candidate => {
    if(seenCandidateIds.has(candidate.candidateId)) throw new Error('DUPLICATE_HISTORICAL_CANDIDATE');
    seenCandidateIds.add(candidate.candidateId);
    const source = contentById.get(candidate.sourceContentId);
    if(!source || source.lifecycle !== 'active' || source.modality !== 'photo'
      || !source.evidenceIds.includes(candidate.sourceEvidenceId)) {
      throw new Error('INVALID_HISTORICAL_CANDIDATE_SOURCE');
    }
    const face = candidate.kind === 'face_embedding';
    return CrossRoundAssociationCandidateSchema.parse({
      version: CROSS_ROUND_ASSOCIATION_VERSION,
      associationId: `cross_round_${digest([
        raw.authorizationRevision,
        candidate.candidateId,
        candidate.sourceContentId,
        candidate.historicalContentId,
      ]).slice(7, 31)}`,
      scope: raw.scope,
      authorizationRevision: raw.authorizationRevision,
      sourceContentId: candidate.sourceContentId,
      sourceEvidenceId: candidate.sourceEvidenceId,
      historicalContentId: candidate.historicalContentId,
      historicalEvidenceId: candidate.historicalEvidenceId,
      relation: 'possibly_related',
      authority: 'ai_candidate',
      status: 'candidate_only',
      decisionBasis: 'retrieval_only',
      method: face ? 'authorized_face_embedding_topk' : 'image_text_embedding_topk',
      rank: candidate.rank,
      model: { id: candidate.modelId, revision: candidate.modelRevision },
      reasons: canonical(candidate.reasons),
      currentEvidenceRefs: [candidate.sourceEvidenceId],
      historicalEvidenceRefs: [candidate.historicalEvidenceId],
      historicalProjectionDigest: digest(candidate.historicalProjection),
      personBasis: face ? 'consent_gated_anonymous_candidate' : 'not_applicable',
      allowedUses: ['album_suggestion', 'search_candidate'],
      createdAt: raw.createdAt,
    });
  });
}
