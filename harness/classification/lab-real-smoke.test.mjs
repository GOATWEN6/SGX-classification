import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const build = process.env.CLASSIFICATION_BUILD_DIR;
const {
  REAL_SMOKE_MODEL,
  getRealSmokeStatus,
  runRealSmoke
} = require(`${build}/src/lib/algorithms/classification/lab-real-smoke.js`);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1kAAAAASUVORK5CYII=', 'base64');

function submission() {
  return {
    scope: { householdId: 'house_real_smoke', subjectId: 'elder_real_smoke' },
    actorId: 'tester_real_smoke',
    contextKind: 'album_upload',
    recipientIds: [],
    images: [{ filename: 'family.png', mimeType: 'image/png', bytes: png }],
    userText: '这是1985年在武汉拍的毕业照',
    userTextTargetIndexes: [0],
    finalAsrTargetIndexes: null,
    submittedAt: '2026-09-30T04:00:00.000Z'
  };
}

function config(root, patch = {}) {
  return {
    enabled: true,
    approvalRef: 'chat_approved_real_smoke',
    expiresAt: '2026-10-01T00:00:00.000Z',
    maxRequests: 1,
    maxCostCny: 1,
    dataRoot: root,
    model: REAL_SMOKE_MODEL,
    inputCnyPerMillion: 1.2,
    outputCnyPerMillion: 4.8,
    ...patch
  };
}

function validTransport(calls) {
  return async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const context = JSON.parse(calls.at(-1).messages[1].content[0].text);
    const photoId = context.untrustedContext.requestedPhotoIds[0];
    const textEvidence = calls.at(-1).messages[1].content
      .filter(item => item.type === 'text')
      .map(item => JSON.parse(item.text))
      .find(item => item.source === 'user_text');
    assert.ok(textEvidence?.evidenceId);
    const visual = [{ photoId, source: 'visual', quote: '一张户外合影，背景有校园建筑' }];
    const value = { observations: [{
      photoId,
      people: [{ faceId: 'face_1', description: '一位成年人', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, supports: visual }],
      mentions: [],
      times: [{ value: '1985-09', precision: 'year-month', role: 'event', supports: [{ photoId, source: 'user_text', evidenceId: textEvidence.evidenceId, quote: '1985年' }] }],
      places: [{ label: '武汉', supports: [{ photoId, source: 'user_text', evidenceId: textEvidence.evidenceId, quote: '武汉' }] }],
      events: [{ type: '毕业', supports: [{ photoId, source: 'user_text', evidenceId: textEvidence.evidenceId, quote: '毕业照' }] }],
      scenes: [{ label: '校园', supports: visual }, { label: '户外', supports: visual }],
      unknownFacets: ['time'],
      conflicts: []
    }] };
    return new Response(JSON.stringify({
      id: 'mock_real_smoke_1',
      model: REAL_SMOKE_MODEL,
      usage: { prompt_tokens: 1200, completion_tokens: 320 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }]
    }), { status: 200 });
  };
}

test('real smoke runs one bounded Stage A request and preserves audit evidence', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-real-smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const result = await runRealSmoke(submission(), config(root), {
    credential: () => 'test-only-secret',
    transport: validTransport(calls),
    now: () => Date.parse('2026-09-30T05:00:00.000Z')
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, REAL_SMOKE_MODEL);
  assert.equal(calls[0].enable_thinking, false);
  assert.equal(result.usage.requests, 1);
  assert.equal(result.provider.modelVersion, REAL_SMOKE_MODEL);
  assert.equal(result.audit.automaticRetries, 0);
  assert.equal(result.audit.personMatching, false);
  assert.ok(result.observations.some(item => item.facet === 'event' && item.rawValue === '毕业'));
  assert.ok(result.observations.some(item => item.facet === 'time' && item.rawValue === '1985'));
  assert.ok(result.organization.stories.length >= 1);

  const status = await getRealSmokeStatus(config(root));
  assert.equal(status.usedRequests, 1);
  assert.equal(status.remainingRequests, 0);
  const raw = await readFile(result.audit.rawResponsePath, 'utf8');
  assert.match(raw, /mock_real_smoke_1/);
  assert.doesNotMatch(raw, /test-only-secret/);
  await assert.rejects(
    runRealSmoke(submission(), config(root), { credential: () => 'test-only-secret', transport: validTransport(calls), now: () => Date.parse('2026-09-30T05:01:00.000Z') }),
    /REAL_SMOKE_REQUEST_LIMIT/
  );
  assert.equal(calls.length, 1);
});

test('invalid provider output consumes one request and is never retried', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-real-smoke-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const transport = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      id: 'mock_invalid', model: REAL_SMOKE_MODEL,
      usage: { prompt_tokens: 100, completion_tokens: 10 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ bad: true }) } }]
    }), { status: 200 });
  };
  await assert.rejects(
    runRealSmoke(submission(), config(root), { credential: () => 'test-only-secret', transport, now: () => Date.parse('2026-09-30T05:00:00.000Z') }),
    /INVALID_OUTPUT/
  );
  assert.equal(calls, 1);
  const status = await getRealSmokeStatus(config(root));
  assert.equal(status.usedRequests, 1);
  assert.equal(status.remainingRequests, 0);
});

test('real smoke ledger rejects changed approval parameters', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-real-smoke-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  await runRealSmoke(submission(), config(root), {
    credential: () => 'test-only-secret',
    transport: validTransport(calls),
    now: () => Date.parse('2026-09-30T05:00:00.000Z')
  });
  await assert.rejects(
    getRealSmokeStatus(config(root, { approvalRef: 'different_approval' })),
    /REAL_SMOKE_APPROVAL_CHANGED/
  );
});
