import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  organizeSparseContent,
  validateSparseAssociationInput,
  SPARSE_CONTENT_ORGANIZATION_VERSION
} = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/content-organization.js`);

const scope = { householdId: 'house_a', subjectId: 'elder_a' };
const createdAt = '2026-09-27T08:00:00.000Z';
const policy = (maxCandidatesPerContent = 8, mode = 'shadow') => ({
  schemaVersion: '2.0',
  contractVersion: 'classification-hybrid.2',
  policyVersion: mode === 'active' ? 'decision-evidence-active.2' : 'decision-shadow.1',
  mode,
  decisionMode: 'evidence_rules',
  calibrated: false,
  maxCandidatesPerContent,
  riskPolicyVersion: 'impact-risk.1',
  createdAt
});
const content = index => ({
  contentId: `content_${index}`,
  scope,
  modality: 'photo',
  evidenceIds: [`evidence_${index}`],
  lifecycle: 'active'
});
const observation = index => ({
  contentId: `content_${index}`,
  evidenceId: `evidence_${index}`,
  facet: 'event',
  rawValue: '家庭聚会',
  normalizedValue: '家庭聚会',
  supports: [{ evidenceId: `evidence_${index}`, quote: '家庭聚会' }],
  state: 'candidate'
});
const candidate = (from, to, patch = {}) => ({
  schemaVersion: '2.0',
  contractVersion: 'classification-hybrid.2',
  candidateId: `candidate_${from}_${to}_${patch.relation ?? 'same_story'}`,
  scope,
  fromContentId: `content_${from}`,
  toContentId: `content_${to}`,
  relation: 'same_story',
  rank: 1,
  retrievalScore: 0.8,
  method: 'exact-observation-retrieval.1',
  coverage: 'selected',
  reasons: ['event_overlap'],
  featureRefs: [],
  evidenceRefs: [`evidence_${from}`, `evidence_${to}`],
  createdAt,
  ...patch
});

function input(count, retrievalCandidates) {
  return {
    schemaVersion: '2.0',
    contractVersion: 'classification-hybrid.2',
    scope,
    contents: Array.from({ length: count }, (_, index) => content(index)),
    observations: Array.from({ length: count }, (_, index) => observation(index)),
    retrievalCandidates,
    explicitAssociations: [],
    decisionPolicy: policy(),
    createdAt
  };
}

test('sparse organizer evaluates only supplied candidates for 250 contents', () => {
  const candidates = Array.from({ length: 249 }, (_, index) => candidate(index, index + 1));
  const result = organizeSparseContent(input(250, candidates));
  assert.equal(result.version, SPARSE_CONTENT_ORGANIZATION_VERSION);
  assert.equal(result.retrievalAudit.candidateCount, 249);
  assert.equal(result.retrievalAudit.evaluatedCount, 249);
  assert.equal(result.associations.length, 249);
  assert.ok(result.associations.length < (250 * 249) / 2);
  assert.equal(result.stories.length, 250);
  assert.ok(result.decisionResults.every(item => item.shadow));
  assert.ok(result.associations.every(item => item.status !== 'user_confirmed'));
});

test('no retrieval candidate means singleton stories and no invented pair', () => {
  const result = organizeSparseContent(input(4, []));
  assert.equal(result.associations.length, 0);
  assert.equal(result.decisionResults.length, 0);
  assert.equal(result.stories.length, 4);
});

test('stage different is retained as a shadow separation and never merges stories', () => {
  const result = organizeSparseContent(input(2, [candidate(0, 1, {
    relation: 'same_event',
    stageDecision: 'different',
    reasons: ['stage_a_event_edge']
  })]));
  assert.equal(result.associations[0].status, 'not_selected');
  assert.equal(result.decisionResults[0].action, 'auto_separate');
  assert.equal(result.decisionResults[0].shadow, true);
  assert.equal(result.stories.length, 2);
});

test('active evidence rules group a supported Stage A same-event decision without a legacy score', () => {
  const value = input(2, [candidate(0, 1, {
    relation: 'same_event',
    stageDecision: 'same',
    reasons: ['stage_a_event_edge', 'two_sided_user_text_support']
  })]);
  value.decisionPolicy = policy(8, 'active');
  const result = organizeSparseContent(value);
  assert.equal(result.associations[0].score, undefined);
  assert.equal(result.associations[0].confidenceBand, undefined);
  assert.equal(result.associations[0].status, 'ai_auto');
  assert.equal(result.associations[0].decisionBasis, 'stage_relation');
  assert.equal(result.decisionResults[0].action, 'auto_link_candidate');
  assert.equal(result.decisionResults[0].userActionRequired, false);
  assert.ok(result.decisionResults[0].reasons.includes('stage_event_same'));
  assert.deepEqual(result.stories[0].memberContentIds, ['content_0', 'content_1']);
});

test('shadow policy records the same recommendation but never mutates story membership', () => {
  const result = organizeSparseContent(input(2, [candidate(0, 1, {
    relation: 'same_event', stageDecision: 'same', reasons: ['stage_a_event_edge']
  })]));
  assert.equal(result.decisionResults[0].action, 'auto_link_candidate');
  assert.equal(result.decisionResults[0].shadow, true);
  assert.equal(result.associations[0].status, 'not_selected');
  assert.equal(result.stories.length, 2);
});

test('active evidence decisions ignore retrieval scores and emit no legacy score fields', () => {
  const scoreLikeValues = [0, 0.25, 0.55, 0.8, 1];
  const sameEventResults = scoreLikeValues.map(retrievalScore => {
    const value = input(2, [candidate(0, 1, {
      relation: 'same_event',
      stageDecision: 'same',
      reasons: ['stage_a_event_edge'],
      retrievalScore
    })]);
    value.decisionPolicy = policy(8, 'active');
    return organizeSparseContent(value);
  });
  for(const result of sameEventResults) {
    assert.deepEqual(result, sameEventResults[0]);
    assert.equal(result.decisionResults[0].action, 'auto_link_candidate');
    assert.equal(result.associations[0].score, undefined);
    assert.equal(result.associations[0].confidenceBand, undefined);
  }

  const retrievalOnly = input(2, [candidate(0, 1, { retrievalScore: 1 })]);
  retrievalOnly.decisionPolicy = policy(8, 'active');
  const retrievalOnlyResult = organizeSparseContent(retrievalOnly);
  assert.equal(retrievalOnlyResult.decisionResults[0].action, 'keep_separate');
  assert.equal(retrievalOnlyResult.associations[0].status, 'not_selected');
});

test('unknown and retrieval-only candidates stay separate without creating user tasks', () => {
  const value = input(3, [
    candidate(0, 1, { relation: 'same_event', stageDecision: 'unknown', reasons: ['stage_a_event_edge'] }),
    candidate(1, 2, { candidateId: 'candidate_retrieval_only' })
  ]);
  value.observations[0].state = 'conflicted';
  value.decisionPolicy = policy(8, 'active');
  const result = organizeSparseContent(value);
  assert.deepEqual(result.decisionResults.map(item => item.action), ['keep_separate', 'keep_separate']);
  assert.ok(result.decisionResults.every(item => !item.userActionRequired));
  assert.equal(result.reviewItems.length, 0);
  assert.equal(result.stories.length, 3);
});

test('known different relation blocks transitive merge and requires one high-impact review', () => {
  const candidates = [
    candidate(0, 1, { relation: 'same_event', stageDecision: 'same', reasons: ['stage_a_event_edge'] }),
    candidate(1, 2, { relation: 'same_event', stageDecision: 'same', reasons: ['stage_a_event_edge'] }),
    candidate(0, 2, { relation: 'same_event', stageDecision: 'different', reasons: ['stage_a_event_edge'] })
  ];
  const value = input(3, candidates);
  value.decisionPolicy = policy(8, 'active');
  const result = organizeSparseContent(value);
  const reversed = input(3, [...candidates].reverse());
  reversed.decisionPolicy = policy(8, 'active');
  assert.deepEqual(result, organizeSparseContent(reversed));
  const blocked = result.decisionResults.find(item => item.candidateId === 'candidate_1_2_same_event');
  assert.equal(result.stories.length, 2);
  assert.equal(blocked.action, 'review');
  assert.equal(blocked.userActionRequired, true);
  assert.ok(blocked.reasons.includes('known_difference_blocks_merge'));
});

test('active clustering is candidate-order invariant and same-batch edges do not invent bridge risk', () => {
  const candidates = [
    candidate(0, 1, { relation: 'same_event', stageDecision: 'same', reasons: ['stage_a_event_edge'] }),
    candidate(2, 3, { relation: 'same_event', stageDecision: 'same', reasons: ['stage_a_event_edge'] }),
    candidate(1, 2, { relation: 'same_event', stageDecision: 'same', reasons: ['stage_a_event_edge'] })
  ];
  const forward = input(4, candidates);
  forward.decisionPolicy = policy(8, 'active');
  const reversed = input(4, [...candidates].reverse());
  reversed.decisionPolicy = policy(8, 'active');

  const forwardResult = organizeSparseContent(forward);
  const reversedResult = organizeSparseContent(reversed);
  assert.deepEqual(forwardResult, reversedResult);
  assert.equal(forwardResult.stories.length, 1);
  assert.equal(forwardResult.reviewItems.length, 0);
  assert.ok(forwardResult.decisionResults.every(item => item.groupImpact === 'singleton_pair'));
  assert.ok(forwardResult.decisionResults.every(item => item.action === 'auto_link_candidate'));
});

test('only pre-existing user-confirmed groups create bridge risk', () => {
  const value = input(4, [
    candidate(1, 2, { relation: 'same_event', stageDecision: 'same', reasons: ['stage_a_event_edge'] })
  ]);
  value.explicitAssociations = [
    {
      associationId: 'user_link_left', fromContentId: 'content_0', toContentId: 'content_1',
      relation: 'same_story', source: 'user_explicit', status: 'user_confirmed', method: 'user-selection.1',
      evidenceRefs: ['evidence_0', 'evidence_1'], createdAt
    },
    {
      associationId: 'user_link_right', fromContentId: 'content_2', toContentId: 'content_3',
      relation: 'same_story', source: 'user_explicit', status: 'user_confirmed', method: 'user-selection.1',
      evidenceRefs: ['evidence_2', 'evidence_3'], createdAt
    }
  ];
  value.decisionPolicy = policy(8, 'active');
  const result = organizeSparseContent(value);
  const decision = result.decisionResults.find(item => item.candidateId === 'candidate_1_2_same_event');
  assert.equal(result.stories.length, 2);
  assert.equal(decision.groupImpact, 'bridge_existing_groups');
  assert.equal(decision.action, 'review');
  assert.equal(decision.userActionRequired, true);
  assert.equal(result.reviewItems.length, 1);
});

test('a same-batch path cannot silently connect two pre-existing user-confirmed groups', () => {
  const candidates = [
    candidate(1, 2, { relation: 'same_event', stageDecision: 'same', reasons: ['stage_a_event_edge'] }),
    candidate(2, 3, { relation: 'same_event', stageDecision: 'same', reasons: ['stage_a_event_edge'] })
  ];
  const value = input(5, [...candidates].reverse());
  value.explicitAssociations = [
    {
      associationId: 'user_link_left', fromContentId: 'content_0', toContentId: 'content_1',
      relation: 'same_story', source: 'user_explicit', status: 'user_confirmed', method: 'user-selection.1',
      evidenceRefs: ['evidence_0', 'evidence_1'], createdAt
    },
    {
      associationId: 'user_link_right', fromContentId: 'content_3', toContentId: 'content_4',
      relation: 'same_story', source: 'user_explicit', status: 'user_confirmed', method: 'user-selection.1',
      evidenceRefs: ['evidence_3', 'evidence_4'], createdAt
    }
  ];
  value.decisionPolicy = policy(8, 'active');
  const result = organizeSparseContent(value);
  const bridge = result.decisionResults.find(item => item.candidateId === 'candidate_2_3_same_event');
  assert.equal(result.stories.length, 2);
  assert.equal(bridge.groupImpact, 'bridge_existing_groups');
  assert.equal(bridge.action, 'review');
  assert.equal(bridge.userActionRequired, true);
});

test('story copy prioritizes event time and place and excludes visual appearance descriptions', () => {
  const value = input(1, []);
  value.observations.push({
    contentId: 'content_0', evidenceId: 'evidence_0', facet: 'person',
    rawValue: '穿红色外套站在左边的人', supports: [{ evidenceId: 'evidence_0', sourceType: 'visual', quote: '左侧人物' }], state: 'candidate'
  }, {
    contentId: 'content_0', evidenceId: 'evidence_0', facet: 'time', rawValue: '第二天', normalizedValue: '第二天',
    temporal: { role: 'event', precision: 'relative' }, supports: [{ evidenceId: 'evidence_0', sourceType: 'user_text', quote: '第二天' }], state: 'candidate'
  }, {
    contentId: 'content_0', evidenceId: 'evidence_0', facet: 'place', rawValue: '湖边', normalizedValue: '湖边', placeKind: 'unresolved',
    supports: [{ evidenceId: 'evidence_0', sourceType: 'user_text', quote: '去了湖边' }], state: 'candidate'
  });
  const story = organizeSparseContent(value).stories[0];
  assert.equal(story.titleCandidate, '湖边的家庭聚会');
  assert.match(story.summaryCandidate, /记录家庭聚会/);
  assert.match(story.summaryCandidate, /时间：第二天/);
  assert.match(story.summaryCandidate, /地点：湖边/);
  assert.ok(!story.summaryCandidate.includes('红色外套'));
});

test('a conflicted singleton story is marked needs_review', () => {
  const value = input(1, []);
  value.observations[0].state = 'conflicted';
  assert.equal(organizeSparseContent(value).stories[0].state, 'needs_review');
});

test('active person-only candidate stays separate without creating a user task while person matching is disabled', () => {
  const value = input(2, [candidate(0, 1, { relation: 'same_person', candidateId: 'candidate_person_1' })]);
  value.decisionPolicy = policy(8, 'active');
  const result = organizeSparseContent(value);
  assert.equal(result.associations.length, 0);
  assert.equal(result.retrievalAudit.skippedPersonOnlyCount, 1);
  assert.equal(result.decisionResults[0].action, 'keep_separate');
  assert.equal(result.decisionResults[0].userActionRequired, false);
  assert.equal(result.reviewItems.length, 0);
  assert.equal(result.stories.length, 2);
});

test('explicit user relation wins over a retrieved candidate without confirming the generated story', () => {
  const value = input(2, [candidate(0, 1)]);
  value.explicitAssociations = [{
    associationId: 'user_link_1',
    fromContentId: 'content_0',
    toContentId: 'content_1',
    relation: 'same_story',
    source: 'user_explicit',
    status: 'user_confirmed',
    method: 'user-selection.1',
    evidenceRefs: ['evidence_0', 'evidence_1'],
    createdAt
  }];
  const result = organizeSparseContent(value);
  assert.equal(result.associations.length, 1);
  assert.equal(result.associations[0].status, 'user_confirmed');
  assert.equal(result.decisionResults.length, 0);
  assert.equal(result.stories[0].state, 'ai_candidate');
});

test('scope, lifecycle, evidence and per-content retrieval limit are enforced', () => {
  const crossScope = input(2, [candidate(0, 1)]);
  crossScope.retrievalCandidates[0].scope = { householdId: 'house_b', subjectId: 'elder_a' };
  assert.throws(() => validateSparseAssociationInput(crossScope), /CROSS_SCOPE/);

  const withdrawn = input(2, [candidate(0, 1)]);
  withdrawn.contents[1].lifecycle = 'withdrawn';
  assert.throws(() => validateSparseAssociationInput(withdrawn), /OBSERVATION_FOR_WITHDRAWN_OR_FOREIGN_CONTENT/);

  const foreignEvidence = input(2, [candidate(0, 1)]);
  foreignEvidence.retrievalCandidates[0].evidenceRefs = ['evidence_0', 'evidence_foreign'];
  assert.throws(() => validateSparseAssociationInput(foreignEvidence), /FOREIGN_RETRIEVAL_EVIDENCE/);

  const overLimit = input(4, [candidate(0, 1), candidate(0, 2), candidate(0, 3)]);
  overLimit.decisionPolicy = policy(2);
  assert.throws(() => validateSparseAssociationInput(overLimit), /RETRIEVAL_LIMIT_EXCEEDED/);

  const overIncomingLimit = input(4, [candidate(0, 3), candidate(1, 3), candidate(2, 3)]);
  overIncomingLimit.decisionPolicy = policy(2);
  assert.throws(() => validateSparseAssociationInput(overIncomingLimit), /RETRIEVAL_LIMIT_EXCEEDED/);
});

test('calibrated probability policy is rejected in shadow and active modes until implemented', () => {
  for(const mode of ['shadow', 'active']) {
    const value = input(2, [candidate(0, 1)]);
    value.decisionPolicy = {
      ...policy(),
      mode,
      decisionMode: 'calibrated_probability',
      calibrated: true,
      calibrationVersion: 'fixture-calibration.1',
      autoLinkMin: 0.95,
      autoSeparateMax: 0.05
    };
    assert.throws(() => validateSparseAssociationInput(value), /CALIBRATED_PROBABILITY_NOT_IMPLEMENTED/);
  }
});
