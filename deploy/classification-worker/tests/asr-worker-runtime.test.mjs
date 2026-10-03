import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ASR_PROTOCOL_VERSION,
  AsrWorkerRuntime,
} from '../runtime/asr-worker-runtime.mjs';

const FIXED_NOW = Date.parse('2026-10-03T10:00:00.000Z');
const future = minutes => new Date(FIXED_NOW + minutes * 60_000).toISOString();
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function lease(audio) {
  return {
    jobId: 'asr-job-1',
    sessionId: 't1-session-1',
    leaseToken: 'l'.repeat(64),
    leaseExpiresAt: future(5),
    jobRevision: 1,
    attemptRevision: 1,
    scope: { householdId: 'house-1', subjectId: 'elder-1' },
    authorizationRevision: 'auth-1',
    deadlineAt: future(10),
    audio: {
      artifactId: 'asr-audio-1',
      downloadUrl: 'https://objects.example.test/audio-1',
      expiresAt: future(4),
      sha256: digest(audio),
      byteLength: audio.length,
      mimeType: 'audio/wav',
    },
  };
}

test('ASR worker downloads one WAV, calls local ASR once, completes and removes scratch', async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'sgx-asr-worker.'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const audio = Buffer.from('RIFF....WAVEfmt data');
  const leased = lease(audio);
  const heartbeats = [];
  const completes = [];
  const failures = [];
  let asrCalls = 0;
  const controlPlane = {
    async asrLease(body) {
      return { protocolVersion: ASR_PROTOCOL_VERSION, requestId: body.requestId, leases: [leased] };
    },
    async asrHeartbeat(_jobId, body) {
      heartbeats.push(body);
      return {
        protocolVersion: ASR_PROTOCOL_VERSION,
        requestId: body.requestId,
        leaseExpiresAt: future(5),
        control: 'continue',
      };
    },
    async asrComplete(_jobId, body) { completes.push(body); },
    async asrFail(_jobId, body) { failures.push(body); },
  };
  const runtime = new AsrWorkerRuntime({
    workerId: 'virtai-asr-worker',
    controlPlane,
    artifacts: {
      async downloadToFile({ destination }) {
        await writeFile(destination, audio, { flag: 'wx' });
        return { sha256: digest(audio), byteLength: audio.length };
      },
    },
    featureService: {
      async asr(source) {
        asrCalls += 1;
        assert.equal(source.sourceSha256, digest(audio));
        return {
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
        };
      },
    },
    scratchRoot: scratch,
    now: () => FIXED_NOW,
    idFactory: (() => { let index = 0; return () => `request-${++index}`; })(),
    logger: { info() {}, error() {} },
  });
  assert.deepEqual(await runtime.runOnce(), { leased: 1, completed: 1, failed: 0, skipped: 0 });
  assert.equal(asrCalls, 1);
  assert.equal(heartbeats.length, 3);
  assert.equal(completes.length, 1);
  assert.equal(completes[0].result.text, '这是一次家庭聚会。');
  assert.equal(failures.length, 0);
  assert.deepEqual(await runtime.runOnce(), { leased: 1, completed: 0, failed: 0, skipped: 1 });
});

test('ASR worker reports a hash mismatch without calling ASR or retrying', async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'sgx-asr-worker-hash.'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const audio = Buffer.from('RIFF....WAVEfmt data');
  const leased = lease(audio);
  const failures = [];
  let asrCalls = 0;
  const runtime = new AsrWorkerRuntime({
    workerId: 'virtai-asr-worker',
    controlPlane: {
      async asrLease(body) { return { protocolVersion: ASR_PROTOCOL_VERSION, requestId: body.requestId, leases: [leased] }; },
      async asrHeartbeat(_jobId, body) {
        return { protocolVersion: ASR_PROTOCOL_VERSION, requestId: body.requestId, leaseExpiresAt: future(5), control: 'continue' };
      },
      async asrComplete() { throw new Error('unexpected complete'); },
      async asrFail(_jobId, body) { failures.push(body); },
    },
    artifacts: {
      async downloadToFile({ destination }) {
        const tampered = Buffer.from('tampered');
        await writeFile(destination, tampered, { flag: 'wx' });
        return { sha256: digest(tampered), byteLength: tampered.length };
      },
    },
    featureService: { async asr() { asrCalls += 1; } },
    scratchRoot: scratch,
    now: () => FIXED_NOW,
    logger: { info() {}, error() {} },
  });
  assert.deepEqual(await runtime.runOnce(), { leased: 1, completed: 0, failed: 1, skipped: 0 });
  assert.equal(asrCalls, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, 'HASH_MISMATCH');
});
