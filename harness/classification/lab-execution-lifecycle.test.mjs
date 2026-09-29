import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const build = process.env.CLASSIFICATION_BUILD_DIR;
const {
  buildLabContentIdentity,
  computeLabContentDigest,
  buildLabRunIdentity,
  computeLabRunIdentityDigest,
  deriveLabRunIds,
  computeLabGrantDigest,
  computeLabGuardDigest,
  parseLabJobV2
} = require(`${build}/src/lib/algorithms/classification/lab-execution-contract.js`);
const { buildLabSubmission } = require(`${build}/src/lib/algorithms/classification/lab-contract.js`);
const { DeterministicLabProvider } = require(`${build}/src/lib/algorithms/classification/lab-provider.js`);
const { FileClassificationLabStore } = require(`${build}/src/lib/algorithms/classification/lab-store.js`);
const { FileClassificationLabV2Store } = require(`${build}/src/lib/algorithms/classification/lab-execution-store.js`);
const {
  submitLabExecutionJob,
  runPendingLabExecutionJob,
  cancelLabExecutionJob,
  recoverInterruptedLabJobs,
  applyTrustedPrivacyEvent,
  getLabProductJobView,
  listLabProductJobViews,
  readLabProductAsset,
  mapLabExecutionFailure
} = require(`${build}/src/lib/algorithms/classification/lab-execution.js`);
const { applyLabExecutionAction } = require(`${build}/src/lib/algorithms/classification/lab-execution-actions.js`);

const sha = value => `sha256:${'0'.repeat(63)}${value}`;
const clone = value => structuredClone(value);

function png(index, width = 4, height = 3) {
  const bytes = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(index, 24);
  return bytes;
}

function submission(patch = {}) {
  return {
    scope: { householdId: 'house_lab', subjectId: 'elder_lab' },
    actorId: 'daughter_lab',
    contextKind: 'family_transfer',
    senderId: 'daughter_lab',
    recipientIds: ['elder_b', 'elder_a'],
    images: [{ filename: '原文件名.png', mimeType: 'image/png', bytes: png(1) }],
    userText: '  这是１９８５年  ',
    finalAsr: undefined,
    userTextTargetIndexes: [0],
    finalAsrTargetIndexes: null,
    submittedAt: '2026-09-30T01:00:00.000Z',
    ...patch
  };
}

function profile(patch = {}) {
  return {
    providerMode: 'deterministic',
    providerVersion: 'classification-lab-deterministic.1',
    modelVersion: 'none',
    promptVersion: 'none',
    guardVersion: 'classification-lab-guard.1',
    adapterVersion: 'classification-lab-adapter.1',
    taxonomyVersion: 'classification-lab-taxonomy.1',
    placeKindPolicyDigest: sha('1'),
    scorerVersion: 'classification-semantic-score.2',
    configDigest: sha('2'),
    ...patch
  };
}

function semanticContext(patch = {}) {
  return {
    version: 'classification-lab-semantic-context.1',
    referenceDate: '2026-09-30',
    timeZone: 'Asia/Shanghai',
    relativeTimePolicyVersion: 'relative-time.1',
    ...patch
  };
}

function budgetPolicy(patch = {}) {
  return {
    maxRequests: 8,
    maxInputTokens: 100000,
    maxOutputTokens: 4096,
    maxCostCny: 5,
    maxCandidatesPerContent: 8,
    maxCallDurationMs: 60000,
    ...patch
  };
}

function guardFor(built, patch = {}) {
  const base = {
    scope: clone(built.envelope.scope),
    actorId: built.envelope.actorId,
    authorityRef: 'authority_lab_v2',
    purposes: ['classification', 'album_organization', 'search_candidate', 'interview_candidate'],
    authorizationRevision: 'auth_lab_v2_1',
    contextRevision: 'context_lab_v2_1',
    active: true,
    allowedConsentRefs: [...new Set(built.envelope.evidence.flatMap(item => item.lifecycleState === 'active' ? [item.consentRef] : []))].sort(),
    allowedCorrectionIds: [],
    allowPersonMatching: false,
    evidence: built.envelope.evidence.map(item => ({
      evidenceId: item.evidenceId,
      revision: item.revision,
      sourceHash: item.sourceHash,
      consentRef: item.consentRef,
      lifecycleState: item.lifecycleState
    })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
  };
  const value = { ...base, ...patch };
  return { ...value, guardDigest: computeLabGuardDigest(value) };
}

function tombstoneGuard(guard, built, evidenceIds) {
  const deleted = new Set(evidenceIds);
  const value = clone(guard);
  value.evidence = value.evidence.map(item => deleted.has(item.evidenceId)
    ? { ...item, lifecycleState: 'deleted' }
    : item);
  value.allowedConsentRefs = [...new Set(value.evidence
    .filter(item => item.lifecycleState === 'active')
    .map(item => built.envelope.evidence.find(candidate => candidate.evidenceId === item.evidenceId)?.consentRef)
    .filter(Boolean))].sort();
  value.guardDigest = computeLabGuardDigest(value);
  return value;
}

class FakeClock {
  constructor(now = Date.parse('2026-09-30T02:00:00.000Z')) {
    this.value = now;
    this.nextId = 1;
    this.tasks = new Map();
  }
  nowMs() { return this.value; }
  setTimeout(callback, delayMs) {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.value + Math.max(0, delayMs), callback });
    return id;
  }
  clearTimeout(id) { this.tasks.delete(id); }
  advance(ms) {
    this.value += ms;
    for(const [id, task] of [...this.tasks.entries()].sort((left, right) => left[1].at - right[1].at)) {
      if(task.at > this.value) continue;
      this.tasks.delete(id);
      task.callback();
    }
  }
}

class MutableGuardProvider {
  constructor(value) { this.value = clone(value); this.calls = 0; }
  async get() { this.calls++; return clone(this.value); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function zeroMetrics(patch = {}) {
  return {
    latencyMs: 0,
    modelRequests: 0,
    imageRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costCny: 0,
    ...patch
  };
}

function deterministicExecutor(executionProfile, hooks = {}) {
  const provider = new DeterministicLabProvider();
  let calls = 0;
  return {
    profile: clone(executionProfile),
    get calls() { return calls; },
    async execute(input) {
      calls++;
      await hooks.before?.(input);
      const output = await provider.run(input.job.envelope, { textByEvidenceId: input.job.originalTextByEvidenceId });
      await hooks.after?.(input, output);
      return {
        result: {
          version: 'classification-lab-execution-result.1',
          workflowStatus: output.organization.reviewItems.length ? 'needs_review' : 'succeeded',
          profile: clone(executionProfile),
          output
        },
        metrics: zeroMetrics()
      };
    }
  };
}

function stageAMockExecutor(executionProfile, hooks = {}) {
  const provider = new DeterministicLabProvider();
  let calls = 0;
  return {
    profile: clone(executionProfile),
    get calls() { return calls; },
    async execute(input) {
      calls++;
      const output = await provider.run(input.job.envelope, { textByEvidenceId: input.job.originalTextByEvidenceId });
      output.provider = {
        mode: 'stage_a_mock',
        providerVersion: executionProfile.providerVersion,
        modelVersion: executionProfile.modelVersion,
        promptVersion: executionProfile.promptVersion,
        evidenceStatus: 'mock_transport',
        accuracyClaim: 'not_evaluated'
      };
      await hooks.after?.(input, output);
      return {
        result: {
          version: 'classification-lab-execution-result.1',
          workflowStatus: output.organization.reviewItems.length ? 'needs_review' : 'succeeded',
          profile: clone(executionProfile),
          output
        },
        metrics: zeroMetrics()
      };
    }
  };
}

function staticExecutorFactory(executor, hooks = {}) {
  let describeCalls = 0;
  let createCalls = 0;
  return {
    get describeCalls() { return describeCalls; },
    get createCalls() { return createCalls; },
    describe(profileValue) {
      describeCalls++;
      return clone(hooks.describe?.(profileValue) ?? profileValue);
    },
    create(profileValue, context) {
      createCalls++;
      hooks.create?.(profileValue, context);
      return executor;
    }
  };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-lab-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileClassificationLabV2Store(root);
  const built = buildLabSubmission(options.submission ?? submission());
  options.mutateBuilt?.(built);
  const executionProfile = profile(options.profile);
  const guard = guardFor(built, options.guard);
  const clock = options.clock ?? new FakeClock();
  const input = {
    built,
    profile: executionProfile,
    guard,
    semanticContext: semanticContext(options.semanticContext),
    budgetPolicy: budgetPolicy(options.budgetPolicy),
    attemptRevision: options.attemptRevision ?? 1,
    deadlineAt: options.deadlineAt ?? new Date(clock.nowMs() + 60000).toISOString()
  };
  return { root, store, built, executionProfile, guard, clock, input };
}

async function executeFixture(t, options = {}) {
  const value = await fixture(t, options);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const guardProvider = new MutableGuardProvider(value.guard);
  const executor = options.executor ?? deterministicExecutor(value.executionProfile);
  const factory = options.factory ?? staticExecutorFactory(executor);
  const completed = await runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory,
    guardProvider,
    clock: value.clock,
    runnerGeneration: options.runnerGeneration ?? 'runner_test_1'
  });
  return { ...value, pending, completed, guardProvider, executor, factory };
}

