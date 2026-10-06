import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const build = process.env.CLASSIFICATION_BUILD_DIR;
const { buildLabSubmission } = require(`${build}/src/lib/algorithms/classification/lab-contract.js`);
const { DeterministicLabProvider, createConfiguredLabProvider } = require(`${build}/src/lib/algorithms/classification/lab-provider.js`);
const { FileClassificationLabStore } = require(`${build}/src/lib/algorithms/classification/lab-store.js`);
const { applyClassificationLabAction, canReadClassificationLabAsset } = require(`${build}/src/lib/algorithms/classification/lab-actions.js`);
const { requireClassificationT1Access, requireLocalClassificationLab } = require(`${build}/src/lib/algorithms/classification/lab-http.js`);
const { submitClassificationLabJob, classificationLabCapabilities } = require(`${build}/src/lib/algorithms/classification/lab-service.js`);

function png(index, width = 4, height = 3) {
  const bytes = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(index, 24);
  return bytes;
}

function submission(patch = {}) {
  return {
    scope: { householdId: 'house_lab', subjectId: 'elder_lab' },
    actorId: 'elder_lab',
    contextKind: 'album_upload',
    recipientIds: [],
    images: [
      { filename: '老照片一.png', mimeType: 'image/png', bytes: png(1) },
      { filename: '老照片二.png', mimeType: 'image/png', bytes: png(2) }
    ],
    userText: '这是1985年在北京的同学聚会',
    finalAsr: '后来我们又在北京见面',
    userTextTargetIndexes: [0, 1],
    finalAsrTargetIndexes: null,
    submittedAt: '2026-09-27T12:00:00.000Z',
    ...patch
  };
}

test('lab BFF input becomes server-built v2 Evidence and deterministic story output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabStore(root);
  const job = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  assert.equal(job.status, 'succeeded');
  assert.equal(job.envelope.specVersion, '2.0.0');
  assert.equal(job.envelope.contractVersion, 'classification-ingestion.2');
  assert.equal(job.envelope.evidence.length, 4);
  assert.equal(job.metrics.modelRequests, 0);
  assert.equal(job.metrics.costCny, 0);
  assert.equal(job.result.provider.accuracyClaim, 'not_evaluated');
  assert.equal(job.result.provider.modelVersion, 'none');
  const joined = job.result.organization.stories.find(story => story.memberContentIds.length === 3);
  assert.ok(joined);
  assert.equal(joined.titleCandidate, '北京的聚会');
  assert.ok(Object.values(job.originalTextByEvidenceId).includes('这是1985年在北京的同学聚会'));
  const image = job.envelope.evidence.find(item => item.lifecycleState !== 'deleted' && item.modality === 'image');
  const asset = await store.readAsset(job.jobId, image.evidenceId);
  assert.equal(asset.ref.mimeType, 'image/png');
  assert.deepEqual(asset.bytes, png(1));
});

test('identical local submission is idempotent and different subjects stay isolated', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabStore(root);
  const first = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  const replay = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  assert.equal(first.jobId, replay.jobId);
  assert.equal((await store.list()).length, 1);
  const other = await submitClassificationLabJob(submission({ scope: { householdId: 'house_lab', subjectId: 'elder_other' } }), store, new DeterministicLabProvider());
  assert.notEqual(first.jobId, other.jobId);
  assert.equal((await store.list()).length, 2);
});

test('family transfer receives frozen inbox policy while invalid media and bindings stop before storage', () => {
  const family = buildLabSubmission(submission({
    contextKind: 'family_transfer', actorId: 'daughter_lab', senderId: 'daughter_lab', recipientIds: ['elder_lab']
  }));
  assert.equal(family.envelope.reviewPolicy.remindAfterDays, 3);
  assert.equal(family.envelope.reviewPolicy.hideFromHomeAfterDays, 7);
  assert.throws(() => buildLabSubmission(submission({ images: [{ filename: 'bad.png', mimeType: 'image/png', bytes: Buffer.from('not an image') }] })), /MIME_SIGNATURE_OR_DIMENSIONS_MISMATCH/);
  assert.throws(() => buildLabSubmission(submission({ userTextTargetIndexes: [4] })), /TARGET_IMAGE_INDEX_OUT_OF_RANGE/);
  assert.throws(() => buildLabSubmission(submission({ images: [], userText: '', finalAsr: '', userTextTargetIndexes: null, finalAsrTargetIndexes: null })), /EMPTY_SUBMISSION/);
});

test('lab provider selection fails closed and capabilities do not claim model accuracy', () => {
  assert.equal(createConfiguredLabProvider('deterministic').mode, 'deterministic');
  assert.throws(() => createConfiguredLabProvider('qwen'), /REAL_PROVIDER_ADAPTER_NOT_CONFIGURED/);
  const capabilities = classificationLabCapabilities();
  assert.equal(capabilities.realProviderConfigured, false);
  assert.equal(capabilities.accuracyClaim, 'not_evaluated');
  assert.equal(capabilities.productionDatabase, false);
  assert.equal(capabilities.productionQueue, false);
});

