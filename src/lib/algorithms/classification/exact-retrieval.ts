import { z } from 'zod';
import {
  AssociationCandidateSchema,
  ContentItemSchema,
  ContentObservationSchema,
  type AssociationCandidate,
  type ContentItem,
  type ContentObservation,
  type Scope,
  validateOrganizationInput
} from './content-organization';
import {
  HYBRID_CONTRACT_VERSION,
  HYBRID_SCHEMA_VERSION,
  RetrievalCandidateSchema,
  type RetrievalCandidate
} from './hybrid-contract';
import { digest } from './stage-a-contract';

export const EXACT_RETRIEVAL_VERSION = 'exact-observation-retrieval.2';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const dateTime = z.string().datetime({ offset: true });
const scope = z.object({ householdId: id, subjectId: id }).strict();

export const ExactRetrievalInputSchema = z.object({
  schemaVersion: z.literal(HYBRID_SCHEMA_VERSION),
  contractVersion: z.literal(HYBRID_CONTRACT_VERSION),
  scope,
  contents: z.array(ContentItemSchema).min(1).max(5000),
  observations: z.array(ContentObservationSchema).max(30000),
  explicitAssociations: z.array(AssociationCandidateSchema).max(30000).default([]),
  maxCandidatesPerContent: z.number().int().min(1).max(128),
  includeZeroSignalFallback: z.boolean().default(true),
  createdAt: dateTime
}).strict();

export const ExactRetrievalTraceSchema = z.object({
  sourceContentId: id,
  eligibleCount: z.number().int().nonnegative().max(5000),
  selectedCandidateIds: z.array(id).max(128),
  omittedContentIds: z.array(id).max(5000),
  coverage: z.enum(['complete', 'truncated']),
  fallbackUsed: z.boolean()
}).strict();

export const ExactRetrievalResultSchema = z.object({
  version: z.literal(EXACT_RETRIEVAL_VERSION),
  scope,
  candidates: z.array(RetrievalCandidateSchema).max(30000),
  traces: z.array(ExactRetrievalTraceSchema).max(5000),
  audit: z.object({
    activeContentCount: z.number().int().nonnegative().max(5000),
    comparisonCount: z.number().int().nonnegative(),
    candidateCount: z.number().int().nonnegative().max(30000),
    pairMaterialized: z.literal(false),
    maxCandidatesPerContent: z.number().int().min(1).max(128),
    scoreMeaning: z.literal('retrieval_heuristic_not_probability')
  }).strict()
}).strict();

export type ExactRetrievalInput = z.infer<typeof ExactRetrievalInputSchema>;
export type ExactRetrievalTrace = z.infer<typeof ExactRetrievalTraceSchema>;
export type ExactRetrievalResult = z.infer<typeof ExactRetrievalResultSchema>;

type IndexedContent = {
  content: ContentItem;
  facets: Map<ContentObservation['facet'], Set<string>>;
  conflictedFacets: Set<ContentObservation['facet']>;
  evidenceRefs: string[];
};

const retrievalFacets: ContentObservation['facet'][] = ['time', 'place', 'event', 'person', 'theme'];

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function normalized(observation: ContentObservation): string {
  return (observation.normalizedValue ?? observation.rawValue).normalize('NFKC').trim().toLocaleLowerCase();
}
function explicitPair(association: AssociationCandidate): string | undefined {
  return association.toContentId ? [association.fromContentId, association.toContentId].sort().join('/') : undefined;
}
function pairId(left: string, right: string): string { return [left, right].sort().join('/'); }

function indexContents(contents: ContentItem[], observations: ContentObservation[]): Map<string, IndexedContent> {
  const result = new Map<string, IndexedContent>();
  for(const content of contents.filter(item => item.lifecycle === 'active')) {
    result.set(content.contentId, {
      content,
      facets: new Map(),
      conflictedFacets: new Set(),
      evidenceRefs: [...content.evidenceIds]
    });
  }
  for(const observation of observations) {
    const indexed = result.get(observation.contentId);
    if(!indexed) continue;
    if(observation.state === 'conflicted') indexed.conflictedFacets.add(observation.facet);
    if(observation.state === 'candidate') {
      const values = indexed.facets.get(observation.facet) ?? new Set<string>();
      values.add(normalized(observation));
      indexed.facets.set(observation.facet, values);
    }
    indexed.evidenceRefs.push(observation.evidenceId, ...observation.supports.map(support => support.evidenceId));
  }
  for(const indexed of result.values()) indexed.evidenceRefs = unique(indexed.evidenceRefs);
  return result;
}

function intersects(left: Set<string> | undefined, right: Set<string> | undefined): boolean {
  if(!left || !right) return false;
  for(const value of left) if(right.has(value)) return true;
  return false;
}

