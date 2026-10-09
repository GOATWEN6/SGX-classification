import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDirectService } from '../runtime/service.mjs';

const token = 'fixture-api-credential-'.repeat(3);
const identity = { scope: { householdId: 'fixture-house', subjectId: 'fixture-subject' }, actorId: 'fixture-actor' };
const headers = { authorization: `Bearer ${token}`, 'x-sgx-household-id': identity.scope.householdId,
  'x-sgx-subject-id': identity.scope.subjectId, 'x-sgx-actor-id': identity.actorId };
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
function png() {
  const bytes = Buffer.alloc(32); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(4, 16); bytes.writeUInt32BE(3, 20); return bytes;
}
async function fixture(t, { authorized = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-direct-test-'));
  const auth = path.join(root, 'authorization.json');
  await writeFile(auth, JSON.stringify({ version: 'classification-real-call-authorization.1',
    authorizationId: 'direct_fixture_auth', providerVersion: 'qwen:qwen3.7-flash-2026-07-15:sgx-five-facets.16:stage-a-validation.4',
    modelVersion: 'qwen3.7-flash-2026-07-15', caps: { maxRequests: 200, maxCostCny: 50, maxRetries: 0 },
    openingUsage: { requests: 193, costCny: 23.243669, sourceRefs: ['fixture-prior-ledger'] },
    allowPersonMatching: true, expiresAt: new Date(Date.now() + 600_000).toISOString(), authorizationEvidenceRef: 'fixture-only' }));
  const options = { buildDir: process.env.CLASSIFICATION_BUILD_DIR, dataRoot: root, token,
    gitCommit: 'a'.repeat(40), authorizationPath: authorized ? auth : undefined, automaticProcessing: false,
    scratchRoot: path.join(root, 'scratch'), environment: { SGX_D4_API_KEY: 'fixture-key-never-used' },
    featureReady: async () => true,
    featureService: { async asr(source) {
      assert.equal((await readFile(source.sourcePath)).equals(wav()), true);
      return { sourceSha256: source.sourceSha256, sourceByteLength: source.sourceByteLength,
        audioFormat: 'pcm_s16le', sampleRateHz: 16000, channels: 1,
        durationMs: 1, modelId: 'fixture-asr', modelVersion: '1', modelRevision: 'fixture',
        runtimeId: 'fixture', runtimeVersion: '1', text: '这是我的家。', language: 'zh', segments: [] };
    } }, logger: { info() {}, warn() {}, error() {} } };
  let service;
  async function start() {
    service = await createDirectService(options);
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${service.server.address().port}`;
  }
  let url = await start();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, get url() { return url; }, get service() { return service; },
    async restart() { await service.close(); url = await start(); } };
}
function form(metadata, { audio, image } = {}) {
  const result = new FormData(); result.set('metadata', JSON.stringify(metadata));
  if (audio) result.set('audio', new Blob([audio], { type: 'audio/wav' }), 'recording.wav');
  if (image) result.append('images', new Blob([image], { type: 'image/png' }), 'photo.png');
  return result;
}
async function post(f, route, key, metadata, files) {
  const response = await fetch(`${f.url}${route}`, { method: 'POST', headers: { ...headers, 'idempotency-key': key },
    body: form(metadata, files) });
  return { status: response.status, body: await response.json() };
}
test('HTTP auth, caller scope, idempotency, cancellation and restart preserve one classification task', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/healthz`)).status, 200);
  assert.equal((await fetch(`${f.url}/version`)).status, 401);
  assert.equal((await fetch(`${f.url}/readyz`, { headers })).status, 200);
  const metadata = { ...identity, contextKind: 'album_upload', userText: '在家里拍的照片', submittedAt: new Date().toISOString(), personMatchingAuthorized: true };
  const first = await post(f, '/v1/classification/jobs', 'first-request', metadata, { image: png() });
  assert.equal(first.status, 202);
  const replay = await post(f, '/v1/classification/jobs', 'first-request', metadata, { image: png() });
  assert.equal(replay.body.jobId, first.body.jobId); assert.equal(replay.body.replayed, true);
  const conflict = await post(f, '/v1/classification/jobs', 'first-request', { ...metadata, userText: 'changed' }, { image: png() });
  assert.equal(conflict.status, 409);
  const foreign = await post(f, '/v1/classification/jobs', 'foreign', { ...metadata, actorId: 'other' }, { image: png() });
  assert.equal(foreign.status, 403);
  const query = `/v1/classification/jobs/${first.body.jobId}?sessionId=${first.body.sessionId}`;
  assert.equal((await fetch(f.url + query, { headers: { ...headers, 'x-sgx-household-id': 'other' } })).status, 403);
  const guard = await f.service.lab.guardStore.get(first.body.jobId);
  assert.equal(guard.allowPersonMatching, true);
  const cancel = await fetch(`${f.url}/v1/classification/jobs/${first.body.jobId}/cancel?sessionId=${first.body.sessionId}`, { method: 'POST', headers });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).status, 'cancelled');
  await f.restart();
  assert.equal((await (await fetch(f.url + query, { headers })).json()).status, 'cancelled');
  const laterReplay = await post(f, '/v1/classification/jobs', 'first-request', metadata, { image: png() });
  assert.equal(laterReplay.body.jobId, first.body.jobId);
  assert.equal((await f.service.lab.store.list(100)).length, 1);
  assert.equal((await f.service.budget.readStatus()).used.requests, 193);
});
test('ASR HTTP uses the internal artifact adapter, returns transcript and survives service restart', async t => {
  const f = await fixture(t, { authorized: false });
  assert.equal((await fetch(`${f.url}/readyz`, { headers })).status, 503);
  const result = await post(f, '/v1/asr/jobs', 'recording-1', identity, { audio: wav() });
  assert.equal(result.status, 202);
  const processed = await f.service.asrRuntime.runOnce();
  assert.equal(processed.completed, 1);
  const query = `/v1/asr/jobs/${result.body.jobId}/result?sessionId=${result.body.sessionId}`;
  const view = await (await fetch(f.url + query, { headers })).json();
  assert.equal(view.status, 'succeeded'); assert.equal(view.result.text, '这是我的家。');
  assert.equal('lease' in view, false);
  await f.restart();
  assert.deepEqual(await (await fetch(f.url + query, { headers })).json(), view);
  assert.equal((await f.service.asrRuntime.runOnce()).leased, 0);
  const classification = await post(f, '/v1/classification/jobs', 'no-budget', {
    ...identity, contextKind: 'album_upload', userText: 'test', submittedAt: new Date().toISOString(),
  });
  assert.equal(classification.status, 503);
});
test('upload metadata and body bounds reject invalid input before creating jobs', async t => {
  const f = await fixture(t);
  const bad = await post(f, '/v1/asr/jobs', 'bad-wav', identity, { audio: Buffer.from('placeholder') });
  assert.equal(bad.status, 415);
  const noKey = await fetch(`${f.url}/v1/classification/jobs`, { method: 'POST', headers,
    body: form({ ...identity, contextKind: 'album_upload', userText: 'test', submittedAt: new Date().toISOString() }) });
  assert.equal(noKey.status, 400);
  assert.equal((await f.service.lab.store.list(100)).length, 0);
  const malformed = await fetch(`${f.url}/v1/asr/jobs`, { method: 'POST',
    headers: { ...headers, 'idempotency-key': 'bad-json', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(malformed.status, 415);
});
