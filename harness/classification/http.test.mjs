import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createFakeHttpServer } from './fake-http-server.mjs';
import { syntheticState, syntheticEnvelope, scopeKey } from './fixtures/http/synthetic.mjs';
const require = createRequire(import.meta.url);
const compiled = `${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification`;
const { prepareProviderRequest, computeInputHash, computeIdempotencyKey } = require(`${compiled}/guards.js`);
const { FAKE_VERSIONS, FakeClassificationProvider } = require(`${compiled}/fake.js`);
const { failureResult } = require(`${compiled}/provider.js`);
const clone = structuredClone;
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function setup(t, options = {}) {
  const state = syntheticState(FAKE_VERSIONS);
  const states = options.states ?? new Map([[scopeKey(state.authorization), state]]);
  const server = createFakeHttpServer({ buildDir: process.env.CLASSIFICATION_BUILD_DIR, states, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.shutdown());
  return { state, states, server, url: `http://127.0.0.1:${server.address().port}`, body: syntheticEnvelope(prepareProviderRequest, state) };
}
async function post(s, body = s.body) {
  const r = await fetch(`${s.url}/v1/classify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: r.status, headers: r.headers, body: await r.json() };
}
const errorIs = (r, status, code) => { assert.equal(r.status, status); assert.deepEqual(r.body, { error: { code } }); };
function hashRequest(body) {
  body.providerRequest.inputHash = computeInputHash(body.providerRequest);
  body.providerRequest.idempotencyKey = computeIdempotencyKey(body.providerRequest);
}

test('HTTP identical replay and changed run/scenario conflict retain strict semantics', async t => {
  const s = await setup(t);
  const first = await post(s); assert.equal(first.status, 200);
  assert.equal(first.body.resultStatus, 'succeeded'); assert.equal(first.body.workflowStatus, 'succeeded');
  const replay = await post(s);
  assert.equal(replay.headers.get('x-sgx-idempotent-replay'), 'true'); assert.deepEqual(replay.body, first.body);
  for (const change of [b => b.requestId = 'changed', b => b.scenario = 'failed', b => b.providerRequest.runId = 'changed']) {
    const body = clone(s.body); change(body); errorIs(await post(s, body), 409, 'IDEMPOTENCY_CONFLICT');
  }
  const reordered = Object.fromEntries(Object.entries(s.body).reverse());
  assert.deepEqual((await post(s, reordered)).body, first.body);
});

for (const [scenario, status, code] of [ ['success','succeeded'], ['needs_review','needs_review'], ['conflicted','needs_review'],
  ['partial_failure','needs_review'], ['failed','failed_retryable','PROVIDER_UNAVAILABLE'],
  ['invalid_output','failed_terminal','INVALID_OUTPUT'], ['timeout','failed_retryable','TIMEOUT'] ]) {
  test(`HTTP independent task: ${scenario}`, async t => {
    const s = await setup(t, { maxDurationMs: 40 });
    s.body.scenario = scenario;
    const r = await post(s); assert.equal(r.status, 200); assert.equal(r.body.resultStatus, status);
    assert.equal(r.body.errorCode, code); assert.equal(r.body.partial, scenario === 'partial_failure');
    assert.equal(r.body.failed, status.startsWith('failed')); assert.equal(r.body.needsReview, status === 'needs_review');
    assert.equal(r.body.workflowStatus, status.startsWith('failed') ? 'failed' : status);
    assert.ok(r.body.result.assertions.every(a => ['proposed','conflicted'].includes(a.state)));
  });
}
test('HTTP empty unknown has abstention; cancellation remains cancellation', async t => {
  const s = await setup(t);
  s.body = syntheticEnvelope(prepareProviderRequest, s.state, { requestedFacets: ['duplicate'] });
  const r = await post(s); assert.equal(r.status, 200);
  assert.deepEqual(r.body.abstain, [{ facet: 'duplicate', reason: 'no_assertion' }]); assert.deepEqual(r.body.result.assertions, []);
  const c = await setup(t, { providerFactory: () => ({ classify: async r => failureResult(r,'CANCELLED'), cancel() {} }) });
  const cancelled = await post(c); assert.equal(cancelled.body.workflowStatus, 'cancelled');
});
test('HTTP 10 concurrent identical requests invoke provider once, including in-flight conflict', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const s = await setup(t, { providerFactory: () => ({ async classify(r, o) {
    calls++; entered.resolve(); await release.promise; return new FakeClassificationProvider({scenario:'success'}).classify(r,o);
  }, cancel() {} }) });
  const pending = Array.from({length:10}, () => post(s));
  await entered.promise;
  const altered = clone(s.body); altered.scenario = 'failed';
  errorIs(await post(s, altered),409,'IDEMPOTENCY_CONFLICT');
  release.resolve(); const results = await Promise.all(pending);
  assert.equal(calls,1); assert.ok(results.every(r=>r.status===200));
  for (const r of results) assert.deepEqual(r.body,results[0].body);
});

test('HTTP strict schema rejects additional fields, invalid types, formats and malformed hashes', async t => {
  let calls = 0;
  const s = await setup(t,{providerFactory:()=>{calls++; return new FakeClassificationProvider({scenario:'success'});}});
  for (const mutate of [b=>b.extra='untrusted', b=>b.scope.extra=true, b=>b.authorizationRevision=4,
    b=>b.authorizationState='invented', b=>b.purpose='memory', b=>b.deadlineAt='yesterday', b=>b.scenario='invented',
    b=>b.requestId='', b=>b.providerRequest.extra=true]) {
    const b=clone(s.body); mutate(b); errorIs(await post(s,b),400,'INVALID_ENVELOPE');
  }
  const b=clone(s.body); b.providerRequest.inputHash=`sha256:${'0'.repeat(64)}`;
  errorIs(await post(s,b),400,'INVALID_CONTRACT'); assert.equal(calls,0);
});
test('HTTP malformed JSON, byte limit, content type, health and missing route', async t=>{
  const s=await setup(t);
  for(const [body,headers,status,code] of [ ['{',{'content-type':'application/json'},400,'INVALID_ENVELOPE'],
    ['{}',{'content-type':'text/plain'},415,'UNSUPPORTED_MEDIA_TYPE'],
    [JSON.stringify('中'.repeat(700000)),{'content-type':'application/json'},413,'BODY_TOO_LARGE'] ]) {
    const r=await fetch(`${s.url}/v1/classify`,{method:'POST',headers,body});
    errorIs({status:r.status,body:await r.json()},status,code);
  }
  const h=await fetch(`${s.url}/healthz`); assert.equal(h.status,200); assert.equal((await h.json()).evidenceStatus,'synthetic_contract_only');
  assert.equal((await fetch(`${s.url}/missing`)).status,404);
});

const changes = [
 ['withdrawal',s=>s.authorizationState='withdrawn',403,'AUTHORIZATION_REVOKED'],
 ['authorization revision',s=>s.authorizationRevision='auth-rev-2',409,'AUTHORIZATION_CHANGED'],
 ['model version',s=>s.versions.modelVersion='changed',409,'VERSION_EXPIRED'],
 ['evidence version',s=>s.evidence[0].revision++,409,'STALE_RESULT'],
 ['deleted evidence',s=>s.evidence[0].lifecycleState='deletion_pending',409,'INACTIVE_EVIDENCE'],
 ['consent removed',s=>s.authorization.allowedConsentRefs=[],403,'NOT_AUTHORIZED'],
 ['run cancelled',s=>s.cancelledRuns.add('run_http'),409,'STALE_RESULT'],
];
for(const [name,change,status,code] of changes) {
  test(`HTTP server-side ${name} rejects cached result and in-flight output`,async t=>{
    const s=await setup(t); assert.equal((await post(s)).status,200); change(s.state);
    errorIs(await post(s),status,code);
    const entered=deferred(), release=deferred();
    const inflight=await setup(t,{providerFactory:()=>({async classify(r,o){entered.resolve();await release.promise;
      return new FakeClassificationProvider({scenario:'success'}).classify(r,o);},cancel(){}})});
    const pending=post(inflight); await entered.promise; change(inflight.state);release.resolve();
    errorIs(await pending,status,code); errorIs(await post(inflight),status,code);
  });
}
test('HTTP current withdrawal cannot be overridden by client active, nor missing scope self-authorized',async t=>{
  const s=await setup(t);s.state.authorizationState='withdrawn';s.body.authorizationState='active';
  errorIs(await post(s),403,'AUTHORIZATION_REVOKED');
  const other=await setup(t);other.body.scope.subjectId='unknown';other.body.providerRequest.subjectId='unknown';hashRequest(other.body);
  errorIs(await post(other),403,'NOT_AUTHORIZED');
});
test('HTTP two households and two subjects are isolated in request/cache/source checks',async t=>{
  const states=new Map();
  for(const [householdId,subjectId] of [['h1','s1'],['h2','s1'],['h1','s2']]) {
    const state=syntheticState(FAKE_VERSIONS,{householdId,subjectId});states.set(scopeKey(state.authorization),state);
  }
  const s=await setup(t,{states});const outputs=[];
  for(const state of states.values()) {
    const body=syntheticEnvelope(prepareProviderRequest,state);const r=await post(s,body);
    assert.equal(r.status,200);assert.equal(r.body.result.subjectId,state.authorization.subjectId);
    assert.equal(r.body.result.householdId,state.authorization.householdId);outputs.push(r.body.idempotencyKey);
    const mismatch=clone(body);mismatch.scope.householdId='other';errorIs(await post(s,mismatch),409,'SCOPE_OR_DEADLINE_MISMATCH');
  }
  assert.equal(new Set(outputs).size,3);
  const state=[...states.values()][0];const b=syntheticEnvelope(prepareProviderRequest,state);
  b.providerRequest.evidence[0].sourceRef.id='foreign_object';hashRequest(b);errorIs(await post(s,b),409,'STALE_RESULT');
});
test('HTTP expired cache and uncooperative late completion never replace timeout',async t=>{
  const s=await setup(t);s.body=syntheticEnvelope(prepareProviderRequest,s.state,{deadlineAt:new Date(Date.now()+120).toISOString()});
  assert.equal((await post(s)).status,200);
  await new Promise(r=>setTimeout(r,150));errorIs(await post(s),409,'STALE_RESULT');
  const entered=deferred(),release=deferred();let cancelled=0;
  const late=await setup(t,{maxDurationMs:25,providerFactory:()=>({async classify(r,o){entered.resolve();await release.promise;
    return new FakeClassificationProvider({scenario:'success'}).classify(r,{signal:new AbortController().signal});},cancel(){cancelled++;}})});
  const pending=post(late);await entered.promise;const outcome=await pending;
  assert.equal(outcome.body.errorCode,'TIMEOUT');assert.equal(cancelled,1);release.resolve();
  await new Promise(r=>setImmediate(r));assert.deepEqual((await post(late)).body,outcome.body);
});
test('HTTP bounded task capacity returns 429, provider errors never echo private diagnostics',async t=>{
  const s=await setup(t,{maxEntries:1});assert.equal((await post(s)).status,200);
  const other=syntheticEnvelope(prepareProviderRequest,s.state,{requestedFacets:['time']});errorIs(await post(s,other),429,'RATE_LIMITED');
  const broken=await setup(t,{providerFactory:()=>{throw new Error('PRIVATE_DIAGNOSTIC_DO_NOT_ECHO');}});
  errorIs(await post(broken),500,'INTERNAL_ERROR');
});

test('CLI SIGINT/SIGTERM stop the service and remove its temporary build', { timeout: 20000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { readFile, access } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const child = spawn(process.execPath, ['scripts/classification-fake-http.mjs'], {
      env: { ...process.env, CLASSIFICATION_FAKE_PORT: '0', CLASSIFICATION_FAKE_SCENARIO: 'success' }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    const exited = once(child, 'exit');
    const ready = await new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.once('exit', () => reject(new Error('CLI_EXITED_BEFORE_READY')));
      child.stdout.on('data', chunk => {
        output += chunk;
        for (const line of output.split('\n')) {
          try { const info = JSON.parse(line); if (info.service === 'sgx-classification-fake') resolve(info); } catch { /* wait for full line */ }
        }
      });
    });
    const body = JSON.parse(await readFile(ready.exampleRequestPath, 'utf8'));
    const r = await post({ url: ready.url, body }); assert.equal(r.status, 200);
    assert.equal((await fetch(`${ready.url}/healthz`)).status, 200);
    child.kill(signal); const [code] = await exited; assert.equal(code, 0);
    await assert.rejects(access(dirname(ready.exampleRequestPath)));
    await assert.rejects(fetch(`${ready.url}/healthz`, {signal: AbortSignal.timeout(1000)}));
  }
});
