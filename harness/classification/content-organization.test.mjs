import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const organization = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/content-organization.js`);
const { validateOrganizationInput } = organization;

const scope = { householdId: 'house_a', subjectId: 'elder_a' };
const createdAt = '2026-09-23T08:00:00.000Z';
const content = (contentId, modality, evidenceId, originalText) => ({
  contentId,
  scope,
  modality,
  evidenceIds: [evidenceId],
  ...(originalText ? { originalText } : {}),
  lifecycle: 'active'
});
const obs = (contentId, evidenceId, facet, rawValue, state = 'candidate') => ({
  contentId,
  evidenceId,
  facet,
  rawValue,
  normalizedValue: rawValue,
  supports: [{ evidenceId, quote: rawValue }],
  state
});

function baseInput() {
  const photo = content('photo_1', 'photo', 'evidence_photo_1');
  const text = content('text_1', 'user_text', 'evidence_text_1', '周末带家人去北京过生日，大家都来了。');
  const asr = content('asr_1', 'final_asr', 'evidence_asr_1', '那次生日是在北京，家里人都在。');
  return {
    scope,
    contents: [photo, text, asr],
    observations: [
      obs('photo_1', 'evidence_photo_1', 'event', '生日'),
      obs('text_1', 'evidence_text_1', 'place', '北京'),
      obs('asr_1', 'evidence_asr_1', 'theme', '家庭')
    ],
    explicitAssociations: [],
    createdAt
  };
}

test('production organization module does not export the retired all-pairs scorer', () => {
  for(const name of [
    'organizeContent',
    'scoreAssociation',
    'OrganizationConfigSchema',
    'OrganizationResultSchema',
    'CONTENT_ORGANIZATION_VERSION',
    'ASSOCIATION_RULES_VERSION'
  ]) assert.equal(organization[name], undefined, name);
});

test('shared validator preserves independent image, user text and final ASR evidence', () => {
  const input = baseInput();
  const validated = validateOrganizationInput(input);
  assert.deepEqual(validated, input);
  assert.deepEqual(validated.contents.map(item => item.modality), ['photo', 'user_text', 'final_asr']);
  assert.equal(validated.contents.find(item => item.contentId === 'text_1').originalText, '周末带家人去北京过生日，大家都来了。');
});

test('shared validator preserves explicit user authority without scoring it', () => {
  const input = baseInput();
  input.explicitAssociations = [{
    associationId: 'user_link_1',
    fromContentId: 'photo_1',
    toContentId: 'text_1',
    relation: 'same_story',
    source: 'user_explicit',
    status: 'user_confirmed',
    method: 'user_selection.1',
    evidenceRefs: ['evidence_photo_1', 'evidence_text_1'],
    createdAt
  }];
  const validated = validateOrganizationInput(input);
  assert.equal(validated.explicitAssociations[0].status, 'user_confirmed');
  assert.equal(validated.explicitAssociations[0].score, undefined);
  assert.equal(validated.explicitAssociations[0].confidenceBand, undefined);
});

test('scope, evidence, withdrawal and explicit association contracts still reject unsafe inputs', () => {
  const foreign = baseInput();
  foreign.contents[1].scope = { householdId: 'other_house', subjectId: 'elder_a' };
  assert.throws(() => validateOrganizationInput(foreign), /CROSS_SCOPE/);

  const badEvidence = baseInput();
  badEvidence.observations[0].evidenceId = 'foreign_evidence';
  assert.throws(() => validateOrganizationInput(badEvidence), /FOREIGN_EVIDENCE/);

  const missingPrimarySupport = baseInput();
  missingPrimarySupport.observations[0].supports = [{ evidenceId: 'evidence_photo_1', quote: '生日' }];
  missingPrimarySupport.observations[0].evidenceId = 'evidence_missing';
  assert.throws(() => validateOrganizationInput(missingPrimarySupport), /FOREIGN_EVIDENCE|OBSERVATION_PRIMARY_SUPPORT_MISSING/);

  const withdrawn = baseInput();
  withdrawn.contents[0].lifecycle = 'withdrawn';
  assert.throws(() => validateOrganizationInput(withdrawn), /OBSERVATION_FOR_WITHDRAWN_OR_FOREIGN_CONTENT/);

  const forged = baseInput();
  forged.explicitAssociations = [{
    associationId: 'fake',
    fromContentId: 'photo_1',
    toContentId: 'text_1',
    relation: 'same_story',
    source: 'ai_inferred',
    status: 'ai_auto',
    decisionBasis: 'retrieval_only',
    evidenceStrength: 'insufficient',
    method: 'fake',
    evidenceRefs: ['evidence_photo_1'],
    createdAt
  }];
  assert.throws(() => validateOrganizationInput(forged), /EXPLICIT_ASSOCIATION_SOURCE/);
});

test('empty compatibility config is ignored but retired numeric thresholds are rejected', () => {
  assert.doesNotThrow(() => validateOrganizationInput({ ...baseInput(), config: {} }));
  assert.throws(() => validateOrganizationInput({
    ...baseInput(),
    config: { autoAssociationThreshold: 0.8, reviewAssociationThreshold: 0.55 }
  }), /LEGACY_ORGANIZATION_CONFIG_REMOVED/);
});
