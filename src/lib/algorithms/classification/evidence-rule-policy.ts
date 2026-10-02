import {
  DecisionPolicySchema,
  HYBRID_CONTRACT_VERSION,
  HYBRID_SCHEMA_VERSION,
  type DecisionPolicy
} from './hybrid-contract';

export const ACTIVE_EVIDENCE_RULE_POLICY_VERSION = 'classification-active-evidence-rules.1';
export const ACTIVE_EVIDENCE_RULE_RISK_POLICY_VERSION = 'impact-risk.1';

export interface ActiveEvidenceRulePolicyInput {
  maxCandidatesPerContent: number;
  createdAt: string;
}

/**
 * The single active policy used by the live lab executor, bounded real smoke,
 * and offline replay. Retrieval ranks candidates; evidence rules decide how a
 * candidate affects organization without treating a heuristic as probability.
 */
export function buildActiveEvidenceRulePolicy(
  input: ActiveEvidenceRulePolicyInput
): DecisionPolicy {
  return DecisionPolicySchema.parse({
    schemaVersion: HYBRID_SCHEMA_VERSION,
    contractVersion: HYBRID_CONTRACT_VERSION,
    policyVersion: ACTIVE_EVIDENCE_RULE_POLICY_VERSION,
    mode: 'active',
    decisionMode: 'evidence_rules',
    calibrated: false,
    maxCandidatesPerContent: input.maxCandidatesPerContent,
    riskPolicyVersion: ACTIVE_EVIDENCE_RULE_RISK_POLICY_VERSION,
    createdAt: input.createdAt
  });
}

/**
 * Review items must come from an explicit provider, composition, or organizer
 * decision. Diagnostic observations (for example an unresolved time role) stay
 * available to the caller but are not implicitly converted into user tasks.
 */
export function collectEvidenceRuleReviewItems(
  ...sources: ReadonlyArray<readonly string[] | undefined>
): string[] {
  return [...new Set(sources.flatMap(source => source ?? []))].sort();
}