test('content identity canonicalization has a frozen golden vector', () => {
  const left = buildLabContentIdentity(buildLabSubmission(submission()));
  const right = buildLabContentIdentity(buildLabSubmission(submission({
    recipientIds: ['elder_a', 'elder_b'],
    images: [{ filename: '重命名不应影响.png', mimeType: 'image/png', bytes: png(1) }],
    userText: '这是1985年',
    submittedAt: '2026-10-01T09:00:00.000Z'
  })));
  assert.deepEqual(left, right);
  assert.equal(computeLabContentDigest(left), 'sha256:47974e5f566354305126fc20299b77d44e12dc01fcfdc8e860558c61155cb227');
  const changed = buildLabContentIdentity(buildLabSubmission(submission({
    scope: { householdId: 'house_lab', subjectId: 'elder_other' }
  })));
  assert.notEqual(computeLabContentDigest(changed), computeLabContentDigest(left));
});

test('content identity binds every association semantic and ignores binding array order', () => {
  const baseline = buildLabSubmission(submission({
    images: [
      { filename: 'one.png', mimeType: 'image/png', bytes: png(1) },
      { filename: 'two.png', mimeType: 'image/png', bytes: png(2) }
    ],
    userTextTargetIndexes: [0]
  }));
  const changed = clone(baseline);
  const source = changed.envelope.contents.find(content => content.modality === 'user_text');
  const secondImage = changed.envelope.contents.filter(content => content.modality === 'image')[1];
  assert.ok(source);
  assert.ok(secondImage);
  changed.envelope.bindings.push({
    bindingId: 'binding_historical_withdrawn',
    sourceContentId: source.contentId,
    target: {
      kind: 'contents',
      contentIds: changed.envelope.contents.filter(content => content.modality === 'image').map(content => content.contentId)
    },
    authority: 'user_explicit',
    state: 'withdrawn',
    method: 'user-selection.1',
    evidenceRefs: [
      source.evidenceId,
      ...changed.envelope.contents.filter(content => content.modality === 'image').map(content => content.evidenceId)
    ],
    createdAt: changed.envelope.createdAt
  });
  const reordered = clone(changed);
  reordered.envelope.bindings.reverse();
  reordered.envelope.bindings[0].target.contentIds.reverse();
  reordered.envelope.bindings[0].evidenceRefs.reverse();
  assert.deepEqual(buildLabContentIdentity(changed), buildLabContentIdentity(reordered));
  assert.notEqual(computeLabContentDigest(changed), computeLabContentDigest(baseline));
  const provenanceChanged = clone(baseline);
  provenanceChanged.envelope.bindings[0].evidenceRefs.push(secondImage.evidenceId);
  assert.notEqual(computeLabContentDigest(provenanceChanged), computeLabContentDigest(baseline));
});

test('content identity changes for each binding semantic and rejects contradictory snapshots', () => {
  const rebuild = value => {
    const input = clone(value);
    delete input.version;
    return buildLabContentIdentity(input);
  };
  const raw = buildLabContentIdentity(buildLabSubmission(submission({
    images: [
      { filename: 'one.png', mimeType: 'image/png', bytes: png(1) },
      { filename: 'two.png', mimeType: 'image/png', bytes: png(2) }
    ],
    userTextTargetIndexes: [0],
    finalAsr: '补充说明',
    finalAsrTargetIndexes: [1]
  })));
  raw.bindings.push({
    sourceModality: 'user_text',
    target: { contents: [{ kind: 'image', slot: 0 }, { kind: 'image', slot: 1 }] },
    authority: 'ai_candidate',
    state: 'withdrawn',
    method: 'candidate-link.1',
    evidenceContents: [
      { kind: 'text', modality: 'user_text' },
      { kind: 'text', modality: 'final_asr' },
      { kind: 'image', slot: 0 },
      { kind: 'image', slot: 1 }
    ]
  });
  const baseline = rebuild(raw);
  const candidateIndex = baseline.bindings.findIndex(binding => binding.method === 'candidate-link.1');
  assert.notEqual(candidateIndex, -1);
  const baselineDigest = computeLabContentDigest(baseline);
  const variants = [
    value => { value.bindings[candidateIndex].sourceModality = 'final_asr'; },
    value => { value.bindings[candidateIndex].target = { contents: [{ kind: 'image', slot: 1 }] }; },
    value => { value.bindings[candidateIndex].authority = 'user_explicit'; },
    value => { value.bindings[candidateIndex].state = 'active'; },
    value => { value.bindings[candidateIndex].method = 'candidate-link.2'; },
    value => {
      value.bindings[candidateIndex].evidenceContents = value.bindings[candidateIndex].evidenceContents
        .filter(reference => !(reference.kind === 'image' && reference.slot === 1));
    },
    value => { value.bindings.splice(candidateIndex, 1); }
  ];
  for(const mutate of variants) {
    const changed = clone(baseline);
    mutate(changed);
    assert.notEqual(computeLabContentDigest(rebuild(changed)), baselineDigest);
  }

  const reordered = clone(baseline);
  reordered.bindings.reverse();
  const reorderedCandidate = reordered.bindings.find(binding => binding.method === 'candidate-link.1');
  reorderedCandidate.target.contents.reverse();
  reorderedCandidate.evidenceContents.reverse();
  assert.deepEqual(rebuild(reordered), baseline);

  const contradictory = clone(baseline);
  contradictory.bindings.push({ ...clone(baseline.bindings[candidateIndex]), state: 'active' });
  assert.throws(() => rebuild(contradictory), /DUPLICATE_BINDING_SEMANTICS/);
});

test('run identity changes on semantic anchor, execution, grant and attempt', () => {
  const built = buildLabSubmission(submission());
  const guard = guardFor(built);
  const contentDigest = computeLabContentDigest(buildLabContentIdentity(built));
  const common = {
    contentDigest,
    attemptRevision: 1,
    executionProfile: profile(),
    authorizationGrantDigest: computeLabGrantDigest(guard),
    authorizationRevision: guard.authorizationRevision,
    contextRevision: guard.contextRevision,
    semanticContext: semanticContext(),
    budgetPolicy: budgetPolicy()
  };
  const base = buildLabRunIdentity(common);
  const baseDigest = computeLabRunIdentityDigest(base);
  for(const variant of [
    { ...common, attemptRevision: 2 },
    { ...common, executionProfile: profile({ promptVersion: 'prompt.2' }) },
    { ...common, executionProfile: profile({ providerVersion: 'provider.2' }) },
    { ...common, executionProfile: profile({ modelVersion: 'model.2' }) },
    { ...common, executionProfile: profile({ taxonomyVersion: 'taxonomy.2' }) },
    { ...common, executionProfile: profile({ scorerVersion: 'scorer.3' }) },
    { ...common, executionProfile: profile({ configDigest: sha('3') }) },
    { ...common, executionProfile: profile({ placeKindPolicyDigest: sha('4') }) },
    { ...common, authorizationGrantDigest: sha('5') },
    { ...common, authorizationRevision: 'auth_lab_v2_2' },
    { ...common, contextRevision: 'context_lab_v2_2' },
    { ...common, semanticContext: semanticContext({ referenceDate: '2026-10-01' }) },
    { ...common, budgetPolicy: budgetPolicy({ maxRequests: 7 }) }
  ]) assert.notEqual(computeLabRunIdentityDigest(buildLabRunIdentity(variant)), baseDigest);
  const ids = deriveLabRunIds(baseDigest);
  assert.equal(ids.runId, ids.jobId);
  assert.match(ids.idempotencyKey, /^sha256:[a-f0-9]{64}$/);
});

