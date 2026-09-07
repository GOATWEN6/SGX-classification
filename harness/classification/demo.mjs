import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const compiled = `${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification`;
const { prepareProviderRequest } = require(`${compiled}/guards.js`);
const { executeProvider } = require(`${compiled}/provider.js`);
const { FakeClassificationProvider, FakeScenarios, FAKE_VERSIONS } = require(`${compiled}/fake.js`);
const scenario = process.argv[2] ?? 'success';
if (!FakeScenarios.includes(scenario)) throw new Error(`Scenario must be one of ${FakeScenarios.join(', ')}`);
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/positive-v1.json', import.meta.url)));
const evidence = ['image', 'text', 'transcript'].map(k => fixtures.evidenceRecords[k]);
const bundle = { ...fixtures.contentBundle, evidence };
// Synthetic stand-in only. Real callers obtain this from the backend authorization service.
const context = { actorId: bundle.actorId, subjectId: bundle.subjectId, householdId: bundle.householdId,
  authorityRef: 'synthetic_processing_authority', allowedEvidenceIds: evidence.map(e => e.evidenceId),
  allowedConsentRefs: ['consent_demo'], biometricConsentRefs: [] };
const request = prepareProviderRequest(bundle, { jobId: 'job_demo', runId: 'run_demo',
  versions: FAKE_VERSIONS, requestedFacets: ['time', 'place', 'person', 'event'],
  config: { anonymousClustersEnabled: false, relevantConfigHash: `sha256:${'d'.repeat(64)}` },
  deadlineAt: new Date(Date.now() + 5000).toISOString() }, context);
const result = await executeProvider(request, new FakeClassificationProvider({ scenario }), { maxDurationMs: scenario === 'timeout' ? 50 : 1000 });
console.log(JSON.stringify({ evidenceStatus: 'synthetic_contract_only', scenario, request, result }, null, 2));
