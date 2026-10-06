import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

function freeServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('external T1 gateway exposes only bearer-protected server-to-server routes', async t => {
  const upstream = await freeServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      path: request.url,
      gateway: request.headers['x-sgx-t1-gateway'],
      mutation: request.headers['x-sgx-classification-lab'] ?? null,
    }));
  });
  const upstreamPort = upstream.address().port;
  const gatewayProbe = await freeServer((_request, response) => response.end());
  const gatewayPort = gatewayProbe.address().port;
  await new Promise(resolve => gatewayProbe.close(resolve));
  const token = 'g'.repeat(48);
  const child = spawn(process.execPath, ['scripts/classification-t1-external-gateway.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN: token,
      CLASSIFICATION_T1_GATEWAY_PORT: String(gatewayPort),
      CLASSIFICATION_T1_UPSTREAM_PORT: String(upstreamPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => upstream.close(resolve));
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', chunk => String(chunk).includes('SGX_T1_EXTERNAL_GATEWAY_READY') ? resolve() : reject(new Error('GATEWAY_NOT_READY')));
  });
  const base = `http://127.0.0.1:${gatewayPort}`;
  const unauthorized = await fetch(`${base}/api/classification-lab/t1`);
  assert.equal(unauthorized.status, 401);
  const forbiddenRoute = await fetch(`${base}/internal/v1/classification/leases`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(forbiddenRoute.status, 404);
  const browser = await fetch(`${base}/api/classification-lab/t1`, {
    headers: { authorization: `Bearer ${token}`, origin: 'https://frontend.example' },
  });
  assert.equal(browser.status, 403);
  const read = await fetch(`${base}/api/classification-lab/t1?sessionId=test`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await read.json(), {
    path: '/api/classification-lab/t1?sessionId=test', gateway: '1', mutation: null,
  });
  const mutation = await fetch(`${base}/api/classification-lab/t1/retry`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.deepEqual(await mutation.json(), {
    path: '/api/classification-lab/t1/retry', gateway: '1', mutation: '1',
  });
});
