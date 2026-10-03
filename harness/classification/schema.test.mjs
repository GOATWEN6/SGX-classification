import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const buildDir = process.env.CLASSIFICATION_BUILD_DIR;
if (!buildDir) {
  throw new Error('CLASSIFICATION_BUILD_DIR must point to the compiled classification contract output.');
}
const { parseContract, ContractError } = require(
  path.join(buildDir, 'src/lib/algorithms/classification/validation.js'),
);

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJson = async (name) => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

function getPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, segment) => current[segment], value);
}

function applyMutation(value, mutation) {
  const target = clone(value);
  const parts = mutation.path.slice(1).split('/').filter(Boolean);
  const key = parts.pop();
  const parent = parts.reduce((current, segment) => current[segment], target);
  if (mutation.op === 'delete') delete parent[key];
  else if (mutation.op === 'set') parent[key] = clone(mutation.value);
  else throw new Error(`Unsupported fixture mutation operation: ${mutation.op}`);
  return target;
}

function expectInvalid(definition, value) {
  assert.throws(
    () => parseContract(definition, value),
    (error) => error instanceof ContractError && error.code === 'INVALID_CONTRACT',
  );
}

function evidenceForBundle(fixtures) {
  return [
    fixtures.evidenceRecords.image,
    fixtures.evidenceRecords.text,
    fixtures.evidenceRecords.transcript,
  ].map(clone);
}

function minimalEvidenceForProvider(fixtures) {
  return [
    {
      evidenceId: 'evidence_image_demo', sourceRef: { kind: 'object', id: 'object_image_demo' },
      sourceHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', revision: 1,
      byteLength: 2048, modality: 'image', mimeType: 'image/jpeg', dimensions: { width: 640, height: 480 },
    },
    {
      evidenceId: 'evidence_text_demo', sourceRef: { kind: 'message', id: 'message_text_demo' },
      sourceHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', revision: 1,
      byteLength: 128, modality: 'text', mimeType: 'text/plain',
    },
    {
      evidenceId: 'evidence_transcript_demo', sourceRef: { kind: 'object', id: 'object_transcript_demo' },
      sourceHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', revision: 1,
      byteLength: 256, modality: 'transcript', mimeType: 'text/plain',
      asr: { final: true, producerVersion: 'fixture-asr.1', confidence: 0.91 },
    },
  ];
}

function makeJob(fixtures, statusPatch) {
  return {
    ...clone(fixtures.jobRequest),
    ...clone(statusPatch),
    createdAt: '2026-09-07T00:00:10.000Z',
  };
}

function makeProviderRequest(fixtures) {
  return { ...clone(fixtures.providerRequest), evidence: minimalEvidenceForProvider(fixtures) };
}

function makeProviderResult(fixtures, template) {
  return {
    schemaVersion: '1.0',
    runId: 'run_succeeded_demo',
    jobId: 'job_demo',
    subjectId: 'subject_demo',
    householdId: 'household_demo',
    inputHash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    versions: clone(fixtures.jobRequest.versions),
    status: template.status,
    assertions: template.assertionKeys.map((key) => clone(fixtures.assertions[key])),
    facetErrors: clone(template.facetErrors),
    abstentions: clone(template.abstentions),
    ...(template.error ? { error: clone(template.error) } : {}),
    usage: { latencyMs: 120, inputUnits: 12, outputUnits: 5 },
  };
}

test('positive fixtures parse for all three active modalities and a deletion tombstone', async () => {
  const fixtures = await readJson('positive-v1.json');
  for (const evidence of Object.values(fixtures.evidenceRecords)) {
    assert.deepEqual(parseContract('EvidenceRecord', clone(evidence)), evidence);
  }

  const bundle = { ...clone(fixtures.contentBundle), evidence: evidenceForBundle(fixtures) };
  assert.equal(parseContract('ContentBundle', bundle).evidence.length, 3);
});

