import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkerRuntime, LocalFeatureBundleProcessor, createJsonLogger } from '../../classification-worker/runtime/worker-runtime.mjs';
import { StageAPipelineProcessor, SubprocessStageABridge } from '../../classification-worker/runtime/pipeline-processor.mjs';
import { AsrWorkerRuntime } from '../../classification-worker/runtime/asr-worker-runtime.mjs';
import { LocalFeatureServiceClient } from '../../classification-worker/runtime/http-clients.mjs';

export const API_VERSION = 'classification-direct-api.1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BODY = 81 * 1024 * 1024;
const MAX_AUDIO_BODY = 51 * 1024 * 1024;
const TERMINAL = new Set(['succeeded', 'needs_review', 'failed_retryable', 'failed_terminal', 'cancelled', 'failed']);
const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });

// Credentials and the caller identity come from the trusted product backend.
// The public browser must never receive this service token.
export async function createDirectService({
  buildDir, dataRoot, budgetDataRoot = dataRoot, authorizationPath,
  token, gitCommit, model = 'qwen3.7-flash-2026-07-15',
  featureEndpoint = 'http://127.0.0.1:8766',
  scratchRoot = '/tmp/sgx-classification/jobs/direct-api',
  environment = process.env, logger = createJsonLogger(),
  featureService: injectedFeature, processor: injectedProcessor,
  featureReady: injectedFeatureReady, automaticProcessing = true,
}) {
  if (!path.isAbsolute(dataRoot) || !path.isAbsolute(buildDir) || typeof token !== 'string' || token.length < 32) {
    throw failure('API_CONFIGURATION_INVALID', 500);
  }
  const core = name => require(path.join(buildDir, 'src/lib/algorithms/classification', `${name}.js`));
  const { ClassificationT1LabService } = core('t1-lab-service');
  const { ClassificationT1AsrService } = core('t1-asr-prejob');
  const { ClassificationWorkerControlPlane, verifyWorkerBearer } = core('worker-control-plane');
  const { FileRealCallBudgetGate, loadRealCallAuthorization } = core('real-call-budget');
  const { LabSubmissionMetadataSchema } = core('lab-contract');
  const { cancelLabExecutionJob, recoverInterruptedLabJobs } = core('lab-execution');
  const { stable, PROMPT_VERSION } = core('stage-a-contract');
  const lab = new ClassificationT1LabService({ dataRoot, provider: 'qwen', model,
    inputCnyPerMillion: 1.2, outputCnyPerMillion: 4.8 });
  const asr = new ClassificationT1AsrService({ dataRoot, publicBaseUrl: 'http://127.0.0.1:8765', leaseDurationMs: 300_000 });
  const authorization = authorizationPath ? await loadRealCallAuthorization(authorizationPath) : undefined;
  const budget = authorization ? new FileRealCallBudgetGate({ dataRoot: budgetDataRoot, authorization }) : undefined;
  const control = new ClassificationWorkerControlPlane({ dataRoot, store: lab.store, guardStore: lab.guardStore,
    publicBaseUrl: 'http://127.0.0.1:8765', realCallBudget: budget });
  const clock = { nowMs: () => Date.now(), setTimeout, clearTimeout };
  const workerId = `direct_${randomUUID().replaceAll('-', '')}`;
  const recovery = await recoverInterruptedLabJobs({ store: lab.store, guardProvider: lab.guardStore, clock, runnerGeneration: workerId });
  // A process restart never repeats an ASR attempt or a paid classification.
  for (const job of await asr.store.list(100)) {
    if (job.status !== 'processing') continue;
    await asr.store.update(job.jobId, job.revision, current => {
      const { lease: _lease, ...rest } = current;
      const at = new Date().toISOString();
      return { ...rest, status: 'failed', errorCode: 'ASR_RUN_INTERRUPTED', finishedAt: at, updatedAt: at };
    });
  }
  logger.info('api_recovery', { interrupted: recovery.interrupted, corrupt: recovery.corrupt });
  const versions = {
    gitCommit, contractVersion: 'classification-ingestion.2',
    providerVersion: `qwen:${model}:${PROMPT_VERSION}:stage-a-validation.4`,
    promptVersion: PROMPT_VERSION, guardVersion: 'classification-lab-guard.1',
    adapterVersion: 'classification-lab-stage-a-composition.2', taxonomyVersion: 'classification-lab-taxonomy.1',
    ocrVersion: environment.SGX_OCR_MODEL_REVISION ?? 'unconfigured',
    embeddingVersion: environment.SGX_EMBEDDING_REVISION ?? 'unconfigured',
  };
  const featureClient = injectedFeature ?? new LocalFeatureServiceClient({ endpoint: featureEndpoint });
  const feature = Object.fromEntries(['ocr', 'imageEmbedding', 'modelImage', 'textEmbedding', 'faceEmbeddings', 'asr']
    .map(method => [method, (source, options = {}) => {
      const deadline = AbortSignal.timeout(method === 'asr' ? 240_000 : 120_000);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      return featureClient[method](source, { ...options, signal });
    }]));
  const internal = Object.fromEntries(['lease', 'heartbeat', 'executionContext', 'historicalQuery', 'complete', 'fail', 'cancelAck']
    .map(name => [name, (...args) => control[name](...args)]));
  const artifacts = {
    async downloadToFile({ url, destination, maxByteLength, signal }) {
      signal?.throwIfAborted();
      const parsed = new URL(url);
      if (parsed.origin !== 'http://127.0.0.1:8765') throw failure('INTERNAL_ARTIFACT_INVALID');
      const segments = parsed.pathname.split('/');
      const audio = parsed.pathname.includes('/asr/');
      const asset = audio
        ? await asr.readAudio(segments.at(-1), parsed.searchParams.get('token'))
        : await control.readArtifact(segments.at(-2), segments.at(-1), parsed.searchParams.get('token'));
      if (asset.bytes.length > maxByteLength) throw failure('ARTIFACT_SIZE_INVALID');
      await writeFile(destination, asset.bytes, { mode: 0o600, flag: 'wx' });
      return { sha256: `sha256:${hash(asset.bytes)}`, byteLength: asset.bytes.length };
    },
    async upload({ url, bytes, mimeType, signal }) {
      signal?.throwIfAborted();
      const parsed = new URL(url);
      if (parsed.origin !== 'http://127.0.0.1:8765') throw failure('INTERNAL_ARTIFACT_INVALID');
      const segments = parsed.pathname.split('/');
      return control.uploadResult({ jobId: segments.at(-2), artifactId: segments.at(-1),
        uploadToken: parsed.searchParams.get('token'), bytes, mimeType });
    },
  };
  const processor = injectedProcessor ?? new StageAPipelineProcessor({
    featureProcessor: new LocalFeatureBundleProcessor({ featureService: feature, personMatchingEnabled: true }),
    contextProvider: internal, historicalRetrieval: internal,
    bridge: new SubprocessStageABridge({ buildDir, environment }),
  });
  const runtime = new WorkerRuntime({ workerId, versions, capabilities: {
    modalities: ['image', 'user_text', 'final_asr'],
    features: ['hash', 'ocr', 'image_embedding', 'text_embedding', 'vlm_extract', 'vlm_relate', 'story_summary'],
    maxImagesPerJob: 8, personMatchingEnabled: true,
  }, controlPlane: internal, artifacts, processor, scratchRoot, maxJobs: 1, logger });
  const asrRuntime = new AsrWorkerRuntime({ workerId,
    controlPlane: Object.fromEntries(['lease', 'heartbeat', 'complete', 'fail'].map(name => [
      `asr${name[0].toUpperCase()}${name.slice(1)}`, (...args) => asr[name](...args),
    ])), artifacts, featureService: feature, scratchRoot: path.join(scratchRoot, 'asr'), maxJobs: 1, logger });

  const featureReady = injectedFeatureReady ?? (async () => {
    const response = await fetch(`${featureEndpoint}/readyz`, { signal: AbortSignal.timeout(3_000), redirect: 'error' });
    return response.ok && (await response.json()).status === 'ready';
  });
  const idempotencyRoot = path.join(dataRoot, 'direct-api-idempotency');
  await mkdir(idempotencyRoot, { recursive: true, mode: 0o700 });
  let serial = Promise.resolve();
  const exclusive = operation => {
    const task = serial.catch(() => {}).then(operation);
    serial = task.catch(() => {});
    return task;
  };
  let pumping = null;
  let closed = false;
  let dispatchError;
  async function pump() {
    if (pumping || closed) return pumping;
    pumping = (async () => {
      try {
        // Expired queued jobs become visible terminal records, never invisible pending forever.
        for (const job of await lab.store.list(100)) {
          if (job.status === 'pending' && Date.now() >= Date.parse(job.deadlineAt)) {
            await cancelLabExecutionJob(job.jobId, { store: lab.store, clock });
          }
        }
        for (const job of await asr.store.list(100)) {
          if (job.status === 'pending' && Date.now() >= Date.parse(job.deadlineAt)) {
            await asr.store.update(job.jobId, job.revision, current => {
              const at = new Date().toISOString();
              return { ...current, status: 'failed', errorCode: 'ASR_DEADLINE_EXCEEDED',
                startedAt: at, finishedAt: at, updatedAt: at };
            });
          }
        }
        if (!(await featureReady().catch(() => false))) return;
        await asrRuntime.runOnce();
        if (budget && (await budget.readStatus()).state === 'active') await runtime.runOnce();
        dispatchError = undefined;
      } catch (error) {
        dispatchError = /^[A-Z0-9_]{1,100}$/.test(error.code ?? error.message) ? (error.code ?? error.message) : 'DISPATCH_FAILED';
        logger.error('api_dispatch_failed', { errorCode: dispatchError });
      }
    })().finally(() => { pumping = null; });
    return pumping;
  }
  const timer = automaticProcessing ? setInterval(() => { void pump(); }, 2_000) : null;
  timer?.unref();
  let uploads = 0;
  const responseJson = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const readBody = async (req, max) => {
    if (Number(req.headers['content-length']) > max) throw failure('REQUEST_TOO_LARGE', 413);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw failure('REQUEST_TOO_LARGE', 413);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  function caller(req) {
    verifyWorkerBearer(req.headers.authorization, token);
    const values = ['x-sgx-household-id', 'x-sgx-subject-id', 'x-sgx-actor-id'].map(k => req.headers[k]);
    if (values.some(v => typeof v !== 'string' || !ID.test(v))) throw failure('CALLER_IDENTITY_REQUIRED');
    return { scope: { householdId: values[0], subjectId: values[1] }, actorId: values[2] };
  }
  function sameCaller(metadata, identity) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw failure('METADATA_INVALID');
    if (stable(metadata.scope) !== stable(identity.scope) || metadata.actorId !== identity.actorId) throw failure('CALLER_SCOPE_MISMATCH', 403);
  }
  async function activeSession(sessionId, identity) {
    if (!ID.test(sessionId ?? '')) throw failure('SESSION_ID_REQUIRED');
    return lab.sessions.requireActive({ sessionId, ...identity });
  }
  async function replayOrSubmit(req, identity, kind, body, operation) {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !ID.test(key)) throw failure('IDEMPOTENCY_KEY_REQUIRED');
    const target = path.join(idempotencyRoot, `${hash(stable({ identity, kind, key }))}.json`);
    // Hash binary data directly; serializing an 80 MiB Buffer as JSON would
    // unnecessarily multiply upload memory use.
    const fingerprint = binary => ({ filename: binary.filename, mimeType: binary.mimeType,
      byteLength: binary.bytes.length, sha256: hash(binary.bytes) });
    const requestDigest = hash(stable(kind === '/v1/asr/jobs'
      ? { ...body, bytes: fingerprint(body) }
      : { ...body, submission: { ...body.submission, images: body.submission.images.map(fingerprint) } }));
    return exclusive(async () => {
      try {
        const previous = JSON.parse(await readFile(target, 'utf8'));
        if (previous.requestDigest !== requestDigest) throw failure('IDEMPOTENCY_CONFLICT', 409);
        if (previous.error) throw failure(previous.error.code, previous.error.status);
        if (!previous.response) throw failure('SUBMISSION_OUTCOME_UNKNOWN', 409);
        return { ...previous.response, replayed: true };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // A crash between creating the durable job and writing its receipt must
      // not turn a client retry into another paid attempt.
      await writeFile(target, JSON.stringify({ requestDigest }), { mode: 0o600, flag: 'wx' });
      let result;
      try { result = await operation(); }
      catch (error) {
        const code = /^[A-Z][A-Z0-9_]{0,100}$/.test(error.code ?? '') ? error.code : 'SUBMISSION_FAILED';
        await writeFile(target, JSON.stringify({ requestDigest, error: { code, status: error.status ?? 400 } }), { mode: 0o600 });
        throw error;
      }
      const response = { apiVersion: API_VERSION, sessionId: result.session.sessionId,
        jobId: result.job.jobId, status: result.job.status, ...(result.round ? { round: result.round } : {}), replayed: false };
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ requestDigest, response }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
      return response;
    });
  }
  async function multipart(req, max, allowed) {
    const contentType = req.headers['content-type'] ?? '';
    if (!/^multipart\/form-data;/.test(contentType)) throw failure('MULTIPART_REQUIRED', 415);
    const form = await new Request('http://localhost/upload', { method: 'POST',
      headers: { 'content-type': contentType }, body: await readBody(req, max) }).formData();
    for (const key of form.keys()) if (!allowed.includes(key)) throw failure('UNKNOWN_FORM_FIELD');
    if (form.getAll('metadata').length !== 1 || typeof form.get('metadata') !== 'string'
      || Buffer.byteLength(form.get('metadata')) > 160 * 1024) throw failure('METADATA_INVALID');
    return { form, metadata: JSON.parse(form.get('metadata')) };
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') return responseJson(res, 200, { status: 'alive', apiVersion: API_VERSION });
      verifyWorkerBearer(req.headers.authorization, token);
      if (req.method === 'GET' && url.pathname === '/version') return responseJson(res, 200, {
        apiVersion: API_VERSION, gitCommit, model, promptVersion: PROMPT_VERSION, execution: 'embedded_executor', automaticRetries: 0,
        maxImagesPerRound: 8, maxImageBytes: 10 * 1024 * 1024, maxTotalBytes: 80 * 1024 * 1024,
        audio: 'microphone_pcm16_wav', personMatching: 'explicit_consent_per_round',
      });
      if (req.method === 'GET' && url.pathname === '/readyz') {
        const componentsReady = await featureReady().catch(() => false);
        const budgetStatus = budget ? await budget.readStatus() : { state: 'not_configured' };
        const classificationReady = componentsReady && budgetStatus.state === 'active'
          && budgetStatus.remaining.requests > 0 && !!environment.SGX_D4_API_KEY && !dispatchError;
        return responseJson(res, classificationReady ? 200 : 503, { status: classificationReady ? 'ready' : 'not_ready',
          componentsReady, asrReady: componentsReady, classificationReady, realCallBudget: budgetStatus,
          ...(dispatchError ? { errorCode: dispatchError } : {}) });
      }
      const identity = caller(req);
      const isAsr = url.pathname.startsWith('/v1/asr/jobs');
      const base = isAsr ? '/v1/asr/jobs' : '/v1/classification/jobs';
      if (req.method === 'POST' && url.pathname === base) {
        if (uploads >= 2) throw failure('UPLOAD_BUSY', 429);
        uploads++;
        try {
          const { form, metadata } = await multipart(req, isAsr ? MAX_AUDIO_BODY : MAX_BODY,
            isAsr ? ['metadata', 'audio'] : ['metadata', 'images']);
          sameCaller(metadata, identity);
          if (metadata.sessionId) await activeSession(metadata.sessionId, identity);
          if (!(await featureReady().catch(() => false))) throw failure('COMPONENTS_NOT_READY', 503);
          let body, operation;
          if (isAsr) {
            const allowed = ['sessionId', 'scope', 'actorId'];
            if (Object.keys(metadata).some(k => !allowed.includes(k))) throw failure('METADATA_INVALID');
            const audio = form.get('audio');
            if (form.getAll('audio').length !== 1 || typeof audio?.arrayBuffer !== 'function') throw failure('AUDIO_REQUIRED');
            body = { ...metadata, filename: audio.name, mimeType: audio.type, bytes: Buffer.from(await audio.arrayBuffer()) };
            operation = () => asr.submit(body);
          } else {
            const { sessionId, personMatchingAuthorized = false, ...raw } = metadata;
            if (typeof personMatchingAuthorized !== 'boolean') throw failure('PERSON_CONSENT_INVALID');
            const parsed = LabSubmissionMetadataSchema.parse(raw);
            const images = [];
            for (const image of form.getAll('images')) {
              if (typeof image?.arrayBuffer !== 'function') throw failure('IMAGE_REQUIRED');
              images.push({ filename: image.name, mimeType: image.type, bytes: Buffer.from(await image.arrayBuffer()) });
            }
            body = { sessionId, personMatchingAuthorized, submission: { ...parsed, images } };
            operation = async () => {
              if (!budget || !environment.SGX_D4_API_KEY) throw failure('REAL_CALL_NOT_CONFIGURED', 503);
              const available = await budget.readStatus();
              if (available.state !== 'active') throw failure('REAL_CALL_AUTHORIZATION_INACTIVE', 503);
              const n = images.length;
              if (n > 8) throw failure('T1_TOO_MANY_IMAGES');
              const bound = Math.max(1, n + Math.min(n * (n - 1) / 2, n));
              const queued = (await lab.store.list(100)).filter(j => j.status === 'pending');
              const heldRequests = queued.reduce((sum, j) => sum + j.budgetPolicy.maxRequests, 0);
              const heldCost = queued.reduce((sum, j) => sum + j.budgetPolicy.maxCostCny, 0);
              if (available.remaining.requests - heldRequests < bound
                || available.remaining.costCny - heldCost < Math.min(5, bound * 0.25)) {
                throw failure('REAL_CALL_BUDGET_EXHAUSTED', 409);
              }
              return lab.submit(body);
            };
          }
          const result = await replayOrSubmit(req, identity, base, body, operation);
          responseJson(res, 202, result);
          if (automaticProcessing) void pump();
          return;
        } finally { uploads--; }
      }
      if (req.method === 'GET' && url.pathname === '/v1/classification/jobs') {
        const sessionId = url.searchParams.get('sessionId');
        await activeSession(sessionId, identity);
        return responseJson(res, 200, { sessionId, jobs: await lab.list(sessionId) });
      }
      const match = url.pathname.match(/^\/v1\/(classification|asr)\/jobs\/([A-Za-z0-9._:-]+)(\/result|\/cancel)?$/);
      if (!match) throw failure('NOT_FOUND', 404);
      const [, kind, jobId, suffix] = match;
      const sessionId = url.searchParams.get('sessionId');
      await activeSession(sessionId, identity);
      const job = await (kind === 'asr' ? asr : lab).get(sessionId, jobId);
      if (!job) throw failure('JOB_NOT_FOUND', 404);
      if (req.method === 'POST' && suffix === '/cancel' && kind === 'classification') {
        if (!TERMINAL.has(job.status)) await cancelLabExecutionJob(jobId, { store: lab.store, clock });
        return responseJson(res, 200, { jobId, status: (await lab.get(sessionId, jobId)).status });
      }
      if (req.method !== 'GET' || suffix === '/cancel') throw failure('METHOD_NOT_ALLOWED', 405);
      if (suffix === '/result') {
        if (!TERMINAL.has(job.status)) throw failure('RESULT_NOT_READY', 409);
        if (job.redacted) throw failure('RESULT_NOT_AUTHORIZED', 403);
        return responseJson(res, 200, { apiVersion: API_VERSION, sessionId, jobId, status: job.status,
          ...(job.result ? { result: job.result } : {}), ...(job.metrics ? { metrics: job.metrics } : {}),
          ...(job.error ? { error: job.error } : {}), ...(job.errorCode ? { error: { code: job.errorCode } } : {}) });
      }
      return responseJson(res, 200, { apiVersion: API_VERSION, sessionId, jobId, status: job.status,
        createdAt: job.createdAt, updatedAt: job.updatedAt, ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        ...(job.error ? { error: job.error } : {}), ...(job.errorCode ? { error: { code: job.errorCode } } : {}) });
    } catch (error) {
      let code = error.code ?? (error.name === 'ZodError' ? 'REQUEST_INVALID' : error instanceof SyntaxError ? 'JSON_INVALID' : undefined);
      if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(code ?? '')) code = 'INTERNAL_ERROR';
      const status = error.status ?? (code.includes('SCOPE_MISMATCH') || code === 'AUTHORIZATION_CHANGED' ? 403
        : code.includes('SIZE_LIMIT') || code.includes('TOO_LARGE') ? 413
        : code === 'INTERNAL_ERROR' ? 500 : 400);
      logger.warn('api_request_rejected', { errorCode: code, status });
      if (!res.headersSent) responseJson(res, status, { ok: false, error: { code } });
      else res.destroy();
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 32;
  return { server, lab, asr, budget, control, runtime, asrRuntime, pump,
    async close() { closed = true; clearInterval(timer); await pumping; await new Promise(resolve => server.close(resolve)); },
  };
}