test('v2 schema rejects invalid lifecycle/result combinations', async t => {
  const { input, store, clock } = await fixture(t);
  const pending = await submitLabExecutionJob(input, store, clock);
  assert.equal(parseLabJobV2(pending).status, 'pending');
  assert.throws(() => parseLabJobV2({ ...pending, status: 'processing' }), /startedAt|processingOwner|PROCESSING/i);
  assert.throws(() => parseLabJobV2({
    ...pending,
    revision: 2,
    status: 'succeeded',
    startedAt: pending.updatedAt,
    finishedAt: pending.updatedAt,
    processingOwner: { runnerGeneration: 'runner_schema', claimedAt: pending.updatedAt },
    transitions: [
      ...pending.transitions,
      { from: 'pending', to: 'processing', reason: 'claimed', at: pending.updatedAt, revision: 1, runnerGeneration: 'runner_schema' },
      { from: 'processing', to: 'succeeded', reason: 'completed', at: pending.updatedAt, revision: 2, runnerGeneration: 'runner_schema' }
    ]
  }), /result|metrics|outcome/i);
  assert.throws(() => parseLabJobV2({ ...pending, revision: -1 }), /revision|greater than or equal/i);
  assert.throws(() => parseLabJobV2({
    ...pending,
    semanticContext: semanticContext({ referenceDate: '2026-10-01' })
  }), /RUN_IDENTITY|identity/i);
  assert.throws(() => parseLabJobV2({
    ...pending,
    budgetPolicy: budgetPolicy({ maxRequests: 7 })
  }), /RUN_IDENTITY|identity/i);
});

test('ten concurrent submits create one pending job and first deadline wins', async t => {
  const value = await fixture(t);
  const stores = Array.from({ length: 10 }, () => new FileClassificationLabV2Store(value.root));
  const deadlines = stores.map((_, index) => new Date(value.clock.nowMs() + 60000 + index * 1000).toISOString());
  const jobs = await Promise.all(stores.map((store, index) => submitLabExecutionJob({ ...value.input, deadlineAt: deadlines[index] }, store, value.clock)));
  assert.equal(new Set(jobs.map(job => job.jobId)).size, 1);
  assert.equal((await value.store.list()).length, 1);
  const winningDeadline = jobs[0].deadlineAt;
  assert.ok(deadlines.includes(winningDeadline));
  assert.ok(jobs.every(job => job.deadlineAt === winningDeadline));
  assert.equal((await value.store.get(jobs[0].jobId)).deadlineAt, winningDeadline);
  assert.deepEqual(value.store.capabilities, { coordinationScope: 'single_process', crossProcessCas: false });
});

test('two same-revision CAS calls have one winner across store instances', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const other = new FileClassificationLabV2Store(value.root);
  const calls = [value.store, other].map((store, index) => store.compareAndSetTrusted(pending.jobId, 0, current => ({
    ...current,
    status: 'processing',
    startedAt: new Date(value.clock.nowMs() + index).toISOString(),
    updatedAt: new Date(value.clock.nowMs() + index).toISOString(),
    processingOwner: { runnerGeneration: `runner_${index}`, claimedAt: new Date(value.clock.nowMs() + index).toISOString() },
    transitions: [...current.transitions, { from: 'pending', to: 'processing', reason: 'claimed', at: new Date(value.clock.nowMs() + index).toISOString(), revision: 1, runnerGeneration: `runner_${index}` }]
  })));
  const settled = await Promise.allSettled(calls);
  assert.equal(settled.filter(item => item.status === 'fulfilled' && item.value.ok).length, 1);
  const losers = settled.filter(item => item.status === 'fulfilled' ? !item.value.ok : /LAB_JOB_REVISION_CONFLICT/.test(String(item.reason)));
  assert.equal(losers.length, 1);
  assert.equal((await value.store.get(pending.jobId)).revision, 1);
});

test('submit only persists pending; concurrent runners claim and execute once', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  assert.equal(pending.status, 'pending');
  const gate = deferred();
  const started = deferred();
  const executor = deterministicExecutor(value.executionProfile, { before: async () => { started.resolve(); await gate.promise; } });
  const guardProvider = new MutableGuardProvider(value.guard);
  const options = { store: value.store, factory: staticExecutorFactory(executor), guardProvider, clock: value.clock, runnerGeneration: 'runner_once' };
  const first = runPendingLabExecutionJob(pending.jobId, options);
  await started.promise;
  const second = runPendingLabExecutionJob(pending.jobId, options);
  gate.resolve();
  const outcomes = await Promise.all([first, second]);
  assert.equal(executor.calls, 1);
  assert.ok(outcomes.every(job => job.jobId === pending.jobId));
  assert.ok(['succeeded', 'needs_review'].includes((await value.store.get(pending.jobId)).status));
});

test('pending cancel is durable and executor is never called', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const cancelled = await cancelLabExecutionJob(pending.jobId, { store: value.store, clock: value.clock, reason: 'user' });
  const executor = deterministicExecutor(value.executionProfile);
  const job = await runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory: staticExecutorFactory(executor),
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock,
    runnerGeneration: 'runner_cancelled'
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(job.status, 'cancelled');
  assert.equal(executor.calls, 0);
});

test('processing cancel is persisted before abort and late success cannot overwrite it', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const entered = deferred();
  const release = deferred();
  const abortObserved = deferred();
  let statusObservedOnAbort;
  const executor = deterministicExecutor(value.executionProfile, {
    before: async ({ signal }) => {
      signal.addEventListener('abort', async () => {
        statusObservedOnAbort = (await value.store.get(pending.jobId)).status;
        abortObserved.resolve();
      }, { once: true });
      entered.resolve();
      await release.promise;
    }
  });
  const running = runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory: staticExecutorFactory(executor),
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock,
    runnerGeneration: 'runner_abort'
  });
  await entered.promise;
  await cancelLabExecutionJob(pending.jobId, { store: value.store, clock: value.clock, reason: 'user' });
  await abortObserved.promise;
  release.resolve();
  const outcome = await running;
  assert.equal(statusObservedOnAbort, 'cancelled');
  assert.equal(outcome.status, 'cancelled');
  assert.equal((await value.store.get(pending.jobId)).result, undefined);
});

test('fake-clock timeout terminates a never-ending executor without auto retry', async t => {
  const value = await fixture(t, { deadlineAt: '2026-09-30T02:00:01.000Z' });
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  let calls = 0;
  const entered = deferred();
  const executor = {
    profile: value.executionProfile,
    async execute() { calls++; entered.resolve(); return new Promise(() => {}); }
  };
  const running = runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory: staticExecutorFactory(executor),
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock,
    runnerGeneration: 'runner_timeout'
  });
  await entered.promise;
  value.clock.advance(1000);
  const outcome = await running;
  assert.equal(outcome.status, 'failed_retryable');
  assert.deepEqual(outcome.error, { code: 'LAB_RUN_TIMEOUT', retryable: true });
  assert.equal(calls, 1);
});

test('authorization, purpose and evidence drift fail closed before terminal commit', async t => {
  for(const [name, mutate] of [
    ['authorization', guard => { guard.authorizationRevision = 'auth_changed'; }],
    ['purpose', guard => { guard.purposes = guard.purposes.filter(value => value !== 'classification'); }],
    ['evidence revision', guard => { guard.evidence[0].revision++; }],
    ['source hash', guard => { guard.evidence[0].sourceHash = sha('9'); }],
    ['lifecycle', guard => { guard.evidence[0].lifecycleState = 'deleted'; }]
  ]) await t.test(name, async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const entered = deferred();
    const release = deferred();
    const guardProvider = new MutableGuardProvider(value.guard);
    const executor = deterministicExecutor(value.executionProfile, { before: async () => { entered.resolve(); await release.promise; } });
    const running = runPendingLabExecutionJob(pending.jobId, {
      store: value.store, factory: staticExecutorFactory(executor), guardProvider, clock: value.clock, runnerGeneration: `runner_drift_${name.replaceAll(' ', '_')}`
    });
    await entered.promise;
    mutate(guardProvider.value);
    guardProvider.value.guardDigest = computeLabGuardDigest(guardProvider.value);
    release.resolve();
    const outcome = await running;
    assert.ok(['cancelled', 'failed_retryable'].includes(outcome.status));
    assert.equal(outcome.result, undefined);
  });
});

