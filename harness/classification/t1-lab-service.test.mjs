import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const build = process.env.CLASSIFICATION_BUILD_DIR;
const {
  CLASSIFICATION_T1_LAB_VERSION,
  ClassificationT1LabService,
} = require(`${build}/src/lib/algorithms/classification/t1-lab-service.js`);

const FIXED_NOW = Date.parse('2026-10-03T08:00:00.000Z');

function png(index) {
  const bytes = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(4, 16);
  bytes.writeUInt32BE(3, 20);
  bytes.writeUInt32BE(index, 24);
  return bytes;
}

function submission(index, patch = {}) {
  return {
    scope: { householdId: 'house_t1_product', subjectId: 'elder_t1_product' },
    actorId: 'daughter_t1_product',
    contextKind: 'album_upload',
    recipientIds: [],
    images: [{
      filename: `round-${index}.png`,
      mimeType: 'image/png',
      bytes: png(index),
    }],
    userText: `第${index}轮上传的家庭照片`,
    userTextTargetIndexes: [0],
    finalAsrTargetIndexes: null,
    submittedAt: `2026-10-03T08:0${index}:00.000Z`,
    ...patch,
  };
}

test('T1 lab submits worker-pull jobs with stable session authorization and consent-gated person matching', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-t1-lab.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ClassificationT1LabService({
    dataRoot: root,
    provider: 'qwen',
    model: 'qwen3.7-flash-2026-07-15',
    inputCnyPerMillion: 1.2,
    outputCnyPerMillion: 4.8,
  }, () => FIXED_NOW);

  const first = await service.submit({
    submission: submission(1),
    personMatchingAuthorized: true,
  });
  assert.equal(first.version, CLASSIFICATION_T1_LAB_VERSION);
  assert.equal(first.round, 1);
  assert.equal(first.job.status, 'pending');
  const firstRecord = await service.store.get(first.job.jobId);
  const firstGuard = await service.guardStore.get(first.job.jobId);
  assert.equal(firstRecord.executionProfile.providerMode, 'stage_a_real');
  assert.equal(firstRecord.executionProfile.modelVersion, 'qwen3.7-flash-2026-07-15');
  assert.equal(firstGuard.allowPersonMatching, true);
  assert.equal(firstGuard.personMatchingEvidenceIds.length, 1);
  assert.ok(firstGuard.evidence.find((value) => value.evidenceId === firstGuard.personMatchingEvidenceIds[0]).personConsentRef);

  const second = await service.submit({
    sessionId: first.session.sessionId,
    submission: submission(2),
    personMatchingAuthorized: false,
  });
  assert.equal(second.round, 2);
  assert.equal(second.session.authorizationRevision, first.session.authorizationRevision);
  assert.notEqual(second.job.jobId, first.job.jobId);
  const secondRecord = await service.store.get(second.job.jobId);
  const secondGuard = await service.guardStore.get(second.job.jobId);
  assert.equal(secondRecord.authorization.authorizationRevision, firstRecord.authorization.authorizationRevision);
  assert.equal(secondGuard.allowPersonMatching, false);
  assert.deepEqual(secondGuard.personMatchingEvidenceIds ?? [], []);
  assert.equal((await service.list(first.session.sessionId)).length, 2);

  await assert.rejects(service.submit({
    sessionId: first.session.sessionId,
    submission: submission(3, {
      scope: { householdId: 'house_other', subjectId: 'elder_t1_product' },
    }),
    personMatchingAuthorized: false,
  }), /T1_SESSION_SCOPE_MISMATCH/);
});
