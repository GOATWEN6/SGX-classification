#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const listenHost = '127.0.0.1';
const listenPort = Number(process.env.CLASSIFICATION_T1_GATEWAY_PORT ?? '3140');
const upstreamHost = '127.0.0.1';
const upstreamPort = Number(process.env.CLASSIFICATION_T1_UPSTREAM_PORT ?? '3137');
const accessToken = process.env.CLASSIFICATION_T1_EXTERNAL_ACCESS_TOKEN ?? '';
const maxBodyBytes = Number(process.env.CLASSIFICATION_T1_GATEWAY_MAX_BODY_BYTES ?? String(96 * 1024 * 1024));
const maxInflight = Number(process.env.CLASSIFICATION_T1_GATEWAY_MAX_INFLIGHT ?? '4');

if(accessToken.length < 32) throw new Error('CLASSIFICATION_T1_EXTERNAL_ACCESS_MISCONFIGURED');
if(!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) throw new Error('CLASSIFICATION_T1_GATEWAY_PORT_INVALID');
if(!Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535) throw new Error('CLASSIFICATION_T1_UPSTREAM_PORT_INVALID');
if(!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 128 * 1024 * 1024) throw new Error('CLASSIFICATION_T1_GATEWAY_BODY_LIMIT_INVALID');
if(!Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 16) throw new Error('CLASSIFICATION_T1_GATEWAY_CONCURRENCY_INVALID');

const allowed = new Map([
  ['GET /api/classification-lab/t1', true],
  ['POST /api/classification-lab/t1', true],
  ['GET /api/classification-lab/t1/asr', true],
  ['POST /api/classification-lab/t1/asr', true],
  ['POST /api/classification-lab/t1/retry', true],
]);

function equalSecret(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request) {
  const value = request.headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : '';
}

function json(response, status, code) {
  const body = Buffer.from(JSON.stringify({ ok: false, error: { code } }));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
  });
  response.end(body);
}

let inflight = 0;
const server = http.createServer((request, response) => {
  let pathname;
  try { pathname = new URL(request.url ?? '/', 'http://gateway.local').pathname; }
  catch { json(response, 400, 'T1_GATEWAY_URL_INVALID'); return; }
  if(!allowed.has(`${request.method} ${pathname}`)) {
    json(response, 404, 'T1_GATEWAY_ROUTE_NOT_FOUND');
    return;
  }
  if(request.headers.origin) {
    json(response, 403, 'T1_GATEWAY_BROWSER_ORIGIN_REJECTED');
    return;
  }
  const supplied = bearer(request);
  if(!supplied || !equalSecret(supplied, accessToken)) {
    json(response, 401, 'T1_GATEWAY_UNAUTHORIZED');
    return;
  }
  const declaredLength = Number(request.headers['content-length'] ?? '0');
  if(Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    json(response, 413, 'T1_GATEWAY_BODY_TOO_LARGE');
    return;
  }
  if(inflight >= maxInflight) {
    json(response, 429, 'T1_GATEWAY_BUSY');
    return;
  }
  inflight += 1;
  let observedBytes = 0;
  let finished = false;
  const release = () => { if(!finished) { finished = true; inflight -= 1; } };
  const headers = { ...request.headers };
  delete headers.host;
  delete headers.origin;
  delete headers['cf-connecting-ip'];
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  headers.host = `${upstreamHost}:${upstreamPort}`;
  headers['x-forwarded-host'] = request.headers.host ?? 'external-staging';
  headers['x-forwarded-proto'] = 'https';
  headers['x-sgx-t1-gateway'] = '1';
  if(request.method === 'POST') headers['x-sgx-classification-lab'] = '1';
  const upstream = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers,
    timeout: 25 * 60_000,
  }, upstreamResponse => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders['set-cookie'];
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
    upstreamResponse.once('end', release);
  });
  upstream.once('timeout', () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
  upstream.once('error', () => {
    release();
    if(!response.headersSent) json(response, 502, 'T1_GATEWAY_UPSTREAM_UNAVAILABLE');
    else response.destroy();
  });
  request.on('data', chunk => {
    observedBytes += chunk.length;
    if(observedBytes > maxBodyBytes) {
      request.destroy();
      upstream.destroy(new Error('BODY_TOO_LARGE'));
      if(!response.headersSent) json(response, 413, 'T1_GATEWAY_BODY_TOO_LARGE');
    }
  });
  request.once('aborted', () => { upstream.destroy(); release(); });
  request.pipe(upstream);
});

server.requestTimeout = 25 * 60_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.listen(listenPort, listenHost, () => {
  process.stdout.write(`SGX_T1_EXTERNAL_GATEWAY_READY http://${listenHost}:${listenPort}\n`);
});

for(const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