test('recovery preserves pending, fails every orphan processing job and never executes', async t => {
  const value = await fixture(t);
  const pendings = [];
  const guards = new Map();
  for(let index = 1; index <= 102; index++) {
    const built = buildLabSubmission(submission({ userText: `记录${index}` }));
    const guard = guardFor(built);
    const pending = await submitLabExecutionJob({ ...value.input, built, guard, attemptRevision: index }, value.store, value.clock);
    pendings.push(pending);
    guards.set(pending.jobId, guard);
  }
  for(const job of pendings.slice(0, 101)) await value.store.compareAndSetTrusted(job.jobId, job.revision, current => ({
    ...current,
    status: 'processing',
    startedAt: new Date(value.clock.nowMs()).toISOString(),
    updatedAt: new Date(value.clock.nowMs()).toISOString(),
    processingOwner: { runnerGeneration: 'runner_dead', claimedAt: new Date(value.clock.nowMs()).toISOString() },
    transitions: [...current.transitions, { from: 'pending', to: 'processing', reason: 'claimed', at: new Date(value.clock.nowMs()).toISOString(), revision: current.revision + 1, runnerGeneration: 'runner_dead' }]
  }));
  const report = await recoverInterruptedLabJobs({
    store: value.store,
    guardProvider: { async get(jobId) { return clone(guards.get(jobId)); } },
    clock: value.clock,
    runnerGeneration: 'runner_new'
  });
  assert.equal(report.interrupted, 101);
  assert.equal((await value.store.get(pendings[100].jobId)).error.code, 'LAB_RUN_INTERRUPTED');
  assert.equal((await value.store.get(pendings[101].jobId)).status, 'pending');
  assert.equal(report.executorCalls ?? 0, 0);
});

test('v2 physical root stays isolated and v2 runner refuses a v1 job', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'sgx-lab-roots-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const v1 = new FileClassificationLabStore(base);
  const v1Job = await (async () => {
    const { submitClassificationLabJob } = require(`${build}/src/lib/algorithms/classification/lab-service.js`);
    return submitClassificationLabJob(submission(), v1, new DeterministicLabProvider());
  })();
  const before = await readFile(path.join(base, v1Job.jobId, 'job.json'));
  const v2 = new FileClassificationLabV2Store(base);
  const built = buildLabSubmission(submission({ userText: 'v2独立记录' }));
  const guard = guardFor(built);
  await submitLabExecutionJob({
    built, profile: profile(), guard, semanticContext: semanticContext(), budgetPolicy: budgetPolicy(), attemptRevision: 1,
    deadlineAt: '2026-09-30T03:00:00.000Z'
  }, v2, new FakeClock());
  assert.equal((await v1.list()).length, 1);
  await assert.rejects(() => runPendingLabExecutionJob(v1Job.jobId, {
    store: v2,
    factory: staticExecutorFactory(deterministicExecutor(profile())),
    guardProvider: new MutableGuardProvider(guard),
    clock: new FakeClock(),
    runnerGeneration: 'runner_v1_reject'
  }), /LAB_LEGACY_JOB_READ_ONLY|LAB_JOB_NOT_FOUND/);
  assert.deepEqual(await readFile(path.join(base, v1Job.jobId, 'job.json')), before);
});

test('terminal privacy event is idempotent, preserves audit result and redacts product views', async t => {
  const value = await executeFixture(t);
  const originalResult = clone(value.completed.result);
  const originalDigest = value.completed.resultDigest;
  const revoked = clone(value.guard);
  revoked.active = false;
  revoked.guardDigest = computeLabGuardDigest(revoked);
  const revokedProvider = new MutableGuardProvider(revoked);
  const event = {
    version: 'classification-lab-privacy-event.1',
    eventId: 'privacy_revoke_1',
    kind: 'authorization_revoked',
    authorityRef: value.guard.authorityRef,
    scope: clone(value.guard.scope),
    authorizationRevision: value.guard.authorizationRevision,
    guardDigest: revoked.guardDigest,
    occurredAt: new Date(value.clock.nowMs() + 1).toISOString()
  };
  const first = await applyTrustedPrivacyEvent(event, { store: value.store, guardProvider: revokedProvider, clock: value.clock });
  const replay = await applyTrustedPrivacyEvent(event, { store: value.store, guardProvider: revokedProvider, clock: value.clock });
  const stored = await value.store.get(value.completed.jobId);
  assert.equal(first.updated, 1);
  assert.equal(replay.updated, 0);
  assert.equal(stored.status, value.completed.status);
  assert.deepEqual(stored.result, originalResult);
  assert.equal(stored.resultDigest, originalDigest);
  assert.equal(stored.privacyEvents.filter(item => item.eventId === event.eventId).length, 1);
  const view = await getLabProductJobView(stored.jobId, {
    store: value.store,
    guardProvider: new MutableGuardProvider(revoked),
    requiredPurpose: 'album_organization'
  });
  assert.equal(view.redacted, true);
  for(const forbidden of ['envelope', 'originalTextByEvidenceId', 'assetRefs', 'result', 'authorization', 'privacyEvents']) {
    assert.equal(Object.hasOwn(view, forbidden), false, forbidden);
  }
  await assert.rejects(() => readLabProductAsset(stored.jobId, stored.assetRefs[0].evidenceId, {
    store: value.store,
    guardProvider: new MutableGuardProvider(revoked),
    requiredPurpose: 'album_organization'
  }), /AUTHORIZATION_REVOKED|NOT_AUTHORIZED|INACTIVE_EVIDENCE/);
});

test('privacy event ID conflict is rejected and classification-only grant cannot power product purposes', async t => {
  const value = await executeFixture(t);
  const deleted = clone(value.guard);
  deleted.evidence[0].lifecycleState = 'deleted';
  deleted.allowedConsentRefs = [...new Set(deleted.evidence.filter(item => item.lifecycleState === 'active').map(item => {
    const evidence = value.built.envelope.evidence.find(candidate => candidate.evidenceId === item.evidenceId);
    return evidence?.consentRef;
  }).filter(Boolean))].sort();
  deleted.guardDigest = computeLabGuardDigest(deleted);
  const deletedProvider = new MutableGuardProvider(deleted);
  const event = {
    version: 'classification-lab-privacy-event.1', eventId: 'privacy_delete_1', kind: 'evidence_deleted',
    authorityRef: value.guard.authorityRef, scope: clone(value.guard.scope), authorizationRevision: value.guard.authorizationRevision,
    guardDigest: deleted.guardDigest, occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
    evidenceIds: [value.completed.assetRefs[0].evidenceId]
  };
  await applyTrustedPrivacyEvent(event, { store: value.store, guardProvider: deletedProvider, clock: value.clock });
  await assert.rejects(() => applyTrustedPrivacyEvent({ ...event, evidenceIds: [value.completed.assetRefs.at(-1).evidenceId] }, {
    store: value.store, guardProvider: deletedProvider, clock: value.clock
  }), /LAB_PRIVACY_EVENT_ID_CONFLICT/);
  const classificationOnly = clone(value.guard);
  classificationOnly.purposes = ['classification'];
  classificationOnly.guardDigest = computeLabGuardDigest(classificationOnly);
  const view = await getLabProductJobView(value.completed.jobId, {
    store: value.store,
    guardProvider: new MutableGuardProvider(classificationOnly),
    requiredPurpose: 'album_organization'
  });
  assert.equal(view.redacted, true);
});

test('failure mapping is unique and never implies automatic retry', () => {
  assert.deepEqual(mapLabExecutionFailure('LAB_RUN_TIMEOUT'), { status: 'failed_retryable', retryable: true });
  assert.deepEqual(mapLabExecutionFailure('LAB_PROVIDER_UNAVAILABLE'), { status: 'failed_retryable', retryable: true });
  assert.deepEqual(mapLabExecutionFailure('INVALID_OUTPUT'), { status: 'failed_terminal', retryable: false });
  assert.deepEqual(mapLabExecutionFailure('AUTHORIZATION_REVOKED'), { status: 'cancelled', retryable: false });
  assert.deepEqual(mapLabExecutionFailure('STALE_RESULT'), { status: 'unchanged', retryable: null });
});

test('store refuses truncated-id collisions, malformed records and asset tampering', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const collision = { ...pending, runIdentityDigest: sha('9'), idempotencyKey: sha('8') };
  await assert.rejects(() => value.store.create(collision, value.built.assets), /IDEMPOTENCY_CONFLICT/);
  const jobFile = path.join(value.store.root, pending.jobId, 'job.json');
  const original = await readFile(jobFile);
  await writeFile(jobFile, '{');
  await assert.rejects(() => value.store.get(pending.jobId), /LAB_STORE_CORRUPT/);
  await writeFile(jobFile, original);
  const ref = pending.assetRefs[0];
  const assetFile = path.join(value.store.root, pending.jobId, 'assets', ref.evidenceId);
  const bytes = await readFile(assetFile);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 0xff;
  await writeFile(assetFile, tampered);
  await assert.rejects(() => value.store.readAsset(pending.jobId, ref.evidenceId), /LAB_ASSET_HASH_MISMATCH/);
});

