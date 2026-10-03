import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const build = process.env.CLASSIFICATION_BUILD_DIR;
const {
  CLASSIFICATION_T1_ASR_PROTOCOL_VERSION,
  ClassificationT1AsrService,
} = require(`${build}/src/lib/algorithms/classification/t1-asr-prejob.js`);

const FIXED_NOW = Date.parse('2026-10-03T10:00:00.000Z');
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(40, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(4, 40);
  return bytes;
}

function identity(lease) {
  return {
    workerId: 'virtai-asr-worker',
    jobId: lease.jobId,
    sessionId: lease.sessionId,
    leaseToken: lease.leaseToken,
    jobRevision: lease.jobRevision,
    attemptRevision: lease.attemptRevision,
    authorizationRevision: lease.authorizationRevision,
    sourceSha256: lease.audio.sha256,
  };
}

test('T1 ASR prejob preserves raw audio, leases once and returns a frozen final transcript', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-t1-asr.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ClassificationT1AsrService({
    dataRoot: root,
    publicBaseUrl: 'http://127.0.0.1:3137',
    nowMs: () => FIXED_NOW,
  });
  const audio = wav();
  const submitted = await service.submit({
    scope: { householdId: 'house-asr', subjectId: 'elder-asr' },
    actorId: 'daughter-asr',
    filename: '家里故事.wav',
    mimeType: 'audio/wav',
    bytes: audio,
  });
  assert.equal(submitted.job.status, 'pending');
  assert.equal(submitted.job.audio.sourceSha256, digest(audio));
  assert.equal('lease' in submitted.job, false);

  const response = await service.lease({
    protocolVersion: CLASSIFICATION_T1_ASR_PROTOCOL_VERSION,
    requestId: 'request-asr-1',
    workerId: 'virtai-asr-worker',
    maxJobs: 1,
    features: ['asr'],
  });
  assert.equal(response.leases.length, 1);
  const [lease] = response.leases;
  assert.equal((await service.readAudio(lease.jobId, lease.leaseToken)).bytes.equals(audio), true);

  const firstIdentity = identity(lease);
  const heartbeat = await service.heartbeat(lease.jobId, {
    protocolVersion: CLASSIFICATION_T1_ASR_PROTOCOL_VERSION,
    requestId: 'request-asr-2',
    identity: firstIdentity,
    stage: 'asr',
    progress: 60,
  });
  assert.equal(heartbeat.control, 'continue');
  await service.complete(lease.jobId, {
    protocolVersion: CLASSIFICATION_T1_ASR_PROTOCOL_VERSION,
    requestId: 'request-asr-3',
    identity: firstIdentity,
    result: {
      sourceSha256: digest(audio),
      sourceByteLength: audio.length,
      audioFormat: 'wav-pcm-s16le',
      sampleRateHz: 16_000,
      channels: 1,
      durationMs: 100,
      modelId: 'SenseVoiceSmall',
      modelVersion: '1.0',
      modelRevision: 'local-revision-1',
      runtimeId: 'funasr',
      runtimeVersion: '1.2.7',
      text: '这是一次家庭聚会。',
      language: 'zh',
      segments: [{ text: '这是一次家庭聚会。', startMs: 0, endMs: 100 }],
    },
  });
  const done = await service.get(submitted.session.sessionId, lease.jobId);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.text, '这是一次家庭聚会。');
  assert.equal('lease' in done, false);
  assert.equal((await service.lease({
    protocolVersion: CLASSIFICATION_T1_ASR_PROTOCOL_VERSION,
    requestId: 'request-asr-4',
    workerId: 'virtai-asr-worker',
    maxJobs: 1,
    features: ['asr'],
  })).leases.length, 0);
});

test('T1 ASR prejob rejects non-WAV input before persisting a job', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-t1-asr-invalid.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ClassificationT1AsrService({
    dataRoot: root,
    publicBaseUrl: 'http://127.0.0.1:3137',
    nowMs: () => FIXED_NOW,
  });
  await assert.rejects(service.submit({
    scope: { householdId: 'house-asr', subjectId: 'elder-asr' },
    actorId: 'daughter-asr',
    filename: 'recording.webm',
    mimeType: 'audio/webm',
    bytes: Buffer.from('webm'),
  }), /ASR_WAV_REQUIRED/);
  assert.equal((await service.store.list()).length, 0);
});
