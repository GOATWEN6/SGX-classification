import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeRetrievalCandidates, retrieveExactCandidates, EXACT_RETRIEVAL_VERSION } = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/exact-retrieval.js`);

const scope = { householdId: 'house_a', subjectId: 'elder_a' };
const createdAt = '2026-09-27T12:00:00.000Z';
const content = index => ({ contentId: `content_${index}`, scope, modality: 'photo', evidenceIds: [`evidence_${index}`], lifecycle: 'active' });
const observation = (index, facet, value, state = 'candidate') => ({
  contentId: `content_${index}`,
  evidenceId: `evidence_${index}`,
  facet,
  rawValue: value,
  normalizedValue: value,
  supports: [{ evidenceId: `evidence_${index}`, quote: value }],
  state
});
const input = (contents, observations, patch = {}) => ({
  schemaVersion: '2.0',
  contractVersion: 'classification-hybrid.2',
  scope,
  contents,
  observations,
  explicitAssociations: [],
  maxCandidatesPerContent: 4,
  includeZeroSignalFallback: true,
  createdAt,
  ...patch
});

test('250 contents emit bounded sparse candidates instead of all pairs', () => {
  const contents = Array.from({ length: 250 }, (_, index) => content(index));
  const observations = contents.map((_, index) => observation(index, 'event', '家庭聚会'));
  const result = retrieveExactCandidates(input(contents, observations));
  assert.equal(result.version, EXACT_RETRIEVAL_VERSION);
  assert.equal(result.traces.length, 250);
  assert.ok(result.candidates.length <= 250 * 4);
  assert.ok(result.candidates.length < (250 * 249) / 2);
  assert.equal(new Set(result.candidates.map(item => [item.fromContentId, item.toContentId].sort().join('/'))).size, result.candidates.length);
  assert.equal(result.audit.pairMaterialized, false);
  assert.equal(result.audit.scoreMeaning, 'retrieval_heuristic_not_probability');
  const perSource = new Map();
  for(const item of result.candidates) perSource.set(item.fromContentId, (perSource.get(item.fromContentId) ?? 0) + 1);
  assert.ok([...perSource.values()].every(count => count <= 4));
});

test('multi-facet exact match ranks ahead of a single matching facet', () => {
  const contents = [content(0), content(1), content(2)];
  const observations = [
    observation(0, 'time', '1982'), observation(0, 'place', '武汉'), observation(0, 'event', '毕业'),
    observation(1, 'time', '1982'), observation(1, 'place', '武汉'), observation(1, 'event', '毕业'),
    observation(2, 'event', '毕业')
  ];
  const result = retrieveExactCandidates(input(contents, observations, { maxCandidatesPerContent: 1 }));
  const first = result.candidates.find(item => item.fromContentId === 'content_0');
  assert.equal(first.toContentId, 'content_1');
  assert.equal(first.retrievalScore, undefined);
  assert.deepEqual(first.reasons, ['time_overlap', 'place_overlap', 'event_overlap']);
});

test('zero-signal fallback is explicit and can be disabled', () => {
  const contents = [content(0), content(1), content(2)];
  const withFallback = retrieveExactCandidates(input(contents, []));
  assert.ok(withFallback.candidates.length > 0);
  assert.ok(withFallback.candidates.every(item => item.coverage === 'fallback' && item.reasons.includes('zero_signal_fallback')));
  const withoutFallback = retrieveExactCandidates(input(contents, [], { includeZeroSignalFallback: false }));
  assert.equal(withoutFallback.candidates.length, 0);
});

test('explicit user pair is not emitted as a duplicate retrieval candidate', () => {
  const contents = [content(0), content(1), content(2)];
  const explicit = [{
    associationId: 'explicit_1',
    fromContentId: 'content_0',
    toContentId: 'content_1',
    relation: 'same_story',
    source: 'user_explicit',
    status: 'user_confirmed',
    method: 'user-selection.1',
    evidenceRefs: ['evidence_0', 'evidence_1'],
    createdAt
  }];
  const result = retrieveExactCandidates(input(contents, [], { explicitAssociations: explicit }));
  assert.ok(!result.candidates.some(item => new Set([item.fromContentId, item.toContentId]).has('content_0') && new Set([item.fromContentId, item.toContentId]).has('content_1')));
});

test('structured upstream candidate wins over a duplicate exact-retrieval fallback', () => {
  const result = retrieveExactCandidates(input([content(0), content(1)], [observation(0, 'event', '家庭聚会'), observation(1, 'event', '家庭聚会')]));
  const fallback = result.candidates[0];
  const primary = {
    ...fallback,
    candidateId: 'candidate_batch_statement',
    stageDecision: 'same',
    method: 'batch-text-explicit-relation.1',
    reasons: ['user_batch_same_story_statement']
  };
  const merged = mergeRetrievalCandidates([primary], [fallback]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].candidateId, 'candidate_batch_statement');
  assert.equal(merged[0].stageDecision, 'same');
});

test('withdrawn content is omitted while unsafe scope and evidence are rejected', () => {
  const withdrawn = { ...content(2), lifecycle: 'withdrawn' };
  const result = retrieveExactCandidates(input([content(0), content(1), withdrawn], [observation(0, 'event', '旅行'), observation(1, 'event', '旅行')]));
  assert.ok(result.candidates.every(item => item.fromContentId !== 'content_2' && item.toContentId !== 'content_2'));
  assert.equal(result.audit.activeContentCount, 2);

  const crossScope = content(1);
  crossScope.scope = { householdId: 'house_b', subjectId: 'elder_a' };
  assert.throws(() => retrieveExactCandidates(input([content(0), crossScope], [])), /CROSS_SCOPE/);

  const foreignEvidence = observation(0, 'event', '旅行');
  foreignEvidence.evidenceId = 'evidence_foreign';
  foreignEvidence.supports = [{ evidenceId: 'evidence_foreign', quote: '旅行' }];
  assert.throws(() => retrieveExactCandidates(input([content(0), content(1)], [foreignEvidence])), /FOREIGN_EVIDENCE/);
});

test('conflict remains a visible retrieval reason without creating a numerical relation score', () => {
  const contents = [content(0), content(1)];
  const observations = [
    observation(0, 'time', '1982'), observation(0, 'place', '武汉'), observation(0, 'event', '毕业'), observation(0, 'person', '人物甲'), observation(0, 'theme', '友情'),
    observation(1, 'time', '1982'), observation(1, 'place', '武汉'), observation(1, 'event', '毕业'), observation(1, 'person', '人物甲'), observation(1, 'theme', '友情'),
    observation(1, 'time', '1995', 'conflicted')
  ];
  const result = retrieveExactCandidates(input(contents, observations));
  assert.equal(result.candidates[0].retrievalScore, undefined);
  assert.ok(result.candidates[0].reasons.includes('conflict_present'));
});
