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

async function hybridValidators() {
  const Ajv = require('ajv');
  const ajv = new Ajv({ strictKeywords: true, allErrors: true });
  const directory = new URL('../../contracts/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.schema.json'));
  for(const file of files) ajv.addSchema(JSON.parse(await readFile(new URL(file, directory), 'utf8')));
  const base = 'urn:sgx:classification-hybrid:v1#/definitions/';
  return Object.fromEntries(['AssetFeature', 'RetrievalCandidate', 'FamilyReference', 'DecisionPolicy', 'DecisionPolicyResult', 'SparseAssociationInput']
    .map(name => [name, ajv.getSchema(`${base}${name}`)]));
}

test('hybrid contract fixtures pass JSON Schema and runtime semantic validation', async () => {
  const fixtures = await readJson('hybrid-v1.json');
  const validators = await hybridValidators();
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
  const [fixtures, invalid] = await Promise.all([readJson('hybrid-v1.json'), readJson('hybrid-invalid-v1.json')]);
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

test('hybrid contract stores references to vector values, not raw vectors', async () => {
  const fixtures = await readJson('hybrid-v1.json');
  const feature = { ...clone(fixtures.assetFeatures.imageEmbedding), vector: [0.1, 0.2] };
  assert.throws(() => AssetFeatureSchema.parse(feature), /unrecognized_keys/i);
});
