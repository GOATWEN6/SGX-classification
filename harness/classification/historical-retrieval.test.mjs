import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const {
  FileHistoricalRetrievalAdapter,
  HISTORICAL_RETRIEVAL_CONTRACT_VERSION,
} = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/historical-retrieval.js`);

const createdAt = '2026-10-03T08:00:00.000Z';
const scope = { householdId: 'house_a', subjectId: 'elder_a' };
const digest = character => `sha256:${character.repeat(64)}`;

function record({
  recordId = 'record_round_1',
  featureId = 'feature_round_1',
  targetScope = scope,
  authorizationRevision = 'auth_1',
  contentId = 'content_round_1',
  evidenceId = 'evidence_round_1',
  vector = [1, 0],
  modelRevision = 'revision_1',
  lifecycleState = 'active',
  kind = 'image_text_embedding',
} = {}) {
  return {
    schemaVersion: '2.0',
    contractVersion: HISTORICAL_RETRIEVAL_CONTRACT_VERSION,
    recordId,
    featureId,
    scope: targetScope,
    authorizationRevision,
    contentId,
    evidenceId,
    evidenceRevision: 1,
    sourceHash: digest('a'),
    kind,
    modelId: kind === 'face_embedding' ? 'face_embedding_test' : 'image_text_embedding_test',
    modelRevision,
    dimensions: 2,
    normalized: true,
    vector,
    lifecycleState,
    projection: {
      contentId,
      evidenceId,
      evidenceRevision: 1,
      sourceHash: digest('a'),
      artifactId: `artifact_${evidenceId}`,
      mimeType: 'image/jpeg',
      byteLength: 128,
      consentRef: `consent_${evidenceId}`,
      ...(kind === 'face_embedding' ? {
        personConsentRef: `person_consent_${evidenceId}`,
        faceId: `face_${'a'.repeat(32)}`,
      } : {}),
      confirmedReferenceIds: [],
      lifecycleState: 'active',
    },
    createdAt,
    updatedAt: createdAt,
  };
}

function query({
  targetScope = scope,
  authorizationRevision = 'auth_1',
  modelRevision = 'revision_1',
  kind = 'image_text_embedding',
} = {}) {
  return {
    schemaVersion: '2.0',
    contractVersion: HISTORICAL_RETRIEVAL_CONTRACT_VERSION,
    scope: targetScope,
    authorizationRevision,
    maxCandidatesPerSource: 4,
    excludeEvidenceIds: [],
    sources: [{
      sourceContentId: 'content_round_2',
      sourceEvidenceId: 'evidence_round_2',
      kind,
      modelId: kind === 'face_embedding' ? 'face_embedding_test' : 'image_text_embedding_test',
      modelRevision,
      dimensions: 2,
      normalized: true,
      vector: [0.99, 0.1],
      ...(kind === 'face_embedding' ? { personConsentRef: 'person_consent_round_2' } : {}),
    }],
  };
}

test('standalone JSON Schema accepts frozen requests/results and rejects open score fields', async (t) => {
  const adapter = await adapterFixture(t);
  const stored = record();
  const request = query();
  await adapter.upsert({ scope, authorizationRevision: 'auth_1', records: [stored] });
  const result = await adapter.query(request);
  const schema = JSON.parse(await readFile(
    new URL('../../contracts/classification-historical-retrieval.schema.json', import.meta.url),
    'utf8',
  ));
  const validate = new Ajv({ allErrors: true, jsonPointers: true }).compile(schema);
  assert.equal(validate(stored), true, JSON.stringify(validate.errors));
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  const unsafe = structuredClone(result);
  unsafe.candidates[0].similarity = 0.99;
  assert.equal(validate(unsafe), false);
});

async function adapterFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sgx-historical-retrieval.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new FileHistoricalRetrievalAdapter(root);
}

test('round two retrieves an authorized round-one projection without returning vectors or scores', async (t) => {
  const adapter = await adapterFixture(t);
  await adapter.upsert({ scope, authorizationRevision: 'auth_1', records: [record()] });

  const result = await adapter.query(query());

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].historicalContentId, 'content_round_1');
  assert.equal(result.candidates[0].historicalProjection.artifactId, 'artifact_evidence_round_1');
  assert.equal(result.candidates[0].rank, 1);
  assert.equal(result.scoreMeaning, 'retrieval_order_not_probability');
  assert.equal(JSON.stringify(result).includes('"vector"'), false);
  assert.equal(JSON.stringify(result).includes('similarity'), false);

  const restarted = new FileHistoricalRetrievalAdapter(adapter.root);
  const afterRestart = await restarted.query(query());
  assert.deepEqual(afterRestart, result);
});

test('household, subject, authorization revision and model revision remain hard retrieval fences', async (t) => {
  const adapter = await adapterFixture(t);
  await adapter.upsert({ scope, authorizationRevision: 'auth_1', records: [record()] });

  assert.equal((await adapter.query(query({
    targetScope: { householdId: 'house_b', subjectId: 'elder_a' },
  }))).candidates.length, 0);
  assert.equal((await adapter.query(query({
    targetScope: { householdId: 'house_a', subjectId: 'elder_b' },
  }))).candidates.length, 0);
  assert.equal((await adapter.query(query({ authorizationRevision: 'auth_2' }))).candidates.length, 0);
  assert.equal((await adapter.query(query({ modelRevision: 'revision_2' }))).candidates.length, 0);
});

test('withdraw and delete make historical evidence unavailable without changing another scope', async (t) => {
  const adapter = await adapterFixture(t);
  await adapter.upsert({ scope, authorizationRevision: 'auth_1', records: [record()] });
  await adapter.upsert({
    scope: { householdId: 'house_b', subjectId: 'elder_a' },
    authorizationRevision: 'auth_b',
    records: [record({
      targetScope: { householdId: 'house_b', subjectId: 'elder_a' },
      authorizationRevision: 'auth_b',
      recordId: 'record_house_b',
      featureId: 'feature_house_b',
    })],
  });

  const withdrawn = await adapter.revokeEvidence({
    scope,
    authorizationRevision: 'auth_1',
    evidenceId: 'evidence_round_1',
    lifecycleState: 'withdrawn',
    updatedAt: '2026-10-03T08:05:00.000Z',
  });
  assert.equal(withdrawn.updatedRecords, 1);
  assert.equal((await adapter.query(query())).candidates.length, 0);
  assert.equal((await adapter.query(query({
    targetScope: { householdId: 'house_b', subjectId: 'elder_a' },
    authorizationRevision: 'auth_b',
  }))).candidates.length, 1);

  const deleted = await adapter.deleteEvidence({
    scope,
    evidenceId: 'evidence_round_1',
  });
  assert.equal(deleted.deletedRecords, 1);
  assert.equal((await adapter.query(query())).candidates.length, 0);
});

test('face history requires independent person consent and remains an anonymous candidate', async (t) => {
  const adapter = await adapterFixture(t);
  await adapter.upsert({
    scope,
    authorizationRevision: 'auth_1',
    records: [record({ kind: 'face_embedding' })],
  });
  const result = await adapter.query(query({ kind: 'face_embedding' }));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].kind, 'face_embedding');
  assert.ok(result.candidates[0].reasons.includes('anonymous_person_candidate'));
  assert.equal(JSON.stringify(result).includes('displayName'), false);
  assert.equal(JSON.stringify(result).includes('relationship'), false);

  const invalid = record({ kind: 'face_embedding', recordId: 'record_invalid_face' });
  delete invalid.projection.personConsentRef;
  await assert.rejects(
    () => adapter.upsert({ scope, authorizationRevision: 'auth_1', records: [invalid] }),
    /PERSON_CONSENT_REQUIRED/,
  );
});