test('lab HTTP gate is disabled by default, loopback-only and requires a mutation header', () => {
  const prior = process.env.CLASSIFICATION_LAB_ENABLED;
  delete process.env.CLASSIFICATION_LAB_ENABLED;
  assert.throws(() => requireLocalClassificationLab(new Request('http://127.0.0.1/api/classification-lab')), /CLASSIFICATION_LAB_DISABLED/);
  process.env.CLASSIFICATION_LAB_ENABLED = 'true';
  assert.throws(() => requireLocalClassificationLab(new Request('http://192.0.2.5/api/classification-lab')), /CLASSIFICATION_LAB_LOOPBACK_ONLY/);
  assert.throws(() => requireLocalClassificationLab(new Request('http://127.0.0.1/api/classification-lab'), true), /CLASSIFICATION_LAB_HEADER_REQUIRED/);
  assert.doesNotThrow(() => requireLocalClassificationLab(new Request('http://127.0.0.1/api/classification-lab', { headers: { 'x-sgx-classification-lab': '1', origin: 'http://localhost:3000' } }), true));
  if(prior === undefined) delete process.env.CLASSIFICATION_LAB_ENABLED; else process.env.CLASSIFICATION_LAB_ENABLED = prior;
});

test('T1 staging access stays local by default and requires a separate bearer token externally', () => {
  const prior = Object.fromEntries([
    'CLASSIFICATION_LAB_ENABLED',
    'CLASSIFICATION_T1_EXTERNAL_ACCESS_ENABLED',
    'CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN',
  ].map(key => [key, process.env[key]]));
  process.env.CLASSIFICATION_LAB_ENABLED = 'true';
  delete process.env.CLASSIFICATION_T1_EXTERNAL_ACCESS_ENABLED;
  delete process.env.CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN;
  assert.doesNotThrow(() => requireClassificationT1Access(new Request('http://127.0.0.1/api/classification-lab/t1')));
  const externalRequest = (headers = {}) => new Request('http://127.0.0.1/api/classification-lab/t1', {
    headers: { 'cf-ray': 'test-ray', 'x-forwarded-host': 'staging.example', ...headers },
  });
  assert.throws(() => requireClassificationT1Access(externalRequest()), /CLASSIFICATION_T1_EXTERNAL_ACCESS_DISABLED/);
  process.env.CLASSIFICATION_T1_EXTERNAL_ACCESS_ENABLED = 'true';
  process.env.CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN = 't'.repeat(48);
  assert.throws(() => requireClassificationT1Access(externalRequest()), /CLASSIFICATION_T1_EXTERNAL_ACCESS_UNAUTHORIZED/);
  assert.throws(() => requireClassificationT1Access(externalRequest({
    authorization: `Bearer ${'t'.repeat(48)}`, origin: 'https://frontend.example',
  })), /CLASSIFICATION_T1_EXTERNAL_ORIGIN_REJECTED/);
  assert.throws(() => requireClassificationT1Access(externalRequest({
    authorization: `Bearer ${'t'.repeat(48)}`,
  }), true), /CLASSIFICATION_LAB_HEADER_REQUIRED/);
  assert.doesNotThrow(() => requireClassificationT1Access(externalRequest({
    authorization: `Bearer ${'t'.repeat(48)}`, 'x-sgx-classification-lab': '1',
  }), true));
  for(const [key, value] of Object.entries(prior)) {
    if(value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('lab store writes only bounded job and asset files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabStore(root);
  const job = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  const entries = await readdir(path.join(root, job.jobId));
  assert.deepEqual(entries.sort(), ['assets', 'job.json']);
});

test('story acceptance is append-only, idempotent and never overwrites provider output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabStore(root);
  const job = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  const storyId = job.result.organization.stories[0].storyId;
  assert.equal(job.result.organization.stories[0].state, 'ai_candidate');
  const request = {
    jobId: job.jobId, actionId: 'action_accept_1', expectedUpdatedAt: job.updatedAt,
    kind: 'accept_story', targetIds: [storyId], actorId: job.envelope.actorId
  };
  const accepted = await applyClassificationLabAction(request, store, () => '2026-09-27T23:50:00.000Z');
  assert.equal(accepted.result.organization.stories[0].state, 'user_confirmed');
  assert.equal(accepted.view.actionCount, 1);
  const stored = await store.get(job.jobId);
  assert.equal(stored.result.organization.stories[0].state, 'ai_candidate');
  assert.equal(stored.actions.length, 1);
  const replay = await applyClassificationLabAction(request, store, () => '2026-09-27T23:51:00.000Z');
  assert.equal(replay.actions.length, 1);
  await assert.rejects(() => applyClassificationLabAction({ ...request, actionId: 'action_stale_1' }, store), /LAB_ACTION_STALE/);
  await assert.rejects(() => applyClassificationLabAction({ ...request, actionId: 'action_forbidden_1', expectedUpdatedAt: accepted.updatedAt, actorId: 'other_actor' }, store), /LAB_ACTION_ACTOR_FORBIDDEN/);
});

test('relation rejection, story merge and split materialize reversible organization views', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabStore(root);
  const oneImage = submission({
    images: [{ filename: '单张.png', mimeType: 'image/png', bytes: png(7) }],
    finalAsr: undefined,
    finalAsrTargetIndexes: null,
    userTextTargetIndexes: [0]
  });
  const linked = await submitClassificationLabJob(oneImage, store, new DeterministicLabProvider());
  const explicit = linked.result.organization.associations.find(item => item.source === 'user_explicit');
  const rejected = await applyClassificationLabAction({
    jobId: linked.jobId, actionId: 'action_reject_1', expectedUpdatedAt: linked.updatedAt,
    kind: 'reject_association', targetIds: [explicit.associationId], actorId: linked.envelope.actorId
  }, store, () => '2026-09-27T23:40:00.000Z');
  assert.equal(rejected.result.organization.associations.find(item => item.associationId === explicit.associationId).status, 'rejected');
  assert.equal(rejected.result.organization.stories.length, 2);

  const merged = await applyClassificationLabAction({
    jobId: linked.jobId, actionId: 'action_merge_1', expectedUpdatedAt: rejected.updatedAt,
    kind: 'merge_stories', targetIds: rejected.result.organization.stories.map(story => story.storyId), actorId: linked.envelope.actorId
  }, store, () => '2026-09-27T23:41:00.000Z');
  assert.equal(merged.result.organization.stories.length, 1);
  assert.equal(merged.result.organization.stories[0].state, 'ai_candidate');
  const split = await applyClassificationLabAction({
    jobId: linked.jobId, actionId: 'action_split_1', expectedUpdatedAt: merged.updatedAt,
    kind: 'split_content', targetIds: [merged.result.organization.stories[0].memberContentIds[0]], actorId: linked.envelope.actorId
  }, store, () => '2026-09-27T23:42:00.000Z');
  assert.equal(split.result.organization.stories.length, 2);
  const removedContentId = split.result.organization.stories[0].memberContentIds[0];
  const removed = await applyClassificationLabAction({
    jobId: linked.jobId, actionId: 'action_remove_1', expectedUpdatedAt: split.updatedAt,
    kind: 'remove_content', targetIds: [removedContentId], actorId: linked.envelope.actorId
  }, store, () => '2026-09-27T23:43:00.000Z');
  assert.ok(removed.result.organization.stories.every(story => !story.memberContentIds.includes(removedContentId)));
});

test('evidence deletion and authorization revocation invalidate the view and asset access', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabStore(root);
  const job = await submitClassificationLabJob(submission(), store, new DeterministicLabProvider());
  const evidence = job.envelope.evidence.find(item => item.lifecycleState === 'active' && item.modality === 'image');
  const deleted = await applyClassificationLabAction({
    jobId: job.jobId, actionId: 'action_delete_1', expectedUpdatedAt: job.updatedAt,
    kind: 'delete_evidence', targetIds: [evidence.evidenceId], actorId: job.envelope.actorId
  }, store, () => '2026-09-27T23:30:00.000Z');
  assert.equal(deleted.envelope.evidence.find(item => item.evidenceId === evidence.evidenceId).lifecycleState, 'deleted');
  assert.equal(canReadClassificationLabAsset(deleted, evidence.evidenceId), false);
  assert.ok(deleted.result.organization.stories.every(story => !story.memberContentIds.some(contentId => deleted.envelope.contents.find(content => content.contentId === contentId)?.evidenceId === evidence.evidenceId)));
  const stored = await store.get(job.jobId);
  assert.equal(stored.envelope.evidence.find(item => item.evidenceId === evidence.evidenceId).lifecycleState, 'active');
  assert.ok(stored.assetRefs.some(item => item.evidenceId === evidence.evidenceId));

  const revoked = await applyClassificationLabAction({
    jobId: job.jobId, actionId: 'action_revoke_1', expectedUpdatedAt: deleted.updatedAt,
    kind: 'revoke_authorization', targetIds: [deleted.envelope.authorizationRevision], actorId: job.envelope.actorId
  }, store, () => '2026-09-27T23:31:00.000Z');
  assert.equal(revoked.status, 'cancelled');
  assert.equal(revoked.view.authorizationState, 'revoked');
  assert.ok(revoked.result.organization.stories.every(story => story.state === 'withdrawn'));
  assert.equal(canReadClassificationLabAsset(revoked, job.assetRefs[1].evidenceId), false);
  await assert.rejects(() => applyClassificationLabAction({
    jobId: job.jobId, actionId: 'action_after_revoke', expectedUpdatedAt: revoked.updatedAt,
    kind: 'delete_evidence', targetIds: [job.assetRefs[1].evidenceId], actorId: job.envelope.actorId
  }, store), /LAB_AUTHORIZATION_REVOKED/);
});