test('same run identity rejects immutable envelope, text payload and asset manifest drift', async t => {
  const value = await fixture(t);
  await submitLabExecutionJob(value.input, value.store, value.clock);
  const envelopeConflict = clone(value.input);
  envelopeConflict.built.envelope.bindings[0].bindingId = 'binding_same_semantics_new_id';
  await assert.rejects(
    () => submitLabExecutionJob(envelopeConflict, value.store, value.clock),
    /IDEMPOTENCY_CONFLICT/
  );

  const textConflict = clone(value.input);
  const textEvidenceId = Object.keys(textConflict.built.payloads.textByEvidenceId)[0];
  textConflict.built.payloads.textByEvidenceId[textEvidenceId] = ` ${textConflict.built.payloads.textByEvidenceId[textEvidenceId]} `;
  await assert.rejects(
    () => submitLabExecutionJob(textConflict, value.store, value.clock),
    /LAB_TEXT_PAYLOAD_MISMATCH/
  );

  const assetConflict = clone(value.input);
  assetConflict.built.assets[0].filename = 'same-bytes-different-name.png';
  await assert.rejects(
    () => submitLabExecutionJob(assetConflict, value.store, value.clock),
    /IDEMPOTENCY_CONFLICT/
  );
});

test('v2 store namespace contains only bounded job artifacts', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const entries = (await readdir(path.join(value.store.root, pending.jobId))).sort();
  assert.deepEqual(entries, ['assets', 'job.json']);
  assert.equal(path.basename(value.store.root), 'v2');
});

test('cancel between claim and controller registration is durable and prevents executor creation', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const paused = deferred();
  const release = deferred();
  const originalCoordinationKey = value.store.coordinationKey.bind(value.store);
  let calls = 0;
  value.store.coordinationKey = async jobId => {
    calls++;
    if(calls === 3) {
      paused.resolve();
      await release.promise;
    }
    return originalCoordinationKey(jobId);
  };
  const executor = deterministicExecutor(value.executionProfile);
  const factory = staticExecutorFactory(executor);
  const running = runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory,
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock,
    runnerGeneration: 'runner_claim_cancel_window'
  });
  await paused.promise;
  const cancelled = await cancelLabExecutionJob(pending.jobId, { store: value.store, clock: value.clock, reason: 'user' });
  release.resolve();
  const outcome = await running;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(factory.createCalls, 0);
  assert.equal(executor.calls, 0);
});

test('cancel persisted during preflight prevents factory creation before abort delivery', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const preflightEntered = deferred();
  const releasePreflight = deferred();
  const guardProvider = {
    async get() {
      preflightEntered.resolve();
      await releasePreflight.promise;
      return clone(value.guard);
    }
  };
  const cancelPersisted = deferred();
  const releaseCancelReturn = deferred();
  const originalCas = value.store.compareAndSetTrusted.bind(value.store);
  value.store.compareAndSetTrusted = async (...args) => {
    const result = await originalCas(...args);
    if(result.ok && result.record.status === 'cancelled' && result.record.error?.code === 'CANCELLED') {
      cancelPersisted.resolve();
      await releaseCancelReturn.promise;
    }
    return result;
  };
  const executor = deterministicExecutor(value.executionProfile);
  const factory = staticExecutorFactory(executor);
  const running = runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory,
    guardProvider,
    clock: value.clock,
    runnerGeneration: 'runner_cancel_during_preflight'
  });
  await preflightEntered.promise;
  const cancelling = cancelLabExecutionJob(pending.jobId, {
    store: value.store,
    clock: value.clock,
    reason: 'user'
  });
  await cancelPersisted.promise;
  releasePreflight.resolve();
  const outcome = await running;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(factory.createCalls, 0);
  assert.equal(executor.calls, 0);
  releaseCancelReturn.resolve();
  await cancelling;
});

test('one deadline covers hanging guards and executor-factory setup', async t => {
  await t.test('preflight guard', async t => {
    const value = await fixture(t, { deadlineAt: '2026-09-30T02:00:01.000Z' });
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const entered = deferred();
    const executor = deterministicExecutor(value.executionProfile);
    const factory = staticExecutorFactory(executor);
    const running = runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory,
      guardProvider: { async get() { entered.resolve(); return new Promise(() => {}); } },
      clock: value.clock,
      runnerGeneration: 'runner_hanging_preflight'
    });
    await entered.promise;
    value.clock.advance(1000);
    const outcome = await running;
    assert.equal(outcome.status, 'failed_retryable');
    assert.equal(outcome.error.code, 'LAB_RUN_TIMEOUT');
    assert.equal(factory.createCalls, 0);
    assert.equal(executor.calls, 0);
  });

  await t.test('executor factory creation', async t => {
    const value = await fixture(t, { deadlineAt: '2026-09-30T02:00:01.000Z' });
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const entered = deferred();
    const factory = {
      describe(current) { return clone(current); },
      async create() { entered.resolve(); return new Promise(() => {}); }
    };
    const running = runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory,
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_hanging_factory'
    });
    await entered.promise;
    value.clock.advance(1000);
    const outcome = await running;
    assert.equal(outcome.status, 'failed_retryable');
    assert.equal(outcome.error.code, 'LAB_RUN_TIMEOUT');
  });

  await t.test('final guard', async t => {
    const value = await fixture(t, { deadlineAt: '2026-09-30T02:00:01.000Z' });
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const enteredFinal = deferred();
    let calls = 0;
    const provider = {
      async get() {
        calls++;
        if(calls === 1) return clone(value.guard);
        enteredFinal.resolve();
        return new Promise(() => {});
      }
    };
    const executor = deterministicExecutor(value.executionProfile);
    const running = runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: provider,
      clock: value.clock,
      runnerGeneration: 'runner_hanging_final_guard'
    });
    await enteredFinal.promise;
    value.clock.advance(1000);
    const outcome = await running;
    assert.equal(outcome.status, 'failed_retryable');
    assert.equal(outcome.error.code, 'LAB_RUN_TIMEOUT');
    assert.equal(executor.calls, 1);
    assert.equal(outcome.result, undefined);
  });
});

test('failed preflight never touches credential or network getters', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const revoked = clone(value.guard);
  revoked.active = false;
  revoked.guardDigest = computeLabGuardDigest(revoked);
  let credentialReads = 0;
  let networkStarts = 0;
  const sensitiveSetup = {
    get credential() { credentialReads++; return 'should-not-be-read'; },
    get network() { networkStarts++; return 'should-not-start'; }
  };
  const executor = deterministicExecutor(value.executionProfile);
  const factory = {
    describe(current) { return clone(current); },
    create() {
      void sensitiveSetup.credential;
      void sensitiveSetup.network;
      return executor;
    }
  };
  const outcome = await runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory,
    guardProvider: new MutableGuardProvider(revoked),
    clock: value.clock,
    runnerGeneration: 'runner_preflight_no_sensitive_setup'
  });
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.error.code, 'AUTHORIZATION_REVOKED');
  assert.equal(credentialReads, 0);
  assert.equal(networkStarts, 0);
  assert.equal(executor.calls, 0);
});

