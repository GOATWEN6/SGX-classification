import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { scopeKey, syntheticState } from './fixtures/http/synthetic.mjs';
const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const coreSchema = JSON.parse(readFileSync(new URL('../../contracts/classification.schema.json', import.meta.url)));
const httpSchema = JSON.parse(readFileSync(new URL('../../contracts/classification-http.schema.json', import.meta.url)));
const ajv = new Ajv({ coerceTypes: false, useDefaults: false, removeAdditional: false, strictKeywords: true,
  strictNumbers: true, format: 'full', ownProperties: true });
ajv.addSchema(coreSchema); ajv.addSchema(httpSchema);
const validate = name => ajv.getSchema(`${httpSchema.$id}#/definitions/${name}`);
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const fault = (status, code) => Object.assign(new Error(code), { httpStatus: status, code });

/** Loopback synthetic harness only. Mutable states/providerFactory are test-process hooks, not HTTP controls. */
export function createFakeHttpServer({ buildDir, defaultScenario = 'success', states, providerFactory,
  maxDurationMs = 1000, maxEntries = 128 } = {}) {
  if (!buildDir) throw new Error('CLASSIFICATION_BUILD_DIR is required');
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 60000) throw new Error('INVALID_FAKE_LIMIT');
  const { prepareProviderRequest, validateProviderRequest, acceptProviderResult } = require(`${buildDir}/src/lib/algorithms/classification/guards.js`);
  const { executeProvider } = require(`${buildDir}/src/lib/algorithms/classification/provider.js`);
  const { FakeClassificationProvider, FakeScenarios, FAKE_VERSIONS } = require(`${buildDir}/src/lib/algorithms/classification/fake.js`);
  if (!FakeScenarios.includes(defaultScenario)) throw new Error('UNKNOWN_FAKE_SCENARIO');
  const initial = syntheticState(FAKE_VERSIONS);
  states ??= new Map([[scopeKey(initial.authorization), initial]]);
  const entries = new Map();
  const controllers = new Set();

  function fresh(envelope, allowExpired = false) {
    const request = envelope.providerRequest;
    const state = states.get(scopeKey(envelope.scope));
    if (!state) throw fault(403, 'NOT_AUTHORIZED');
    if (state.authorizationState !== 'active' || envelope.authorizationState === 'withdrawn') throw fault(403, 'AUTHORIZATION_REVOKED');
    if (state.authorizationRevision !== envelope.authorizationRevision) throw fault(409, 'AUTHORIZATION_CHANGED');
    if (canonical(state.versions) !== canonical(request.versions)) throw fault(409, 'VERSION_EXPIRED');
    if (state.cancelledRuns.has(request.runId) || (!allowExpired && Date.now() >= Date.parse(request.deadlineAt))) throw fault(409, 'STALE_RESULT');
    const evidence = request.evidence.map(e => state.evidence.find(current => current.evidenceId === e.evidenceId));
    if (evidence.some(e => !e)) throw fault(403, 'NOT_AUTHORIZED');
    const rebuilt = prepareProviderRequest({ schemaVersion: '1.0', bundleId: request.bundleId,
      actorId: state.authorization.actorId, ...envelope.scope, evidence }, request, state.authorization);
    if (rebuilt.inputHash !== request.inputHash || rebuilt.idempotencyKey !== request.idempotencyKey) throw fault(409, 'STALE_RESULT');
    return { runId: request.runId, jobStatus: 'processing', evidence, authorization: state.authorization };
  }
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/healthz') return send(res, 200,
        { ok: true, service: 'sgx-classification-fake', contract: 'classification-http.v1', evidenceStatus: 'synthetic_contract_only' });
      if (req.method !== 'POST' || pathname !== '/v1/classify') throw fault(404, 'NOT_FOUND');
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fault(415, 'UNSUPPORTED_MEDIA_TYPE');
      const envelope = await readJson(req);
      if (!validate('ClassificationHttpRequest')(envelope)) throw fault(400, 'INVALID_ENVELOPE');
      const request = validateProviderRequest(envelope.providerRequest);
      if (envelope.deadlineAt !== request.deadlineAt || scopeKey(envelope.scope) !== scopeKey(request)) throw fault(409, 'SCOPE_OR_DEADLINE_MISMATCH');
      fresh(envelope); // Must run even on cache hits.
      const key = JSON.stringify([scopeKey(envelope.scope), request.idempotencyKey]);
      const fingerprint = canonical(envelope);
      let entry = entries.get(key);
      const replay = Boolean(entry);
      if (entry && entry.fingerprint !== fingerprint) throw fault(409, 'IDEMPOTENCY_CONFLICT');
      if (!entry) {
        if (entries.size >= maxEntries) throw fault(429, 'RATE_LIMITED');
        const controller = new AbortController(); controllers.add(controller);
        entry = { fingerprint };
        // Reserve before any asynchronous provider work; concurrent callers join this promise.
        entries.set(key, entry);
        entry.promise = Promise.resolve().then(async () => {
          const scenario = envelope.scenario ?? defaultScenario;
          const provider = providerFactory ? providerFactory(scenario) : new FakeClassificationProvider({ scenario });
          return executeProvider(request, provider, { maxDurationMs, signal: controller.signal });
        }).then(result => {
          const localStop = ['TIMEOUT', 'CANCELLED'].includes(result.error?.code);
          const snapshot = fresh(envelope, localStop);
          if (!localStop) acceptProviderResult(request, result, snapshot);
          const response = toResponse(envelope, result);
          if (!validate('ClassificationHttpResponse')(response)) throw fault(500, 'INTERNAL_ERROR');
          return response;
        }).finally(() => controllers.delete(controller));
      }
      const response = await entry.promise;
      // Recheck for each waiter/replay. Expired cached results never become valid again.
      fresh(envelope, !replay && ['TIMEOUT', 'CANCELLED'].includes(response.errorCode));
      send(res, 200, response, replay ? { 'x-sgx-idempotent-replay': 'true' } : {});
    } catch (error) {
      const safe = { INVALID_CONTRACT: 400, NOT_AUTHORIZED: 403, SCOPE_MISMATCH: 403, INACTIVE_EVIDENCE: 409, STALE_RESULT: 409, INVALID_OUTPUT: 502 };
      const status = error.httpStatus ?? safe[error.code] ?? 500;
      const code = error.httpStatus || safe[error.code] ? error.code : 'INTERNAL_ERROR';
      send(res, status, { error: { code } });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.on('close', () => { for (const c of controllers) c.abort(); entries.clear(); });
  server.shutdown = () => {
    for (const c of controllers) c.abort();
    return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  };
  return server;
}
function toResponse(envelope, result) {
  const failed = ['failed_retryable', 'failed_terminal'].includes(result.status);
  return { protocolVersion: 'classification-http.v1', requestId: envelope.requestId,
    idempotencyKey: envelope.providerRequest.idempotencyKey, resultStatus: result.status,
    workflowStatus: failed ? 'failed' : result.status, partial: result.facetErrors.length > 0,
    abstain: result.abstentions, needsReview: result.status === 'needs_review', failed,
    ...(result.error ? { errorCode: result.error.code } : {}), result };
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, stopped = false;
    req.on('data', chunk => {
      if (stopped) return;
      size += chunk.length;
      if (size > 2_000_000) { stopped = true; chunks = []; reject(fault(413, 'BODY_TOO_LARGE')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (stopped) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(fault(400, 'INVALID_ENVELOPE')); }
    });
    req.on('aborted', () => reject(fault(400, 'INVALID_ENVELOPE')));
    req.on('error', () => reject(fault(400, 'INVALID_ENVELOPE')));
  });
}
function send(res, status, body, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
