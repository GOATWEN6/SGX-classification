import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const buildDir = process.env.CLASSIFICATION_BUILD_DIR;
if(!buildDir) throw new Error('CLASSIFICATION_BUILD_DIR is required');
const {
  AssetFeatureSchema,
  RetrievalCandidateSchema,
  FamilyReferenceSchema,
  DecisionPolicySchema,
  DecisionPolicyResultSchema
} = require(path.join(buildDir, 'src/lib/algorithms/classification/hybrid-contract.js'));
const { ContentObservationSchema } = require(path.join(buildDir, 'src/lib/algorithms/classification/content-organization.js'));

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJson = async name => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const getPath = (value, dottedPath) => dottedPath.split('.').reduce((current, segment) => current[segment], value);

function applyMutation(value, mutation) {
  const target = clone(value);
  const parts = mutation.path.slice(1).split('/').filter(Boolean);
  const key = parts.pop();
  const parent = parts.reduce((current, segment) => current[segment], target);
  if(mutation.op === 'delete') delete parent[key];
  else if(mutation.op === 'set') parent[key] = clone(mutation.value);
  else throw new Error(`Unsupported mutation: ${mutation.op}`);
  return target;
}

async function hybridValidators(version = 'v2') {
  const Ajv = require('ajv');
  const ajv = new Ajv({ strictKeywords: true, allErrors: true });
  const directory = new URL('../../contracts/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.schema.json'));
  for(const file of files) ajv.addSchema(JSON.parse(await readFile(new URL(file, directory), 'utf8')));
  const base = `urn:sgx:classification-hybrid:${version}#/definitions/`;
  return Object.fromEntries(['AssetFeature', 'RetrievalCandidate', 'FamilyReference', 'DecisionPolicy', 'DecisionPolicyResult', 'ContentObservation', 'SparseAssociationInput']
    .map(name => [name, ajv.getSchema(`${base}${name}`)]));
}

test('historical hybrid v1 fixtures remain readable through the frozen v1 JSON Schema', async () => {
  const fixtures = await readJson('hybrid-v1.json');
  const validators = await hybridValidators('v1');
  const values = [
    ['AssetFeature', fixtures.assetFeatures.imageEmbedding],
    ['AssetFeature', fixtures.assetFeatures.personEmbedding],
    ['RetrievalCandidate', fixtures.retrievalCandidate],
    ['FamilyReference', fixtures.familyReferences.provisionalPerson],
    ['FamilyReference', fixtures.familyReferences.stablePerson],
    ['DecisionPolicy', fixtures.decisionPolicies.shadow],
    ['DecisionPolicy', fixtures.decisionPolicies.active],
    ['DecisionPolicyResult', fixtures.decisionResult]
  ];
  for(const [name, value] of values) {
    assert.equal(validators[name](clone(value)), true, JSON.stringify(validators[name].errors));
  }
  assert.equal(validators.SparseAssociationInput(clone(fixtures.sparseAssociationInput)), true, JSON.stringify(validators.SparseAssociationInput.errors));
});

test('hybrid v2 fixtures pass JSON Schema and runtime semantic validation', async () => {
  const fixtures = await readJson('hybrid-v2.json');
  const validators = await hybridValidators('v2');
  const values = [
    ['AssetFeature', AssetFeatureSchema, fixtures.assetFeatures.imageEmbedding],
    ['AssetFeature', AssetFeatureSchema, fixtures.assetFeatures.personEmbedding],
    ['RetrievalCandidate', RetrievalCandidateSchema, fixtures.retrievalCandidate],
    ['FamilyReference', FamilyReferenceSchema, fixtures.familyReferences.provisionalPerson],
    ['FamilyReference', FamilyReferenceSchema, fixtures.familyReferences.stablePerson],
    ['DecisionPolicy', DecisionPolicySchema, fixtures.decisionPolicies.shadow],
    ['DecisionPolicy', DecisionPolicySchema, fixtures.decisionPolicies.active],
    ['DecisionPolicyResult', DecisionPolicyResultSchema, fixtures.decisionResult]
  ];
  for(const [name, schema, value] of values) {
    assert.equal(validators[name](clone(value)), true, JSON.stringify(validators[name].errors));
    assert.deepEqual(schema.parse(clone(value)), value);
  }
  assert.equal(validators.SparseAssociationInput(clone(fixtures.sparseAssociationInput)), true, JSON.stringify(validators.SparseAssociationInput.errors));
});

