import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/stage-a-contract.js`);
const { adaptStageAForOrganization } = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/stage-a-organization-adapter.js`);
const { organizeSparseContent } = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/content-organization.js`);

const scope = { householdId: 'house_a', subjectId: 'elder_a' };
const createdAt = '2026-09-27T10:00:00.000Z';
const support = (photoId, source = 'visual', evidenceId) => ({ photoId, source, ...(evidenceId ? { evidenceId } : {}), quote: source === 'visual' ? '照片中的人物和场景' : '1982年在武汉家庭聚会' });
const photo = (photoId, active = true) => ({
  photoId,
  scope,
  revision: 1,
  sourceRef: `${photoId}_source`,
  sourceHash: contract.digest(`${photoId}_bytes`),
  mimeType: 'image/jpeg',
  caption: '',
  textEvidence: photoId === 'photo_1' ? [
    { evidenceId: 'text_1', revision: 1, sourceHash: contract.digest('text'), source: 'user_text', text: '1982年在武汉家庭聚会' },
    { evidenceId: 'asr_1', revision: 1, sourceHash: contract.digest('asr'), source: 'final_asr', text: '1982年在武汉家庭聚会' }
  ] : [],
  active
});
const observation = (photoId, faceId) => ({
  photoId,
  people: [{ faceId, description: '一位老人', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, supports: [support(photoId)] }],
  mentions: photoId === 'photo_1' ? [{ text: '张建国', supports: [support(photoId, 'user_text', 'text_1')] }] : [],
  times: [{ value: '1982', precision: 'year', role: 'event', supports: [photoId === 'photo_1' ? support(photoId, 'user_text', 'text_1') : support(photoId, 'ocr')] }],
  places: [{ label: '武汉', supports: [photoId === 'photo_1' ? support(photoId, 'final_asr', 'asr_1') : support(photoId)] }],
  events: [{ type: '家庭聚会', supports: [support(photoId)] }],
  scenes: [{ label: '室内', supports: [support(photoId)] }],
  unknownFacets: [],
  conflicts: []
});

function fixture() {
  const photos = [photo('photo_1'), photo('photo_2')];
  const request = {
    contractVersion: 'classification-stage-a.1',
    runId: 'run_bridge_1',
    scope,
    authorizationRevision: 'auth_1',
    trigger: 'upload',
    photos,
    references: [],
    corrections: [],
    budget: { maxRequests: 10, maxInputTokens: 100000, maxOutputTokens: 10000, maxCostCny: 5, deadlineAt: '2026-09-28T10:00:00.000Z', candidatesPerPhoto: 4, maxOutputPerRequest: 4096, maxCallDurationMs: 60000 }
  };
  const observations = Object.fromEntries(photos.map((item, index) => [item.photoId, {
    inputHash: contract.photoHash(item),
    version: 'mock-stage-a.1',
    value: observation(item.photoId, `face_${index + 1}`)
  }]));
  const deps = Object.fromEntries(photos.map(item => [item.photoId, contract.photoHash(item)]));
  const edge = {
    kind: 'event',
    left: { photoId: 'photo_1' },
    right: { photoId: 'photo_2' },
    decision: 'same',
    supports: [support('photo_1'), support('photo_2')],
    rationale: '同一场家庭聚会',
    deps,
    origin: 'ai'
  };
  const snapshot = {
    scope,
    revision: 1,
    version: 'mock-stage-a.1',
    authorizationRevision: 'auth_1',
    contextHash: contract.digest('context'),
    observations,
    edges: [edge],
    groups: [
      { groupId: 'person_group_1', kind: 'person', members: [{ photoId: 'photo_1', faceId: 'face_1' }, { photoId: 'photo_2', faceId: 'face_2' }], revision: 1, state: 'ai_organized', usableForOrganization: true, identity: { personId: 'person_1', displayName: '张建国', state: 'reference_label_candidate' }, supersedes: [] },
      { groupId: 'event_group_1', kind: 'event', members: [{ photoId: 'photo_1' }, { photoId: 'photo_2' }], revision: 1, state: 'ai_organized', usableForOrganization: true, supersedes: [] }
    ],
    referencesHash: contract.digest([]),
    correctionsHash: contract.digest([]),
    reviewItems: [],
    candidateTraces: [],
    pendingPhotoIds: [],
    workflowStatus: 'succeeded'
  };
  const result = {
    contractVersion: 'classification-stage-a.1',
    runId: request.runId,
    scope,
    workflowStatus: 'succeeded',
    evidenceStatus: 'mock_transport',
    semanticValidation: 'not_evaluated',
    snapshot,
    changedPhotoIds: photos.map(item => item.photoId),
    invalidatedPhotoIds: [],
    retiredGroupIds: [],
    candidateTraces: [],
    reviewItems: [],
    errors: [],
    usage: { requests: 0, images: 0, inputTokens: 0, outputTokens: 0, costCny: 0, latencyMs: 0, records: [] }
  };
  return { request, result, edge };
}

test('stage A bridge preserves image, user text and final ASR evidence', () => {
  const { request, result } = fixture();
  const adapted = adaptStageAForOrganization({ request, result, createdAt });
  assert.deepEqual(adapted.contents[0].evidenceIds, ['photo_1', 'text_1', 'asr_1']);
  assert.ok(adapted.observations.some(item => item.facet === 'person' && item.rawValue === '张建国' && item.normalizedValue === 'person_group_1'));
  assert.ok(adapted.observations.some(item => item.evidenceId === 'text_1' && item.supports[0].quote.includes('1982')));
  assert.ok(adapted.observations.some(item => item.evidenceId === 'asr_1' && item.rawValue === '武汉'));
  assert.equal(adapted.audit.mappedContentCount, 2);
  assert.equal(adapted.audit.sourceGroupIds.length, 2);
});

test('stage A groups remain AI candidates and technical group ids do not become story titles', () => {
  const { request, result } = fixture();
  const adapted = adaptStageAForOrganization({ request, result, createdAt });
  const { contents, observations, retrievalCandidates, explicitAssociations } = adapted;
  const organized = organizeSparseContent({
    schemaVersion: '1.0',
    contractVersion: 'classification-hybrid.1',
    scope,
    contents,
    observations,
    retrievalCandidates,
    explicitAssociations,
    decisionPolicy: { schemaVersion: '1.0', contractVersion: 'classification-hybrid.1', policyVersion: 'decision-shadow.1', mode: 'shadow', calibrated: false, maxCandidatesPerContent: 8, riskPolicyVersion: 'impact-risk.1', createdAt },
    createdAt
  });
  assert.ok(organized.associations.every(item => item.status !== 'user_confirmed'));
  assert.ok(organized.stories.every(item => !item.titleCandidate.includes('group_')));
  assert.ok(organized.decisionResults.every(item => item.shadow));
});

test('an explicit user event correction is the only bridge path to user_confirmed', () => {
  const { request, result, edge } = fixture();
  result.snapshot.edges = [{ ...edge, origin: 'user' }];
  const adapted = adaptStageAForOrganization({ request, result, createdAt });
  assert.equal(adapted.explicitAssociations.length, 1);
  assert.equal(adapted.explicitAssociations[0].status, 'user_confirmed');
  assert.equal(adapted.retrievalCandidates.filter(item => item.relation === 'same_event').length, 0);
});

test('bridge rejects missing snapshot, cross scope and authorization drift', () => {
  const noSnapshot = fixture();
  delete noSnapshot.result.snapshot;
  assert.throws(() => adaptStageAForOrganization({ request: noSnapshot.request, result: noSnapshot.result, createdAt }), /STAGE_A_SNAPSHOT_REQUIRED/);

  const crossScope = fixture();
  crossScope.result.scope = { householdId: 'house_b', subjectId: 'elder_a' };
  assert.throws(() => adaptStageAForOrganization({ request: crossScope.request, result: crossScope.result, createdAt }), /CROSS_SCOPE/);

  const stale = fixture();
  stale.result.snapshot.authorizationRevision = 'auth_old';
  assert.throws(() => adaptStageAForOrganization({ request: stale.request, result: stale.result, createdAt }), /AUTHORIZATION_CHANGED/);
});

test('withdrawn photos cannot keep observations or relationship edges', () => {
  const withdrawnObservation = fixture();
  withdrawnObservation.request.photos[1].active = false;
  assert.throws(() => adaptStageAForOrganization({ request: withdrawnObservation.request, result: withdrawnObservation.result, createdAt }), /STAGE_A_OBSERVATION_FOR_INACTIVE_CONTENT/);

  const withdrawnEdge = fixture();
  withdrawnEdge.request.photos[1].active = false;
  delete withdrawnEdge.result.snapshot.observations.photo_2;
  assert.throws(() => adaptStageAForOrganization({ request: withdrawnEdge.request, result: withdrawnEdge.result, createdAt }), /STAGE_A_EDGE_FOR_INACTIVE_CONTENT/);
});
