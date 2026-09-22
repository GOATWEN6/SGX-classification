import { readFileSync } from 'node:fs';
const fixtures = JSON.parse(readFileSync(new URL('../positive-v1.json', import.meta.url)));
export const scopeKey = scope => JSON.stringify([scope.householdId, scope.subjectId]);
// Trusted test-process configuration, NEVER constructed from an HTTP body.
export function syntheticState(versions, scope = { householdId: 'household_demo', subjectId: 'subject_demo' }) {
  const evidence = ['image', 'text', 'transcript'].map(k => ({ ...structuredClone(fixtures.evidenceRecords[k]), ...scope, visibility: 'private' }));
  return { authorizationRevision: 'auth-rev-1', authorizationState: 'active', versions: structuredClone(versions), evidence,
    cancelledRuns: new Set(), authorization: { actorId: 'actor_demo', ...scope, authorityRef: 'synthetic_authority',
      allowedEvidenceIds: evidence.map(e => e.evidenceId), allowedConsentRefs: ['consent_demo'], biometricConsentRefs: [] } };
}
export function syntheticEnvelope(prepare, state, overrides = {}) {
  const { subjectId, householdId, actorId } = state.authorization;
  const bundle = { schemaVersion: '1.0', bundleId: 'bundle_demo', actorId, subjectId, householdId, evidence: state.evidence };
  const providerRequest = prepare(bundle, { jobId: 'job_http', runId: 'run_http', versions: state.versions,
    requestedFacets: ['time', 'place', 'person', 'event'], config: { anonymousClustersEnabled: false, relevantConfigHash: `sha256:${'d'.repeat(64)}` },
    deadlineAt: new Date(Date.now() + 30000).toISOString(), ...overrides }, state.authorization);
  return structuredClone({ protocolVersion: 'classification-http.v1', requestId: 'request_http', purpose: 'classification',
    scope: { subjectId, householdId }, authorizationRevision: state.authorizationRevision,
    deadlineAt: providerRequest.deadlineAt, providerRequest });
}