test('factory identity and closed-world output gates fail before a result can commit', async t => {
  await t.test('factory description mismatch', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const executor = deterministicExecutor(value.executionProfile);
    const factory = staticExecutorFactory(executor, {
      describe: current => ({ ...current, promptVersion: 'prompt.mismatch' })
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory,
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_factory_mismatch'
    });
    assert.equal(outcome.status, 'failed_terminal');
    assert.equal(outcome.error.code, 'LAB_RUN_IDENTITY_MISMATCH');
    assert.equal(factory.createCalls, 0);
    assert.equal(executor.calls, 0);
  });

  await t.test('executor profile mismatch', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const executor = deterministicExecutor(profile({ promptVersion: 'prompt.mismatch' }));
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_executor_mismatch'
    });
    assert.equal(outcome.status, 'failed_terminal');
    assert.equal(outcome.error.code, 'LAB_RUN_IDENTITY_MISMATCH');
    assert.equal(executor.calls, 0);
  });

  await t.test('foreign content reference', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const executor = deterministicExecutor(value.executionProfile, {
      after: async (_input, output) => { output.observations[0].contentId = 'foreign_content'; }
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_foreign_result'
    });
    assert.equal(outcome.status, 'failed_terminal');
    assert.equal(outcome.error.code, 'INVALID_OUTPUT');
    assert.equal(outcome.result, undefined);
  });

  await t.test('incomplete story coverage', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const executor = deterministicExecutor(value.executionProfile, {
      after: async (_input, output) => { output.organization.stories = []; }
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_incomplete_story_coverage'
    });
    assert.equal(outcome.status, 'failed_terminal');
    assert.equal(outcome.error.code, 'INVALID_OUTPUT');
  });

  await t.test('story facet without member observation', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const executor = deterministicExecutor(value.executionProfile, {
      after: async (_input, output) => { output.organization.stories[0].facets.people.push('张建国'); }
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_unbound_story_facet'
    });
    assert.equal(outcome.status, 'failed_terminal');
    assert.equal(outcome.error.code, 'INVALID_OUTPUT');
  });

  await t.test('missing original batch binding', async t => {
    const value = await fixture(t, {
      submission: submission({ userTextTargetIndexes: null })
    });
    assert.ok(value.built.envelope.bindings.some(binding => binding.target.kind === 'batch'));
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const executor = deterministicExecutor(value.executionProfile, {
      after: async (_input, output) => { output.batchBindings = []; }
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_missing_batch_binding'
    });
    assert.equal(outcome.status, 'failed_terminal');
    assert.equal(outcome.error.code, 'INVALID_OUTPUT');
  });

  await t.test('missing user-explicit content association', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const executor = deterministicExecutor(value.executionProfile, {
      after: async (_input, output) => {
        output.organization.associations = output.organization.associations
          .filter(association => association.source !== 'user_explicit');
      }
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_missing_user_association'
    });
    assert.equal(outcome.status, 'failed_terminal');
    assert.equal(outcome.error.code, 'INVALID_OUTPUT');
  });

  await t.test('mutated user-explicit content association', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const executor = deterministicExecutor(value.executionProfile, {
      after: async (_input, output) => {
        const association = output.organization.associations
          .find(candidate => candidate.source === 'user_explicit');
        assert.ok(association);
        association.method = 'provider_rewritten_user_fact';
      }
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_mutated_user_association'
    });
    assert.equal(outcome.status, 'failed_terminal');
    assert.equal(outcome.error.code, 'INVALID_OUTPUT');
  });

  await t.test('withdrawn user-explicit content association is preserved as rejected', async t => {
    const value = await fixture(t, {
      submission: submission({
        images: [
          { filename: 'active-target.png', mimeType: 'image/png', bytes: png(1) },
          { filename: 'withdrawn-target.png', mimeType: 'image/png', bytes: png(2) }
        ],
        userTextTargetIndexes: [0]
      }),
      mutateBuilt(built) {
        const active = built.envelope.bindings.find(binding =>
          binding.authority === 'user_explicit' && binding.target.kind === 'contents');
        const source = built.envelope.contents.find(content => content.contentId === active?.sourceContentId);
        const secondImage = built.envelope.contents.filter(content => content.modality === 'image')[1];
        assert.ok(active);
        assert.ok(source);
        assert.ok(secondImage);
        built.envelope.bindings.push({
          ...clone(active),
          bindingId: 'binding_user_withdrawn',
          target: { kind: 'contents', contentIds: [secondImage.contentId] },
          evidenceRefs: [source.evidenceId, secondImage.evidenceId],
          state: 'withdrawn'
        });
      }
    });
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(deterministicExecutor(value.executionProfile)),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_withdrawn_user_association'
    });
    assert.ok(['succeeded', 'needs_review'].includes(outcome.status));
    const rejected = outcome.result.output.organization.associations
      .find(association => association.associationId.includes('assoc_') && association.status === 'rejected');
    assert.ok(rejected);
    assert.equal(rejected.source, 'user_explicit');
  });
});

test('review gate distinguishes named identity candidates from generic unnamed people', async t => {
  for(const [index, [label, expected]] of [['张建国', 'needs_review'], ['未命名人物', 'succeeded']].entries()) await t.test(label, async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const image = value.built.envelope.contents.find(item => item.modality === 'image');
    const executor = deterministicExecutor(value.executionProfile, {
      after: async (_input, output) => output.observations.push({
        contentId: image.contentId,
        evidenceId: image.evidenceId,
        facet: 'person',
        rawValue: label,
        normalizedValue: label === '张建国' ? 'person_group_1' : 'unnamed_person',
        supports: [{ evidenceId: image.evidenceId, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
        state: 'candidate'
      })
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: `runner_review_${index}`
    });
    assert.equal(outcome.status, expected);
    assert.equal(outcome.result.workflowStatus, expected);
  });
});

test('review gate catches normalized identities and structured high-impact claims', async t => {
  await t.test('normalized identity', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const image = value.built.envelope.contents.find(item => item.modality === 'image');
    const executor = deterministicExecutor(value.executionProfile, {
      after: async (_input, output) => output.observations.push({
        contentId: image.contentId,
        evidenceId: image.evidenceId,
        facet: 'person',
        rawValue: '人物A',
        normalizedValue: '张建国',
        supports: [{ evidenceId: image.evidenceId }],
        state: 'candidate'
      })
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: 'runner_normalized_identity_review'
    });
    assert.equal(outcome.status, 'needs_review');
  });

  for(const claimKind of ['relationship', 'sensitive_fact']) await t.test(claimKind, async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const image = value.built.envelope.contents.find(item => item.modality === 'image');
    const executor = deterministicExecutor(value.executionProfile, {
      after: async (_input, output) => output.highImpactClaims.push({
        claimId: `claim_${claimKind}`,
        claimKind,
        impactLevel: 'high',
        authority: 'ai_candidate',
        value: claimKind === 'relationship' ? '可能是父女关系' : '可能涉及健康信息',
        contentIds: [image.contentId],
        evidenceRefs: [image.evidenceId],
        reviewRequired: true
      })
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: `runner_${claimKind}_review`
    });
    assert.equal(outcome.status, 'needs_review');
    assert.equal(outcome.result.output.highImpactClaims[0].authority, 'ai_candidate');
  });
});

test('stage_a_mock uses the same lifecycle without claiming real transport evidence', async t => {
  const mockProfile = profile({
    providerMode: 'stage_a_mock',
    providerVersion: 'stage-a-mock.1',
    modelVersion: 'qwen-mock.1',
    promptVersion: 'prompt-mock.1'
  });
  const value = await fixture(t, { profile: mockProfile });
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const executor = stageAMockExecutor(value.executionProfile);
  const completed = await runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory: staticExecutorFactory(executor),
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock,
    runnerGeneration: 'runner_stage_a_mock'
  });
  assert.ok(['succeeded', 'needs_review'].includes(completed.status));
  assert.equal(completed.result.output.provider.evidenceStatus, 'mock_transport');
  assert.equal(completed.result.output.provider.accuracyClaim, 'not_evaluated');
  assert.equal(completed.metrics.modelRequests, 0);
  assert.equal(completed.metrics.costCny, 0);

  const invalid = await fixture(t, { profile: mockProfile, attemptRevision: 2 });
  const invalidPending = await submitLabExecutionJob(invalid.input, invalid.store, invalid.clock);
  const invalidExecutor = stageAMockExecutor(invalid.executionProfile, {
    after: async (_input, output) => { output.provider.promptVersion = 'prompt-wrong.1'; }
  });
  const rejected = await runPendingLabExecutionJob(invalidPending.jobId, {
    store: invalid.store,
    factory: staticExecutorFactory(invalidExecutor),
    guardProvider: new MutableGuardProvider(invalid.guard),
    clock: invalid.clock,
    runnerGeneration: 'runner_stage_a_mock_invalid'
  });
  assert.equal(rejected.status, 'failed_terminal');
  assert.equal(rejected.error.code, 'INVALID_OUTPUT');
});

test('durable evidence deletion hides assets and all derived semantics even with a stale active guard', async t => {
  const value = await executeFixture(t, {
    submission: submission({ images: [{ filename: 'UNIQUE_SECRET.png', mimeType: 'image/png', bytes: png(7) }] })
  });
  const imageEvidenceId = value.completed.assetRefs[0].evidenceId;
  const deleted = tombstoneGuard(value.guard, value.built, [imageEvidenceId]);
  const event = {
    version: 'classification-lab-privacy-event.1',
    eventId: 'privacy_delete_secret',
    kind: 'evidence_deleted',
    authorityRef: value.guard.authorityRef,
    scope: clone(value.guard.scope),
    authorizationRevision: value.guard.authorizationRevision,
    guardDigest: deleted.guardDigest,
    occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
    evidenceIds: [imageEvidenceId]
  };
  await applyTrustedPrivacyEvent(event, {
    store: value.store,
    guardProvider: new MutableGuardProvider(deleted),
    clock: value.clock
  });
  const staleGuardProvider = new MutableGuardProvider(value.guard);
  const view = await getLabProductJobView(value.completed.jobId, {
    store: value.store,
    guardProvider: staleGuardProvider,
    requiredPurpose: 'album_organization'
  });
  assert.equal(view.redacted, false);
  assert.equal(Object.hasOwn(view, 'result'), false);
  assert.equal(JSON.stringify(view).includes('UNIQUE_SECRET'), false);
  assert.equal(view.assetRefs.some(item => item.evidenceId === imageEvidenceId), false);
  assert.equal(view.envelope.evidence.some(item => item.evidenceId === imageEvidenceId), false);
  const listed = await listLabProductJobViews({
    store: value.store,
    guardProvider: staleGuardProvider,
    requiredPurpose: 'album_organization'
  });
  assert.equal(JSON.stringify(listed).includes('UNIQUE_SECRET'), false);
  await assert.rejects(() => readLabProductAsset(value.completed.jobId, imageEvidenceId, {
    store: value.store,
    guardProvider: staleGuardProvider,
    requiredPurpose: 'album_organization'
  }), /INACTIVE_EVIDENCE/);
});