function retrievalSignals(left: IndexedContent, right: IndexedContent): { tier: number; reasons: string[]; conflicted: boolean } {
  const reasons: string[] = [];
  const matched = new Set<ContentObservation['facet']>();
  for(const facet of retrievalFacets) {
    if(intersects(left.facets.get(facet), right.facets.get(facet))) {
      matched.add(facet);
      reasons.push(`${facet}_overlap`);
    }
  }
  const conflicted = retrievalFacets.some(facet => left.conflictedFacets.has(facet) || right.conflictedFacets.has(facet));
  if(conflicted) reasons.push('conflict_present');
  // Ordered recall lanes, not an additive score. A lane only chooses which
  // candidates are worth further inspection and never authorizes a merge.
  const event = matched.has('event');
  const time = matched.has('time');
  const place = matched.has('place');
  const person = matched.has('person');
  const theme = matched.has('theme');
  const tier = event && time && place ? 0
    : event && (time || place) ? 1
      : event ? 2
        : time && place ? 3
          : person && (time || place || theme) ? 4
            : matched.size > 0 ? 5
              : 6;
  return { tier, reasons, conflicted };
}

function evidenceRefs(left: IndexedContent, right: IndexedContent): string[] {
  const required = [left.content.evidenceIds[0], right.content.evidenceIds[0]];
  return unique([...required, ...left.evidenceRefs, ...right.evidenceRefs]).slice(0, 64);
}

/**
 * Deterministic T0 baseline. It scans exact observation matches in memory but
 * only emits sparse top-K candidates. Categorical recall lanes order candidates;
 * they do not estimate relation confidence or authorize product actions.
 */
export function retrieveExactCandidates(raw: unknown): ExactRetrievalResult {
  const input = ExactRetrievalInputSchema.parse(raw);
  validateOrganizationInput({
    scope: input.scope,
    contents: input.contents,
    observations: input.observations,
    explicitAssociations: input.explicitAssociations,
    createdAt: input.createdAt,
    config: {}
  });
  const indexed = indexContents(input.contents, input.observations);
  const contentIds = [...indexed.keys()].sort();
  const blockedPairs = new Set(input.explicitAssociations.map(explicitPair).filter((value): value is string => Boolean(value)));
  const emittedPairs = new Set<string>();
  const candidates: RetrievalCandidate[] = [];
  const traces: ExactRetrievalTrace[] = [];
  let comparisonCount = 0;

  for(const sourceContentId of contentIds) {
    const source = indexed.get(sourceContentId)!;
    const ranked = contentIds.flatMap(targetContentId => {
      if(targetContentId === sourceContentId || blockedPairs.has(pairId(sourceContentId, targetContentId))) return [];
      const target = indexed.get(targetContentId)!;
      comparisonCount += 1;
      const signals = retrievalSignals(source, target);
      if(!input.includeZeroSignalFallback && signals.tier === 6) return [];
      return [{ targetContentId, target, ...signals }];
    }).sort((left, right) => left.tier - right.tier || left.targetContentId.localeCompare(right.targetContentId));

    const selectedCandidateIds: string[] = [];
    const selectedContentIds = new Set<string>();
    let fallbackUsed = false;
    for(const item of ranked) {
      if(selectedCandidateIds.length >= input.maxCandidatesPerContent) break;
      const pair = pairId(sourceContentId, item.targetContentId);
      if(emittedPairs.has(pair)) continue;
      emittedPairs.add(pair);
      selectedContentIds.add(item.targetContentId);
      const fallback = item.tier === 6;
      fallbackUsed ||= fallback;
      const candidate = RetrievalCandidateSchema.parse({
        schemaVersion: HYBRID_SCHEMA_VERSION,
        contractVersion: HYBRID_CONTRACT_VERSION,
        candidateId: `candidate_${digest([EXACT_RETRIEVAL_VERSION, pair]).slice(7, 31)}`,
        scope: input.scope,
        fromContentId: sourceContentId,
        toContentId: item.targetContentId,
        relation: 'same_story',
        rank: selectedCandidateIds.length + 1,
        method: EXACT_RETRIEVAL_VERSION,
        coverage: fallback ? 'fallback' : 'selected',
        reasons: item.reasons.length ? item.reasons : ['zero_signal_fallback'],
        featureRefs: [],
        evidenceRefs: evidenceRefs(source, item.target),
        createdAt: input.createdAt
      });
      candidates.push(candidate);
      selectedCandidateIds.push(candidate.candidateId);
    }
    const omittedContentIds = ranked.map(item => item.targetContentId).filter(contentId => !selectedContentIds.has(contentId));
    traces.push(ExactRetrievalTraceSchema.parse({
      sourceContentId,
      eligibleCount: ranked.length,
      selectedCandidateIds,
      omittedContentIds,
      coverage: omittedContentIds.length ? 'truncated' : 'complete',
      fallbackUsed
    }));
  }

  return ExactRetrievalResultSchema.parse({
    version: EXACT_RETRIEVAL_VERSION,
    scope: input.scope,
    candidates,
    traces,
    audit: {
      activeContentCount: contentIds.length,
      comparisonCount,
      candidateCount: candidates.length,
      pairMaterialized: false,
      maxCandidatesPerContent: input.maxCandidatesPerContent,
      scoreMeaning: 'retrieval_heuristic_not_probability'
    }
  });
}
