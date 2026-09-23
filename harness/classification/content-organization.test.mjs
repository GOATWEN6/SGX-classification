import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { organizeContent, validateOrganizationInput, scoreAssociation } = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/content-organization.js`);

const scope = { householdId: 'house_a', subjectId: 'elder_a' };
const createdAt = '2026-09-23T08:00:00.000Z';
const content = (contentId, modality, evidenceId, originalText) => ({ contentId, scope, modality, evidenceIds: [evidenceId], ...(originalText ? { originalText } : {}), lifecycle: 'active' });
const obs = (contentId, evidenceId, facet, rawValue, state = 'candidate') => ({ contentId, evidenceId, facet, rawValue, normalizedValue: rawValue, supports: [{ evidenceId, ...(facet === 'person' ? { region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } : { quote: rawValue }) }], state });
function baseInput() {
  const photo = content('photo_1', 'photo', 'evidence_photo_1');
  const text = content('text_1', 'user_text', 'evidence_text_1', '周末带家人去北京过生日，大家都来了。');
  const asr = content('asr_1', 'final_asr', 'evidence_asr_1', '那次生日是在北京，家里人都在。');
  const observations = [photo, text, asr].flatMap(item => [
    obs(item.contentId, item.evidenceIds[0], 'person', '奶奶'),
    obs(item.contentId, item.evidenceIds[0], 'time', '2026年'),
    obs(item.contentId, item.evidenceIds[0], 'place', '北京'),
    obs(item.contentId, item.evidenceIds[0], 'event', '生日'),
    obs(item.contentId, item.evidenceIds[0], 'theme', '家庭')
  ]);
  return { scope, contents: [photo, text, asr], observations, explicitAssociations: [], createdAt };
}

test('image, user text and final ASR form one deterministic story card', () => {
  const input = baseInput();
  const first = organizeContent(input);
  const second = organizeContent(input);
  assert.deepEqual(first, second);
  assert.equal(first.stories.length, 1);
  assert.deepEqual(first.stories[0].memberContentIds, ['asr_1', 'photo_1', 'text_1']);
  assert.equal(first.stories[0].titleCandidate, '生日');
  assert.match(first.stories[0].summaryCandidate, /包含3项内容/);
  assert.equal(first.associations.filter(item => item.status === 'ai_auto').length, 3);
  assert.ok(first.associations.every(item => item.evidenceRefs.length > 0));
  assert.equal(input.contents.find(item => item.contentId === 'text_1').originalText, '周末带家人去北京过生日，大家都来了。');
});

test('explicit user relation is preserved and prevents a duplicate AI relation', () => {
  const input = baseInput();
  input.explicitAssociations = [{ associationId: 'user_link_1', fromContentId: 'photo_1', toContentId: 'text_1', relation: 'same_story', source: 'user_explicit', status: 'user_confirmed', method: 'user_selection.1', evidenceRefs: ['evidence_photo_1', 'evidence_text_1'], createdAt }];
  const result = organizeContent(input);
  assert.ok(result.associations.some(item => item.associationId === 'user_link_1' && item.status === 'user_confirmed'));
  assert.equal(result.associations.filter(item => item.fromContentId === 'photo_1' && item.toContentId === 'text_1').length, 1);
  assert.equal(result.stories[0].state, 'user_confirmed');
});

test('association thresholds produce high, review and not-selected bands', () => {
  const high = baseInput();
  const highScore = scoreAssociation('photo_1', 'text_1', high.observations);
  assert.equal(highScore.confidenceBand, 'high');
  const medium = baseInput();
  medium.observations = medium.observations.filter(item => item.facet === 'time' || item.facet === 'event' || item.facet === 'theme');
  const mediumResult = organizeContent(medium);
  assert.ok(mediumResult.associations.some(item => item.status === 'needs_review'));
  const low = baseInput();
  low.observations = low.observations.filter(item => item.facet === 'place');
  const lowResult = organizeContent(low);
  assert.ok(lowResult.associations.some(item => item.status === 'not_selected'));
});

test('conflict blocks automatic association even when other signals agree', () => {
  const input = baseInput();
  input.observations.push(obs('text_1', 'evidence_text_1', 'event', '旅行', 'conflicted'));
  const result = organizeContent(input);
  const pair = result.associations.find(item => item.fromContentId === 'photo_1' && item.toContentId === 'text_1');
  assert.equal(pair.status, 'needs_review');
  assert.ok(result.reviewItems.some(item => item === `CONFLICT:${pair.associationId}`));
});

test('scope, evidence, withdrawal and explicit association contracts reject unsafe inputs', () => {
  const foreign = baseInput(); foreign.contents[1].scope = { householdId: 'other_house', subjectId: 'elder_a' };
  assert.throws(() => validateOrganizationInput(foreign), /CROSS_SCOPE/);
  const badEvidence = baseInput(); badEvidence.observations[0].evidenceId = 'foreign_evidence';
  assert.throws(() => validateOrganizationInput(badEvidence), /FOREIGN_EVIDENCE/);
  const withdrawn = baseInput(); withdrawn.contents[0].lifecycle = 'withdrawn';
  assert.throws(() => organizeContent(withdrawn), /OBSERVATION_FOR_WITHDRAWN_OR_FOREIGN_CONTENT/);
  const forged = baseInput(); forged.explicitAssociations = [{ associationId: 'fake', fromContentId: 'photo_1', toContentId: 'text_1', relation: 'same_story', source: 'ai_inferred', status: 'ai_auto', score: 0.99, confidenceBand: 'high', method: 'fake', evidenceRefs: ['evidence_photo_1'], createdAt }];
  assert.throws(() => validateOrganizationInput(forged), /EXPLICIT_ASSOCIATION_SOURCE/);
});

test('user original text and AI derived fields remain separate', () => {
  const input = baseInput();
  const result = organizeContent(input);
  const textItem = input.contents.find(item => item.contentId === 'text_1');
  assert.equal(textItem.originalText, '周末带家人去北京过生日，大家都来了。');
  assert.notEqual(result.stories[0].summaryCandidate, textItem.originalText);
  assert.ok(result.stories[0].summarySupports.includes('evidence_text_1'));
});

test('stories without extracted observations still cite real Evidence IDs', () => {
  const input = baseInput();
  input.observations = [];
  const result = organizeContent(input);
  assert.ok(result.stories.every(story => story.titleSupports.every(ref => ref.startsWith('evidence_'))));
  assert.ok(result.stories.every(story => story.summarySupports.every(ref => ref.startsWith('evidence_'))));
  assert.ok(result.associations.every(item => item.evidenceRefs.every(ref => ref.startsWith('evidence_'))));
});