test('one trusted privacy event fans out, replays idempotently, and fences future submissions', async t => {
  const value = await fixture(t);
  const jobs = [];
  for(const attemptRevision of [1, 2]) {
    jobs.push(await submitLabExecutionJob({ ...value.input, attemptRevision }, value.store, value.clock));
  }
  const imageEvidenceId = jobs[0].assetRefs[0].evidenceId;
  const deleted = tombstoneGuard(value.guard, value.built, [imageEvidenceId]);
  const event = {
    version: 'classification-lab-privacy-event.1',
    eventId: 'privacy_delete_fanout',
    kind: 'evidence_deleted',
    authorityRef: value.guard.authorityRef,
    scope: clone(value.guard.scope),
    authorizationRevision: value.guard.authorizationRevision,
    guardDigest: deleted.guardDigest,
    occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
    evidenceIds: [imageEvidenceId]
  };
  const first = await applyTrustedPrivacyEvent(event, {
    store: value.store,
    guardProvider: new MutableGuardProvider(deleted),
    clock: value.clock
  });
  const replay = await applyTrustedPrivacyEvent(event, {
    store: value.store,
    guardProvider: new MutableGuardProvider(deleted),
    clock: value.clock
  });
  assert.deepEqual(first, { matched: 2, updated: 2 });
  assert.deepEqual(replay, { matched: 2, updated: 0 });
  for(const job of jobs) {
    const stored = await value.store.get(job.jobId);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.privacyEvents.filter(item => item.eventId === event.eventId).length, 1);
  }
  await assert.rejects(() => submitLabExecutionJob({ ...value.input, attemptRevision: 3 }, value.store, value.clock), /INACTIVE_EVIDENCE/);
});

test('v2 content actions are trusted, idempotent audit entries and never mutate frozen provider output', async t => {
  const value = await executeFixture(t);
  const beforeResult = clone(value.completed.result);
  const beforeDigest = value.completed.resultDigest;
  const storyId = value.completed.result.output.organization.stories[0].storyId;
  const request = {
    actionId: 'action_accept_story_1',
    kind: 'accept_story',
    targetIds: [storyId],
    actorId: value.guard.actorId,
    expectedRevision: value.completed.revision
  };
  const accepted = await applyLabExecutionAction(value.completed.jobId, request, {
    store: value.store,
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock
  });
  const replay = await applyLabExecutionAction(value.completed.jobId, request, {
    store: value.store,
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock
  });
  assert.equal(accepted.actions.length, 1);
  assert.equal(replay.revision, accepted.revision);
  assert.deepEqual(replay.result, beforeResult);
  assert.equal(replay.resultDigest, beforeDigest);
  await assert.rejects(() => applyLabExecutionAction(value.completed.jobId, {
    actionId: 'action_stale_revision',
    kind: 'accept_story',
    targetIds: [storyId],
    actorId: value.guard.actorId,
    expectedRevision: value.completed.revision
  }, {
    store: value.store,
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock
  }), /LAB_JOB_REVISION_CONFLICT/);
  await assert.rejects(() => applyLabExecutionAction(value.completed.jobId, {
    ...request,
    kind: 'remove_content',
    targetIds: [value.completed.envelope.contents[0].contentId]
  }, {
    store: value.store,
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock
  }), /LAB_ACTION_ID_CONFLICT/);
  await assert.rejects(() => applyLabExecutionAction(value.completed.jobId, {
    ...request,
    actionId: 'action_privacy_forbidden',
    kind: 'delete_evidence',
    targetIds: [value.completed.envelope.evidence[0].evidenceId],
    expectedRevision: accepted.revision
  }, {
    store: value.store,
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock
  }), /LAB_TRUSTED_PRIVACY_EVENT_REQUIRED/);

  const pendingFixture = await fixture(t, { attemptRevision: 91 });
  const pending = await submitLabExecutionJob(pendingFixture.input, pendingFixture.store, pendingFixture.clock);
  await assert.rejects(() => applyLabExecutionAction(pending.jobId, {
    actionId: 'action_pending_invalid',
    kind: 'remove_content',
    targetIds: [pending.envelope.contents[0].contentId],
    actorId: pendingFixture.guard.actorId,
    expectedRevision: pending.revision
  }, {
    store: pendingFixture.store,
    guardProvider: new MutableGuardProvider(pendingFixture.guard),
    clock: pendingFixture.clock
  }), /LAB_ACTION_STATUS_INVALID/);
});

test('recovery removes only valid orphan temp directories and replays the durable privacy ledger', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const validOrphan = path.join(value.store.root, `.pending-orphan_job-${randomUUID()}`);
  await mkdir(path.join(validOrphan, 'assets'), { recursive: true, mode: 0o700 });
  const malformedOrphan = path.join(value.store.root, '.pending-bad');
  await mkdir(malformedOrphan, { mode: 0o700 });
  const imageEvidenceId = pending.assetRefs[0].evidenceId;
  const deleted = tombstoneGuard(value.guard, value.built, [imageEvidenceId]);
  const event = {
    version: 'classification-lab-privacy-event.1',
    eventId: 'privacy_recovery_replay',
    kind: 'evidence_deleted',
    authorityRef: value.guard.authorityRef,
    scope: clone(value.guard.scope),
    authorizationRevision: value.guard.authorizationRevision,
    guardDigest: deleted.guardDigest,
    occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
    evidenceIds: [imageEvidenceId]
  };
  await value.store.recordVerifiedPrivacyEvent(event);
  const report = await recoverInterruptedLabJobs({
    store: value.store,
    guardProvider: new MutableGuardProvider(deleted),
    clock: value.clock,
    runnerGeneration: 'runner_recovery_privacy'
  });
  assert.equal(report.orphanTempsRemoved, 1);
  assert.equal(report.orphanTempsCorrupt, 1);
  assert.equal(report.privacyEventsReplayed, 1);
  assert.equal((await value.store.get(pending.jobId)).status, 'cancelled');
  assert.equal((await readdir(value.store.root)).includes(path.basename(validOrphan)), false);
  assert.equal((await readdir(value.store.root)).includes(path.basename(malformedOrphan)), true);
});

test('recovery replays privacy before classifying processing work as interrupted', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const claimedAt = new Date(value.clock.nowMs()).toISOString();
  await value.store.compareAndSetTrusted(pending.jobId, pending.revision, current => ({
    ...current,
    status: 'processing',
    startedAt: claimedAt,
    updatedAt: claimedAt,
    processingOwner: { runnerGeneration: 'runner_previous_generation', claimedAt },
    transitions: [...current.transitions, {
      from: 'pending',
      to: 'processing',
      reason: 'LAB_JOB_CLAIMED',
      at: claimedAt,
      revision: current.revision + 1,
      runnerGeneration: 'runner_previous_generation'
    }]
  }));
  const imageEvidenceId = pending.assetRefs[0].evidenceId;
  const deleted = tombstoneGuard(value.guard, value.built, [imageEvidenceId]);
  const event = {
    version: 'classification-lab-privacy-event.1',
    eventId: 'privacy_recovery_precedes_interrupted',
    kind: 'evidence_deleted',
    authorityRef: value.guard.authorityRef,
    scope: clone(value.guard.scope),
    authorizationRevision: value.guard.authorizationRevision,
    guardDigest: deleted.guardDigest,
    occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
    evidenceIds: [imageEvidenceId]
  };
  await value.store.recordVerifiedPrivacyEvent(event);
  const report = await recoverInterruptedLabJobs({
    store: value.store,
    guardProvider: new MutableGuardProvider(deleted),
    clock: value.clock,
    runnerGeneration: 'runner_recovery_current'
  });
  const recovered = await value.store.get(pending.jobId);
  assert.equal(report.privacyEventsReplayed, 1);
  assert.equal(report.interrupted, 0);
  assert.equal(recovered.status, 'cancelled');
  assert.equal(recovered.error.code, 'EVIDENCE_CHANGED');
});

