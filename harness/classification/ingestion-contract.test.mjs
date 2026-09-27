import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseIngestionEnvelope, IngestionEnvelopeStructureSchema } = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/ingestion-contract.js`);
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtures = JSON.parse(await readFile(path.join(fixtureDir, 'ingestion-v2.json'), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

async function validator() {
  const Ajv = require('ajv');
  const ajv = new Ajv({ strictKeywords: true, allErrors: true });
  const directory = new URL('../../contracts/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.schema.json'));
  for(const file of files) ajv.addSchema(JSON.parse(await readFile(new URL(file, directory), 'utf8')));
  return ajv.getSchema('urn:sgx:classification-ingestion:v2');
}

test('album upload and family transfer examples pass JSON Schema and semantic parsing', async () => {
  const validate = await validator();
  for(const value of Object.values(fixtures)) {
    assert.equal(validate(clone(value)), true, JSON.stringify(validate.errors));
    assert.equal(IngestionEnvelopeStructureSchema.safeParse(clone(value)).success, true);
    assert.equal(parseIngestionEnvelope(clone(value)).specVersion, '2.0.0');
  }
});

test('unspecified text stays batch evidence while AI may add a non-authoritative image candidate', () => {
  const parsed = parseIngestionEnvelope(clone(fixtures.familyTransfer));
  const userBinding = parsed.bindings.find(item => item.bindingId === 'binding_text_batch');
  const aiBinding = parsed.bindings.find(item => item.bindingId === 'binding_text_candidate');
  assert.deepEqual(userBinding.target, { kind: 'batch' });
  assert.equal(userBinding.authority, 'user_explicit');
  assert.deepEqual(aiBinding.target, { kind: 'contents', contentIds: ['content_photo_1'] });
  assert.equal(aiBinding.authority, 'ai_candidate');
});

test('family transfer requires parties and the frozen 3/7 day review policy', () => {
  const missingParties = clone(fixtures.familyTransfer);
  delete missingParties.context.senderId;
  assert.throws(() => parseIngestionEnvelope(missingParties), /FAMILY_TRANSFER_PARTIES_REQUIRED/);

  const missingPolicy = clone(fixtures.familyTransfer);
  delete missingPolicy.reviewPolicy;
  assert.throws(() => parseIngestionEnvelope(missingPolicy), /FAMILY_TRANSFER_REVIEW_POLICY_REQUIRED/);

  const policyOnAlbum = clone(fixtures.albumUpload);
  policyOnAlbum.reviewPolicy = clone(fixtures.familyTransfer.reviewPolicy);
  assert.throws(() => parseIngestionEnvelope(policyOnAlbum), /ALBUM_UPLOAD_REVIEW_POLICY_NOT_APPLICABLE/);
});

test('every active text or final ASR source has exactly one authoritative binding', () => {
  const missing = clone(fixtures.familyTransfer);
  missing.bindings = missing.bindings.filter(item => item.bindingId !== 'binding_text_batch');
  assert.throws(() => parseIngestionEnvelope(missing), /MISSING_AUTHORITATIVE_BINDING/);

  const duplicate = clone(fixtures.familyTransfer);
  duplicate.bindings.push({ ...clone(duplicate.bindings[0]), bindingId: 'binding_text_second', target: { kind: 'contents', contentIds: ['content_photo_2'] } });
  assert.throws(() => parseIngestionEnvelope(duplicate), /MULTIPLE_AUTHORITATIVE_BINDINGS/);
});

test('AI cannot invent a batch fact or turn an image into a binding source', () => {
  const aiBatch = clone(fixtures.familyTransfer);
  aiBatch.bindings.find(item => item.bindingId === 'binding_text_candidate').target = { kind: 'batch' };
  assert.throws(() => parseIngestionEnvelope(aiBatch), /AI_BINDING_REQUIRES_CONTENT_TARGETS/);

  const imageSource = clone(fixtures.familyTransfer);
  imageSource.bindings.find(item => item.bindingId === 'binding_text_candidate').sourceContentId = 'content_photo_1';
  assert.throws(() => parseIngestionEnvelope(imageSource), /IMAGE_CANNOT_BE_BINDING_SOURCE/);
});

test('scope, Evidence ownership and modality remain server-verifiable', () => {
  const crossScope = clone(fixtures.familyTransfer);
  crossScope.evidence[0].householdId = 'house_b';
  assert.throws(() => parseIngestionEnvelope(crossScope), /CROSS_SCOPE/);

  const mismatch = clone(fixtures.familyTransfer);
  mismatch.contents.find(item => item.contentId === 'content_text_1').modality = 'image';
  assert.throws(() => parseIngestionEnvelope(mismatch), /CONTENT_MODALITY_MISMATCH/);

  const unbound = clone(fixtures.familyTransfer);
  unbound.contents = unbound.contents.filter(item => item.contentId !== 'content_asr_1');
  unbound.bindings = unbound.bindings.filter(item => item.sourceContentId !== 'content_asr_1');
  assert.throws(() => parseIngestionEnvelope(unbound), /UNBOUND_EVIDENCE/);
});

test('classification and album organization purposes are mandatory while Memory remains a separate gate', () => {
  const missing = clone(fixtures.albumUpload);
  missing.purposes = ['classification'];
  assert.throws(() => parseIngestionEnvelope(missing), /REQUIRED_PURPOSE_MISSING/);
  assert.ok(!fixtures.familyTransfer.purposes.includes('long_term_memory'));
});
