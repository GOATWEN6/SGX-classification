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
const policy = (maxCandidatesPerContent = 8) => ({
  schemaVersion: '1.0',
  contractVersion: 'classification-hybrid.1',
  policyVersion: 'decision-shadow.1',
  mode: 'shadow',
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
  schemaVersion: '1.0',
  contractVersion: 'classification-hybrid.1',
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
    schemaVersion: '1.0',
    contractVersion: 'classification-hybrid.1',
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
  const result = organizeSparseContent(input(2, [candidate(0, 1, { stageDecision: 'different' })]));
  assert.equal(result.associations[0].status, 'not_selected');
  assert.equal(result.decisionResults[0].action, 'auto_separate');
  assert.equal(result.decisionResults[0].shadow, true);
  assert.equal(result.stories.length, 2);
});

test('person-only candidate does not become a story edge', () => {
  const result = organizeSparseContent(input(2, [candidate(0, 1, { relation: 'same_person', candidateId: 'candidate_person_1' })]));
  assert.equal(result.associations.length, 0);
  assert.equal(result.retrievalAudit.skippedPersonOnlyCount, 1);
  assert.equal(result.decisionResults[0].action, 'review');
  assert.equal(result.stories.length, 2);
});

test('explicit user relation wins over a retrieved candidate', () => {
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
  assert.equal(result.stories[0].state, 'user_confirmed');
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
});

test('active decision policy is rejected until calibrated scorer is implemented', () => {
  const value = input(2, [candidate(0, 1)]);
  value.decisionPolicy = {
    ...policy(),
    mode: 'active',
    calibrated: true,
    calibrationVersion: 'fixture-calibration.1',
    autoLinkMin: 0.95,
    autoSeparateMax: 0.05
  };
  assert.throws(() => validateSparseAssociationInput(value), /ACTIVE_DECISION_POLICY_NOT_IMPLEMENTED/);
});
