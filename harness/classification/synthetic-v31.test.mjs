import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { applyV31InputCorrection, applyV31TruthCorrection, STAGE_A_EVENT_LABELS, STAGE_A_SCENE_LABELS } from './prepare-synthetic-v31.mjs';
const require = createRequire(import.meta.url);
const contract = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/stage-a-contract.js`);

function input(groupId, context = { kind: 'album_upload', albumId: `album-${groupId}` }) {
  return {
    groupId,
    datasetId: 'sgx-t0-photorealistic-synthetic-v3',
    specVersion: '3.0.0',
    context,
    syntheticIdentity: {
      actorId: `actor-${groupId}`, subjectId: `subject-${groupId}`, ownerId: `owner-${groupId}`,
      contributorId: `contributor-${groupId}`, fictitious: true
    },
    lifecycle: 'active',
    sources: [
      { assetId: `asset:${groupId}:photo:001`, type: 'photo', status: 'active' },
      { assetId: `asset:${groupId}:user_text:001`, type: 'user_text', status: 'active' }
    ],
    bindings: [{
      bindingId: `binding:${groupId}:01`, sourceAssetId: `asset:${groupId}:user_text:001`,
      target: { kind: 'batch', targetAssetIds: [`asset:${groupId}:photo:001`] }, state: 'active'
    }]
  };
}

function truth(groupId) {
  return {
    datasetId: 'sgx-t0-photorealistic-synthetic-v3', specVersion: '3.0.0', groupId,
    reviewedBy: 'synthetic-v2-independent-acceptance-reuse', independentAcceptanceEvidence: '/old/ACCEPTED.json', notes: null,
    expected: {
      action: 'needs_review', riskLevel: 'high',
      facets: { event: [], scene: [], time: [], place: [], theme: [], peopleLabels: [], conflicts: [] }
    }
  };
}

test('v3.1 creates stable synthetic scope and preserves actor/subject/owner/contributor semantics', () => {
  const album = applyV31InputCorrection(input('sgx-v3-g001'));
  const transfer = applyV31InputCorrection(input('sgx-v3-g011', {
    kind: 'family_transfer', senderId: 'old-sender', recipientIds: ['old-recipient']
  }));
  assert.equal(album.context.scopeId, 'syn-household-alpha-exp');
  assert.equal(album.syntheticIdentity.actorId, 'syn-elder-alpha-exp');
  assert.equal(album.syntheticIdentity.subjectId, 'syn-elder-alpha-exp');
  assert.equal(transfer.context.scopeId, 'syn-household-alpha-exp');
  assert.equal(transfer.syntheticIdentity.actorId, 'syn-child-alpha-exp');
  assert.equal(transfer.syntheticIdentity.subjectId, 'syn-elder-alpha-exp');
  assert.equal(transfer.syntheticIdentity.ownerId, 'syn-child-alpha-exp');
  assert.deepEqual(transfer.context.recipientIds, ['syn-elder-alpha-exp']);
});

test('v3.1 converts known one-photo batch binding and withdraws all g016 sources', () => {
  const g005 = applyV31InputCorrection(input('sgx-v3-g005'));
  assert.deepEqual(g005.bindings[0].target, {
    kind: 'contents', targetAssetIds: ['asset:sgx-v3-g005:photo:001']
  });
  const g016 = applyV31InputCorrection(input('sgx-v3-g016'));
  assert.equal(g016.lifecycle, 'withdrawn');
  assert.ok(g016.sources.every(source => source.status === 'withdrawn'));
  assert.ok(g016.bindings.every(binding => binding.state === 'withdrawn'));
});

test('v3.1 removes invisible dates and records deliberate conflicts without reusing v2 acceptance', () => {
  const g007 = truth('sgx-v3-g007');
  g007.expected.facets.time = ['2021-05-02', '2026-09-27'];
  applyV31TruthCorrection(g007);
  assert.deepEqual(g007.expected.facets.time, ['2021-05-02']);
  assert.equal(g007.reviewedBy, 'codex-v31-real-model-truth-audit-r5-2026-09-29');
  assert.equal('independentAcceptanceEvidence' in g007, false);

  const g011 = truth('sgx-v3-g011');
  g011.expected.facets.time = ['2008', '2010'];
  applyV31TruthCorrection(g011);
  assert.deepEqual(g011.expected.facets.conflicts, ['time']);
  assert.match(g011.notes.v31Review[0], /2008_vs_2010/);
});

test('v3.1 r5 truth vocabulary matches the executable Stage A taxonomy', () => {
  assert.deepEqual(STAGE_A_EVENT_LABELS, [...contract.EVENT_LABELS]);
  assert.deepEqual(STAGE_A_SCENE_LABELS, [...contract.SCENE_LABELS]);

  const g013 = truth('sgx-v3-g013');
  g013.expected.facets.scene = ['社区活动'];
  applyV31TruthCorrection(g013);
  assert.deepEqual(g013.expected.facets.scene, ['户外', '室内', '社区活动']);

  const g023 = truth('sgx-v3-g023');
  g023.expected.facets.event = ['普通日常'];
  applyV31TruthCorrection(g023);
  assert.deepEqual(g023.expected.facets.event, ['兴趣活动']);

  const g025 = truth('sgx-v3-g025');
  g025.expected.facets.place = ['海边行程途中'];
  applyV31TruthCorrection(g025);
  assert.deepEqual(g025.expected.facets.place, []);
});

test('v3.1 treats uncertainty as partial review rather than fabricated literal values', () => {
  const g032 = truth('sgx-v3-g032');
  g032.expected.action = 'abstain';
  g032.expected.facets.time = ['1999'];
  applyV31TruthCorrection(g032);
  assert.equal(g032.expected.action, 'auto_organize');
  assert.deepEqual(g032.expected.facets.time, []);

  const g038 = truth('sgx-v3-g038');
  g038.expected.action = 'abstain';
  g038.expected.facets.event = ['unknown'];
  applyV31TruthCorrection(g038);
  assert.equal(g038.expected.action, 'needs_review');
  assert.deepEqual(g038.expected.facets.event, []);
});
