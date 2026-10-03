import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const build = process.env.CLASSIFICATION_BUILD_DIR;
if(!build) throw new Error('CLASSIFICATION_BUILD_DIR_REQUIRED');
const { workerJsonPost } = require(`${build}/src/lib/algorithms/classification/worker-control-http.js`);

const TOKEN = 'worker-control-test-token-0123456789abcdef';

function request(body, options = {}) {
  return new Request('http://127.0.0.1:3137/internal/v1/classification/leases', {
    method: 'POST',
    headers: {
      'content-type': options.contentType ?? 'application/json',
      ...(options.authorization === false ? {} : { authorization: `Bearer ${options.token ?? TOKEN}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('worker HTTP boundary is disabled by default and never invokes the operation', async () => {
  const before = process.env.CLASSIFICATION_WORKER_CONTROL_ENABLED;
  delete process.env.CLASSIFICATION_WORKER_CONTROL_ENABLED;
  let called = false;
  try {
    const response = await workerJsonPost(request({ value: 1 }), async () => {
      called = true;
      return { ok: true };
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'CONTROL_PLANE_DISABLED');
    assert.equal(called, false);
  } finally {
    if(before === undefined) delete process.env.CLASSIFICATION_WORKER_CONTROL_ENABLED;
    else process.env.CLASSIFICATION_WORKER_CONTROL_ENABLED = before;
  }
});

test('worker HTTP boundary requires bearer auth, JSON and returns no-store responses', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-worker-http.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prior = Object.fromEntries([
    'CLASSIFICATION_WORKER_CONTROL_ENABLED',
    'CLASSIFICATION_WORKER_CONTROL_TOKEN',
    'CLASSIFICATION_WORKER_PUBLIC_BASE_URL',
    'CLASSIFICATION_LAB_DATA_DIR',
  ].map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    CLASSIFICATION_WORKER_CONTROL_ENABLED: 'true',
    CLASSIFICATION_WORKER_CONTROL_TOKEN: TOKEN,
    CLASSIFICATION_WORKER_PUBLIC_BASE_URL: 'http://127.0.0.1:3137',
    CLASSIFICATION_LAB_DATA_DIR: root,
  });
  t.after(() => {
    for(const [key, value] of Object.entries(prior)) {
      if(value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let called = 0;
  const operation = async (_control, body) => {
    called += 1;
    return { protocolVersion: 'classification-worker-control-plane.v1', echoed: body };
  };
  const missing = await workerJsonPost(request({ value: 1 }, { authorization: false }), operation);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, 'CONTROL_PLANE_UNAUTHORIZED');
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');

  const wrong = await workerJsonPost(request({ value: 1 }, { token: 'x'.repeat(40) }), operation);
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'CONTROL_PLANE_UNAUTHORIZED');

  const media = await workerJsonPost(request({ value: 1 }, { contentType: 'text/plain' }), operation);
  assert.equal(media.status, 415);
  assert.equal((await media.json()).error.code, 'CONTROL_PLANE_JSON_REQUIRED');

  const malformed = await workerJsonPost(request('{', {}), operation);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'CONTROL_PLANE_JSON_INVALID');

  const accepted = await workerJsonPost(request({ value: 7 }), operation);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await accepted.json(), {
    protocolVersion: 'classification-worker-control-plane.v1',
    echoed: { value: 7 },
  });
  assert.equal(called, 1);
});