test('store rejects linked asset files instead of following filesystem aliases', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const ref = pending.assetRefs[0];
  const asset = path.join(value.store.root, pending.jobId, 'assets', ref.evidenceId);
  const alias = path.join(value.root, 'asset-hardlink');
  await link(asset, alias);
  await assert.rejects(() => value.store.readAsset(pending.jobId, ref.evidenceId), /LAB_STORE_CORRUPT/);
});

test('terminal failure schema rejects success metrics and inconsistent error disposition', async t => {
  const value = await fixture(t, { deadlineAt: '2026-09-30T02:00:01.000Z' });
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const entered = deferred();
  const running = runPendingLabExecutionJob(pending.jobId, {
    store: value.store,
    factory: staticExecutorFactory({
      profile: value.executionProfile,
      async execute() { entered.resolve(); return new Promise(() => {}); }
    }),
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock,
    runnerGeneration: 'runner_failure_schema'
  });
  await entered.promise;
  value.clock.advance(1000);
  const failed = await running;
  assert.equal(parseLabJobV2(failed).status, 'failed_retryable');
  assert.throws(() => parseLabJobV2({ ...failed, metrics: zeroMetrics() }), /FAILURE_HAS_SUCCESS|outcome/i);
  assert.throws(() => parseLabJobV2({ ...failed, error: { code: 'LAB_RUN_TIMEOUT', retryable: false } }), /DISPOSITION|retryable/i);
  assert.throws(() => parseLabJobV2({ ...failed, termination: undefined }), /TERMINATION|timeout/i);
});

test('unverified privacy events never enter the durable ledger or mutate a job', async t => {
  const value = await fixture(t);
  const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
  const imageEvidenceId = pending.assetRefs[0].evidenceId;
  const event = {
    version: 'classification-lab-privacy-event.1',
    eventId: 'privacy_unverified_delete',
    kind: 'evidence_deleted',
    authorityRef: value.guard.authorityRef,
    scope: clone(value.guard.scope),
    authorizationRevision: value.guard.authorizationRevision,
    guardDigest: value.guard.guardDigest,
    occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
    evidenceIds: [imageEvidenceId]
  };
  await assert.rejects(() => applyTrustedPrivacyEvent(event, {
    store: value.store,
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock
  }), /LAB_PRIVACY_EVENT_UNVERIFIED/);
  assert.equal((await value.store.listPrivacyEvents()).length, 0);
  const unchanged = await value.store.get(pending.jobId);
  assert.equal(unchanged.status, 'pending');
  assert.equal(unchanged.privacyEvents.length, 0);
});

test('durable privacy fence blocks in-flight asset reads and terminal commits before job fan-out', async t => {
  for(const phase of ['asset_read', 'terminal_commit']) await t.test(phase, async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const imageEvidenceId = pending.assetRefs[0].evidenceId;
    const deleted = tombstoneGuard(value.guard, value.built, [imageEvidenceId]);
    const event = {
      version: 'classification-lab-privacy-event.1',
      eventId: `privacy_fence_${phase}`,
      kind: 'evidence_deleted',
      authorityRef: value.guard.authorityRef,
      scope: clone(value.guard.scope),
      authorizationRevision: value.guard.authorizationRevision,
      guardDigest: deleted.guardDigest,
      occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
      evidenceIds: [imageEvidenceId]
    };
    let executor;
    if(phase === 'asset_read') {
      executor = {
        profile: value.executionProfile,
        async execute(input) {
          await value.store.recordVerifiedPrivacyEvent(event);
          await input.readAsset(imageEvidenceId);
          throw new Error('ASSET_READ_SHOULD_HAVE_BEEN_FENCED');
        }
      };
    } else {
      executor = deterministicExecutor(value.executionProfile, {
        after: async () => { await value.store.recordVerifiedPrivacyEvent(event); }
      });
    }
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider: new MutableGuardProvider(value.guard),
      clock: value.clock,
      runnerGeneration: `runner_privacy_fence_${phase}`
    });
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.error.code, 'INACTIVE_EVIDENCE');
    assert.equal(outcome.result, undefined);
  });
});

test('privacy fence closes live-guard TOCTOU windows for assets and terminal commit', async t => {
  await t.test('deletion written during live guard blocks execution asset bytes', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const imageEvidenceId = pending.assetRefs[0].evidenceId;
    const deleted = tombstoneGuard(value.guard, value.built, [imageEvidenceId]);
    const event = {
      version: 'classification-lab-privacy-event.1',
      eventId: 'privacy_asset_live_guard_toctou',
      kind: 'evidence_deleted',
      authorityRef: value.guard.authorityRef,
      scope: clone(value.guard.scope),
      authorizationRevision: value.guard.authorizationRevision,
      guardDigest: deleted.guardDigest,
      occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
      evidenceIds: [imageEvidenceId]
    };
    let guardCalls = 0;
    const guardProvider = {
      async get() {
        guardCalls++;
        if(guardCalls === 2) await value.store.recordVerifiedPrivacyEvent(event);
        return clone(value.guard);
      }
    };
    let bytesRead = false;
    const executor = deterministicExecutor(value.executionProfile, {
      before: async input => {
        await input.readAsset(imageEvidenceId);
        bytesRead = true;
      }
    });
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(executor),
      guardProvider,
      clock: value.clock,
      runnerGeneration: 'runner_asset_live_guard_toctou'
    });
    assert.equal(bytesRead, false);
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.error.code, 'INACTIVE_EVIDENCE');
  });

  await t.test('deletion written after commit guard blocks terminal success', async t => {
    const value = await fixture(t);
    const pending = await submitLabExecutionJob(value.input, value.store, value.clock);
    const imageEvidenceId = pending.assetRefs[0].evidenceId;
    const deleted = tombstoneGuard(value.guard, value.built, [imageEvidenceId]);
    const event = {
      version: 'classification-lab-privacy-event.1',
      eventId: 'privacy_terminal_commit_toctou',
      kind: 'evidence_deleted',
      authorityRef: value.guard.authorityRef,
      scope: clone(value.guard.scope),
      authorizationRevision: value.guard.authorizationRevision,
      guardDigest: deleted.guardDigest,
      occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
      evidenceIds: [imageEvidenceId]
    };
    let armInjection = false;
    let getsAfterCommitGuard = 0;
    let injected = false;
    let guardCalls = 0;
    const guardProvider = {
      async get() {
        guardCalls++;
        if(guardCalls === 2) armInjection = true;
        return clone(value.guard);
      }
    };
    const originalGet = value.store.get.bind(value.store);
    value.store.get = async jobId => {
      const record = await originalGet(jobId);
      if(armInjection && ++getsAfterCommitGuard === 2 && !injected) {
        injected = true;
        await value.store.recordVerifiedPrivacyEvent(event);
      }
      return record;
    };
    const outcome = await runPendingLabExecutionJob(pending.jobId, {
      store: value.store,
      factory: staticExecutorFactory(deterministicExecutor(value.executionProfile)),
      guardProvider,
      clock: value.clock,
      runnerGeneration: 'runner_terminal_commit_toctou'
    });
    assert.equal(injected, true);
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.error.code, 'INACTIVE_EVIDENCE');
    assert.equal(outcome.result, undefined);
  });
});

test('durable privacy ledger fences ordinary actions before job fan-out', async t => {
  const value = await executeFixture(t);
  const imageEvidenceId = value.completed.assetRefs[0].evidenceId;
  const deleted = tombstoneGuard(value.guard, value.built, [imageEvidenceId]);
  const event = {
    version: 'classification-lab-privacy-event.1',
    eventId: 'privacy_action_before_fanout',
    kind: 'evidence_deleted',
    authorityRef: value.guard.authorityRef,
    scope: clone(value.guard.scope),
    authorizationRevision: value.guard.authorizationRevision,
    guardDigest: deleted.guardDigest,
    occurredAt: new Date(value.clock.nowMs() + 1).toISOString(),
    evidenceIds: [imageEvidenceId]
  };
  await value.store.recordVerifiedPrivacyEvent(event);
  const storyId = value.completed.result.output.organization.stories[0].storyId;
  await assert.rejects(() => applyLabExecutionAction(value.completed.jobId, {
    actionId: 'action_blocked_by_privacy_ledger',
    kind: 'accept_story',
    targetIds: [storyId],
    actorId: value.guard.actorId,
    expectedRevision: value.completed.revision
  }, {
    store: value.store,
    guardProvider: new MutableGuardProvider(value.guard),
    clock: value.clock
  }), /INACTIVE_EVIDENCE/);
  assert.equal((await value.store.get(value.completed.jobId)).actions.length, 0);
});
