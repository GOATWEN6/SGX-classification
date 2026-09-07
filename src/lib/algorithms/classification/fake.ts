import type { AlgorithmProvider } from './provider';
import { createHash } from 'node:crypto';
import { failureResult } from './provider';
import { validateProviderRequest } from './guards';
import type { ClassificationAssertion, ClassificationFacet, ClassificationProviderRequest,
  ClassificationProviderResult, MinimalAuthorizedEvidenceRef, ProviderErrorCode, VersionStamp } from './types';

export const FakeScenarios = ['success', 'needs_review', 'conflicted', 'timeout', 'failed', 'invalid_output', 'partial_failure'] as const;
export type FakeScenario = typeof FakeScenarios[number];
export const FAKE_VERSIONS: VersionStamp = {
  schemaVersion: '1.0', algorithmVersion: 'fake-classification.1', providerVersion: 'fake.1',
  modelVersion: 'none', promptVersion: 'none', taxonomyVersion: 'fixture-taxonomy.1',
};
const timestamp = '2026-09-07T00:00:00Z';
const identifier = (request: ClassificationProviderRequest, suffix: string) =>
  `fake_${createHash('sha256').update(JSON.stringify([request.jobId, request.runId, suffix])).digest('hex')}`;

/** Synthetic candidates only. Never reads media, extracts facts, calls models or writes a database. */
export class FakeClassificationProvider implements AlgorithmProvider {
  private readonly pending = new Map<string, () => void>();
  constructor(private readonly options: { scenario: FakeScenario; failureCode?: ProviderErrorCode }) {
    if (!FakeScenarios.includes(options.scenario)) throw new Error('UNKNOWN_FAKE_SCENARIO');
  }

  cancel(runId: string): void { this.pending.get(runId)?.(); }

  async classify(input: ClassificationProviderRequest, { signal }: { signal: AbortSignal }): Promise<unknown> {
    const request = validateProviderRequest(input);
    if (Object.keys(FAKE_VERSIONS).some(k => request.versions[k as keyof VersionStamp] !== FAKE_VERSIONS[k as keyof VersionStamp])) {
      return failureResult(request, 'UNSUPPORTED_INPUT');
    }
    if (signal.aborted) return failureResult(request, 'CANCELLED');
    const { scenario } = this.options;
    if (scenario === 'timeout') {
      if (this.pending.has(request.runId)) return failureResult(request, 'INTERNAL_ERROR');
      return new Promise(resolve => {
        const finish = () => {
          this.pending.delete(request.runId);
          signal.removeEventListener('abort', finish);
          resolve(failureResult(request, 'CANCELLED'));
        };
        this.pending.set(request.runId, finish);
        signal.addEventListener('abort', finish, { once: true });
      });
    }
    if (scenario === 'failed') return failureResult(request, this.options.failureCode ?? 'PROVIDER_UNAVAILABLE');
    const result: ClassificationProviderResult = { schemaVersion: '1.0', runId: request.runId, jobId: request.jobId,
      subjectId: request.subjectId, householdId: request.householdId, inputHash: request.inputHash,
      versions: { ...request.versions }, status: scenario === 'success' || scenario === 'invalid_output' ? 'succeeded' : 'needs_review',
      assertions: [], abstentions: [], facetErrors: [], usage: { latencyMs: 0, inputUnits: request.evidence.length, outputUnits: 0 } };
    for (const [index, facet] of request.requestedFacets.entries()) {
      if (scenario === 'partial_failure' && index === request.requestedFacets.length - 1) {
        result.facetErrors.push({ facet, code: 'PROVIDER_UNAVAILABLE' });
        continue;
      }
      if (facet === 'duplicate' && request.evidence.filter(e => e.modality === 'image').length < 2) {
        result.abstentions.push({ facet, reason: 'no_assertion' });
        result.status = 'needs_review';
        continue;
      }
      const assertion = this.assertion(request, facet, index, 0);
      if (scenario === 'needs_review') assertion.confidence = 0.2;
      if (scenario === 'conflicted' && index === 0) {
        assertion.state = 'conflicted';
        assertion.conflictGroupId = identifier(request, 'conflict');
        const other = this.assertion(request, facet, index, 1);
        other.state = 'conflicted'; other.conflictGroupId = assertion.conflictGroupId;
        result.assertions.push(assertion, other);
      } else result.assertions.push(assertion);
    }
    result.usage.outputUnits = result.assertions.length;
    // Deliberately violate the wire contract, for the validation/quarantine path.
    if (scenario === 'invalid_output') return { ...result, visibility: 'public' };
    return result;
  }

  private assertion(request: ClassificationProviderRequest, facet: ClassificationFacet, index: number, variant: number): ClassificationAssertion {
    let selected: MinimalAuthorizedEvidenceRef[];
    if (facet === 'duplicate') selected = request.evidence.filter(e => e.modality === 'image').slice(0, 2);
    else if (facet === 'person') selected = [request.evidence.find(e => e.modality !== 'image') ?? request.evidence[0]];
    else selected = [request.evidence[variant % request.evidence.length]];
    const base = { schemaVersion: '1.0' as const, assertionId: identifier(request, `assertion_${index}_${variant}`),
      jobId: request.jobId, subjectId: request.subjectId, householdId: request.householdId,
      evidenceRefs: selected.map(e => e.evidenceId), rawValue: `合成契约样例 ${facet} ${variant}`,
      confidence: 0.9, supports: selected.map(e => ({ evidenceId: e.evidenceId,
        sourceType: e.modality === 'image' ? 'visual' as const : e.modality === 'text' ? 'user_text' as const : 'final_asr' as const,
        producerVersion: 'fake.1' })), state: 'proposed' as const, sensitivity: 'standard' as const,
      versions: { ...request.versions }, inputHash: request.inputHash, revision: 1, createdAt: timestamp, updatedAt: timestamp };
    if (facet === 'person') return { ...base, facet, normalizedValue: selected[0].modality === 'image' ?
      { kind: 'face_region', faceRegionId: identifier(request, `face_${variant}`), evidenceId: selected[0].evidenceId,
        region: { x: 0.1 + variant * 0.2, y: 0.1, width: 0.2, height: 0.2 } } :
      { kind: 'text_mention', mention: `合成人物提及${variant}` } };
    if (facet === 'duplicate') return { ...base, facet, normalizedValue: { relation: variant ? 'near' : 'exact', targetEvidenceId: selected[1].evidenceId } };
    return { ...base, facet, normalizedValue: { namespace: 'fixture-only', value: `sample_${facet}_${variant}` } };
  }
}