test('positive fixtures parse every job status and a full provider request', async () => {
  const fixtures = await readJson('positive-v1.json');
  for (const [status, statusPatch] of Object.entries(fixtures.jobsByStatus)) {
    assert.equal(parseContract('ClassificationJob', makeJob(fixtures, statusPatch)).status, status);
  }
  assert.equal(parseContract('ClassificationJobRequest', clone(fixtures.jobRequest)).jobId, 'job_demo');
  assert.equal(parseContract('ClassificationProviderRequest', makeProviderRequest(fixtures)).evidence.length, 3);
});

test('positive fixtures parse all assertion shapes, partial results, and review actions', async () => {
  const fixtures = await readJson('positive-v1.json');
  for (const assertion of Object.values(fixtures.assertions)) {
    assert.equal(parseContract('ClassificationAssertion', clone(assertion)).schemaVersion, '1.0');
  }
  for (const template of Object.values(fixtures.providerResults)) {
    assert.equal(parseContract('ClassificationProviderResult', makeProviderResult(fixtures, template)).status, template.status);
  }
  for (const review of Object.values(fixtures.reviewRequests)) {
    assert.equal(parseContract('AssertionReviewRequest', clone(review)).schemaVersion, '1.0');
  }
});

test('negative fixture mutations fail structural validation with INVALID_CONTRACT', async () => {
  const [fixtures, mutations] = await Promise.all([
    readJson('positive-v1.json'),
    readJson('invalid-mutations-v1.json'),
  ]);
  for (const mutation of mutations.cases) {
    let base = getPath(fixtures, mutation.base);
    if (mutation.base === 'contentBundle') base = { ...clone(base), evidence: evidenceForBundle(fixtures) };
    if (mutation.base === 'providerRequest') base = makeProviderRequest(fixtures);
    if (mutation.base.startsWith('providerResults.')) {
      base = makeProviderResult(fixtures, getPath(fixtures, mutation.base));
    }
    expectInvalid(mutation.definition, applyMutation(base, mutation));
  }
});

test('NaN is rejected at runtime even though JSON fixtures cannot express it', async () => {
  const fixtures = await readJson('positive-v1.json');
  const assertion = clone(fixtures.assertions.label);
  assertion.confidence = Number.NaN;
  expectInvalid('ClassificationAssertion', assertion);
});

test('semantic rejection manifest is structurally valid but explicitly outside JSON Schema', async () => {
  const [fixtures, semantic] = await Promise.all([
    readJson('positive-v1.json'),
    readJson('semantic-rejection-v1.json'),
  ]);
  const cases = new Map(semantic.cases.map((entry) => [entry.id, entry]));

  for (const id of ['cross-household-evidence', 'cross-subject-evidence']) {
    const entry = cases.get(id);
    const evidence = applyMutation(getPath(fixtures, entry.mutation.base), entry.mutation);
    assert.equal(parseContract('EvidenceRecord', evidence).schemaVersion, '1.0');
  }
  assert.equal(parseContract('EvidenceRecord', clone(fixtures.evidenceRecords.deletedTombstone)).lifecycleState, 'deleted');
  assert.equal(cases.get('late-result-after-cancel').kind, 'correlation');
  assert.equal(cases.get('review-authority-stale').kind, 'authorization');
  assert.equal(cases.get('provider-result-mismatched-input-hash').kind, 'correlation');
});

test('all standalone JSON Schema entry points resolve locally for external consumers', async () => {
  const Ajv = require('ajv');
  const ajv = new Ajv({ strictKeywords: true });
  const directory = new URL('../../contracts/', import.meta.url);
  const files = (await readdir(directory)).filter(f => f.endsWith('.schema.json'));
  const schemas = await Promise.all(files.map(async f => JSON.parse(await readFile(new URL(f, directory), 'utf8'))));
  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) assert.equal(typeof ajv.getSchema(schema.$id), 'function', schema.$id);
  assert.equal(schemas.length, 23);
});