test('hybrid runtime contracts reject unsafe semantic combinations', async () => {
  const [fixtures, invalid] = await Promise.all([readJson('hybrid-v2.json'), readJson('hybrid-invalid-v2.json')]);
  const schemas = {
    'assetFeatures.personEmbedding': AssetFeatureSchema,
    'familyReferences.stablePerson': FamilyReferenceSchema,
    'decisionPolicies.shadow': DecisionPolicySchema,
    retrievalCandidate: RetrievalCandidateSchema,
    decisionResult: DecisionPolicyResultSchema
  };
  for(const entry of invalid.cases) {
    assert.throws(
      () => schemas[entry.base].parse(applyMutation(getPath(fixtures, entry.base), entry.mutation)),
      new RegExp(entry.error),
      entry.id
    );
  }
});

test('hybrid v2 requires an explicit implemented decision mode in Zod and JSON Schema', async () => {
  const fixtures = await readJson('hybrid-v2.json');
  const validators = await hybridValidators('v2');
  const missingMode = clone(fixtures.decisionPolicies.shadow);
  delete missingMode.decisionMode;
  assert.equal(validators.DecisionPolicy(missingMode), false);
  assert.throws(() => DecisionPolicySchema.parse(missingMode));

  const unimplemented = {
    ...clone(fixtures.decisionPolicies.shadow),
    decisionMode: 'calibrated_probability'
  };
  assert.equal(validators.DecisionPolicy(unimplemented), false);
  assert.throws(() => DecisionPolicySchema.parse(unimplemented), /CALIBRATED_PROBABILITY_NOT_IMPLEMENTED/);

  const v1 = await readJson('hybrid-v1.json');
  const v1Validators = await hybridValidators('v1');
  assert.equal(v1Validators.DecisionPolicy(clone(v1.decisionPolicies.shadow)), true);
  assert.equal(validators.DecisionPolicy(clone(v1.decisionPolicies.shadow)), false);
  assert.equal(v1Validators.DecisionPolicy(clone(fixtures.decisionPolicies.shadow)), false);
});

test('content observation qualifiers stay aligned across Zod and JSON Schema', async () => {
  const validators = await hybridValidators('v2');
  const valid = {
    contentId: 'content-photo-1',
    evidenceId: 'evidence-photo-1',
    facet: 'time',
    rawValue: '1985年5月1日',
    normalizedValue: '1985-05-01',
    temporal: { role: 'event', precision: 'date' },
    supports: [
      { evidenceId: 'evidence-photo-1', sourceType: 'visual' },
      { evidenceId: 'evidence-text-1', sourceType: 'user_text', quote: '这是1985年五一拍的' },
      { evidenceId: 'evidence-asr-1', sourceType: 'final_asr', quote: '那天正好是五一' }
    ],
    state: 'candidate'
  };
  const validPlace = {
    contentId: 'content-photo-1',
    evidenceId: 'evidence-photo-1',
    facet: 'place',
    rawValue: '家里',
    normalizedValue: '家里',
    placeKind: 'generic',
    supports: [{ evidenceId: 'evidence-photo-1', sourceType: 'ocr', quote: '家里' }],
    state: 'candidate'
  };

  for(const observation of [valid, validPlace]) {
    assert.deepEqual(ContentObservationSchema.parse(clone(observation)), observation);
    assert.equal(validators.ContentObservation(clone(observation)), true, JSON.stringify(validators.ContentObservation.errors));
  }

  const invalidCases = [
    {
      id: 'temporal_on_place',
      value: { ...clone(validPlace), temporal: { role: 'event', precision: 'date' } },
      zodError: /INVALID_TEMPORAL_QUALIFIER/
    },
    {
      id: 'place_kind_on_time',
      value: { ...clone(valid), placeKind: 'named' },
      zodError: /INVALID_PLACE_KIND_QUALIFIER/
    }
  ];
  for(const invalid of invalidCases) {
    assert.throws(() => ContentObservationSchema.parse(clone(invalid.value)), invalid.zodError, `${invalid.id}:zod`);
    assert.equal(validators.ContentObservation(clone(invalid.value)), false, `${invalid.id}:json-schema`);
  }
});

test('hybrid contract stores references to vector values, not raw vectors', async () => {
  const fixtures = await readJson('hybrid-v2.json');
  const feature = { ...clone(fixtures.assetFeatures.imageEmbedding), vector: [0.1, 0.2] };
  assert.throws(() => AssetFeatureSchema.parse(feature), /unrecognized_keys/i);
});
