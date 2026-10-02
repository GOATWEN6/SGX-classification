import {
  ContentObservationSchema,
  organizeSparseContent,
  type ContentObservation,
  type SparseOrganizationResult
} from './content-organization';
import { retrieveExactCandidates } from './exact-retrieval';
import { adaptIngestionForOrganization, type IngestionPayloads } from './ingestion-organization-adapter';
import type { IngestionEnvelope } from './ingestion-contract';
import type { LabHighImpactClaim } from './lab-execution-contract';
import { DeterministicTextExtractor } from './text-extractor';

export type LabProviderMode = 'deterministic';

export interface LabProviderResult {
  provider: {
    mode: LabProviderMode;
    providerVersion: string;
    modelVersion: 'none';
    promptVersion: 'none';
    evidenceStatus: 'integration_baseline_only';
    accuracyClaim: 'not_evaluated';
  };
  organization: SparseOrganizationResult;
  observations: ContentObservation[];
  batchBindings: ReturnType<typeof adaptIngestionForOrganization>['batchBindings'];
  highImpactClaims: LabHighImpactClaim[];
  retrieval: {
    candidateCount: number;
    comparisonCount: number;
    maxCandidatesPerContent: number;
    scoreMeaning: 'retrieval_heuristic_not_probability';
  };
}

export interface ClassificationLabProvider {
  readonly mode: LabProviderMode;
  readonly version: string;
  run(envelope: IngestionEnvelope, payloads: IngestionPayloads): Promise<LabProviderResult>;
}

export class DeterministicLabProvider implements ClassificationLabProvider {
  readonly mode = 'deterministic' as const;
  readonly version = 'classification-lab-deterministic.1';

  async run(envelope: IngestionEnvelope, payloads: IngestionPayloads): Promise<LabProviderResult> {
    const adapted = adaptIngestionForOrganization(envelope, payloads);
    const extractor = new DeterministicTextExtractor();
    const observations = adapted.contents.flatMap(content => {
      if(content.lifecycle !== 'active') return [];
      if(content.modality === 'user_text' || content.modality === 'final_asr') {
        return extractor.extract({ scope: envelope.scope, content, taxonomyVersion: envelope.taxonomyVersion }).observations;
      }
      if(content.modality === 'photo') return [ContentObservationSchema.parse({
        contentId: content.contentId,
        evidenceId: content.evidenceIds[0],
        facet: 'content_type',
        rawValue: '照片',
        normalizedValue: 'photo',
        supports: [{ evidenceId: content.evidenceIds[0] }],
        state: 'candidate'
      })];
      return [];
    });
    const retrieval = retrieveExactCandidates({
      schemaVersion: '2.0',
      contractVersion: 'classification-hybrid.2',
      scope: envelope.scope,
      contents: adapted.contents,
      observations,
      explicitAssociations: adapted.explicitAssociations,
      maxCandidatesPerContent: 8,
      includeZeroSignalFallback: false,
      createdAt: envelope.createdAt
    });
    const organization = organizeSparseContent({
      schemaVersion: '2.0',
      contractVersion: 'classification-hybrid.2',
      scope: envelope.scope,
      contents: adapted.contents,
      observations,
      retrievalCandidates: [...adapted.retrievalCandidates, ...retrieval.candidates],
      explicitAssociations: adapted.explicitAssociations,
      decisionPolicy: {
        schemaVersion: '2.0',
        contractVersion: 'classification-hybrid.2',
        policyVersion: 'classification-lab-shadow.1',
        mode: 'shadow',
        decisionMode: 'evidence_rules',
        calibrated: false,
        maxCandidatesPerContent: 8,
        riskPolicyVersion: 'impact-risk.1',
        createdAt: envelope.createdAt
      },
      createdAt: envelope.createdAt
    });
    return {
      provider: {
        mode: this.mode,
        providerVersion: this.version,
        modelVersion: 'none',
        promptVersion: 'none',
        evidenceStatus: 'integration_baseline_only',
        accuracyClaim: 'not_evaluated'
      },
      organization,
      observations,
      batchBindings: adapted.batchBindings,
      highImpactClaims: [],
      retrieval: {
        candidateCount: retrieval.audit.candidateCount,
        comparisonCount: retrieval.audit.comparisonCount,
        maxCandidatesPerContent: retrieval.audit.maxCandidatesPerContent,
        scoreMeaning: retrieval.audit.scoreMeaning
      }
    };
  }
}

export function createConfiguredLabProvider(mode = process.env.CLASSIFICATION_LAB_PROVIDER ?? 'deterministic'): ClassificationLabProvider {
  if(mode === 'deterministic') return new DeterministicLabProvider();
  throw new Error('REAL_PROVIDER_ADAPTER_NOT_CONFIGURED');
}
