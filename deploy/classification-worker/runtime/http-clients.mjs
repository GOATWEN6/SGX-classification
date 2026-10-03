import path from 'node:path';

import { writeDownloadedFile, WorkerExecutionError } from './worker-runtime.mjs';

const PERSISTENT_DOWNLOAD_PATHS = [
  'SGX_MODEL_ROOT',
  'SGX_WHEELHOUSE_ROOT',
  'SGX_DOWNLOAD_ROOT',
  'SGX_MODEL_CACHE_ROOT',
  'HF_HOME',
  'HF_HUB_CACHE',
  'HUGGINGFACE_HUB_CACHE',
  'TRANSFORMERS_CACHE',
  'MODELSCOPE_CACHE',
  'SGX_ONNX_CACHE',
  'TORCH_HOME',
  'PIP_CACHE_DIR',
  'UV_CACHE_DIR',
  'XDG_CACHE_HOME',
  'VIRTUALENV_OVERRIDE_APP_DATA',
];

function isStrictlyBelow(candidate, root) {
  if (!path.isAbsolute(candidate) || !path.isAbsolute(root)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function protectedHttpUrl(value, label) {
  const parsed = new URL(value);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error(`${label} must use HTTPS outside localhost`);
  }
  return parsed;
}

async function parseJson(response, operation) {
  if (!response.ok) {
    const error = new Error(`${operation} returned HTTP ${response.status}`);
    error.code = 'CONTROL_PLANE_HTTP_ERROR';
    error.status = response.status;
    error.operation = operation;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

export class HttpControlPlaneClient {
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    const parsed = protectedHttpUrl(baseUrl, 'control plane');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async #post(path, body, operation, options = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options.signal,
      redirect: 'error',
    });
    return parseJson(response, operation);
  }

  lease(body, options) {
    return this.#post('/internal/v1/classification/leases', body, 'lease', options);
  }

  heartbeat(jobId, body, options) {
    return this.#post(`/internal/v1/classification/jobs/${encodeURIComponent(jobId)}/heartbeat`, body, 'heartbeat', options);
  }

  executionContext(jobId, body, options) {
    return this.#post(
      `/internal/v1/classification/jobs/${encodeURIComponent(jobId)}/execution-context`,
      body,
      'execution_context',
      options,
    );
  }

  historicalQuery(jobId, body, options) {
    return this.#post(
      `/internal/v1/classification/jobs/${encodeURIComponent(jobId)}/historical-query`,
      body,
      'historical_query',
      options,
    );
  }

  complete(jobId, body, options) {
    return this.#post(`/internal/v1/classification/jobs/${encodeURIComponent(jobId)}/complete`, body, 'complete', options);
  }

  fail(jobId, body, options) {
    return this.#post(`/internal/v1/classification/jobs/${encodeURIComponent(jobId)}/fail`, body, 'fail', options);
  }

  cancelAck(jobId, body, options) {
    return this.#post(`/internal/v1/classification/jobs/${encodeURIComponent(jobId)}/cancel-ack`, body, 'cancel_ack', options);
  }

  asrLease(body, options) {
    return this.#post('/internal/v1/classification/asr/leases', body, 'asr_lease', options);
  }

  asrHeartbeat(jobId, body, options) {
    return this.#post(
      `/internal/v1/classification/asr/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      body,
      'asr_heartbeat',
      options,
    );
  }

  asrComplete(jobId, body, options) {
    return this.#post(
      `/internal/v1/classification/asr/jobs/${encodeURIComponent(jobId)}/complete`,
      body,
      'asr_complete',
      options,
    );
  }

  asrFail(jobId, body, options) {
    return this.#post(
      `/internal/v1/classification/asr/jobs/${encodeURIComponent(jobId)}/fail`,
      body,
      'asr_fail',
      options,
    );
  }
}

export class HttpArtifactClient {
  constructor({ fetchImpl = fetch }) {
    this.fetchImpl = fetchImpl;
  }

  async downloadToFile({ url, destination, maxByteLength, signal }) {
    const protectedUrl = protectedHttpUrl(url, 'artifact download');
    const response = await this.fetchImpl(protectedUrl, {
      method: 'GET',
      signal,
      redirect: 'error',
    });
    if (!response.ok || !response.body) throw new Error(`download returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxByteLength) {
      throw new Error('download exceeds declared maximum');
    }
    return writeDownloadedFile(destination, response.body, maxByteLength);
  }

  async upload({ url, bytes, mimeType, signal }) {
    const protectedUrl = protectedHttpUrl(url, 'artifact upload');
    const response = await this.fetchImpl(protectedUrl, {
      method: 'PUT',
      headers: {
        'content-type': mimeType,
        'content-length': String(bytes.length),
      },
      body: bytes,
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`upload returned HTTP ${response.status}`);
  }
}

export class LocalFeatureServiceClient {
  constructor({ endpoint = 'http://127.0.0.1:8765', fetchImpl = fetch }) {
    const parsed = new URL(endpoint);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      throw new Error('feature service must be bound to localhost');
    }
    this.endpoint = parsed.toString().replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async #call(path, body, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
        redirect: 'error',
      });
    } catch (error) {
      const wrapped = new Error('feature service unavailable', { cause: error });
      wrapped.code = 'FEATURE_SERVICE_UNAVAILABLE';
      throw wrapped;
    }
    if (!response.ok) {
      let code = 'FEATURE_COMPONENT_FAILED';
      try {
        const payload = await response.json();
        if (typeof payload?.detail?.code === 'string') code = payload.detail.code;
        else if (typeof payload?.code === 'string') code = payload.code;
      } catch {
        // Stable fallback code; never include model exception text.
      }
      const error = new Error(code);
      error.code = code;
      throw error;
    }
    return response.json();
  }

  ocr(source, options) {
    return this.#call('/internal/v1/features/ocr', source, options);
  }

  imageEmbedding(source, options) {
    return this.#call('/internal/v1/features/image-embedding', source, options);
  }

  textEmbedding(source, options) {
    return this.#call('/internal/v1/features/text-embedding', source, options);
  }

  faceEmbeddings(source, options) {
    return this.#call('/internal/v1/features/face-embeddings', source, options);
  }

  asr(source, options) {
    return this.#call('/internal/v1/features/asr', source, options);
  }
}

export function requireRuntimeEnvironment(env = process.env) {
  const required = [
    'SGX_WORKER_ID',
    'SGX_CONTROL_PLANE_BASE_URL',
    'SGX_CONTROL_PLANE_TOKEN',
    'SGX_GIT_COMMIT',
    'SGX_EXECUTION_PROFILE_DIGEST',
    'SGX_DEPLOY_ROOT',
    'SGX_RUNTIME_ROOT',
    'SGX_RUNTIME_CACHE_ROOT',
    'SGX_COMPILED_CACHE_ROOT',
    ...PERSISTENT_DOWNLOAD_PATHS,
  ];
  for (const name of required) {
    if (!env[name]) throw new WorkerExecutionError('VERSION_MISMATCH', 'lease', `missing ${name}`);
  }
  if (env.SGX_PERSISTENCE_POLICY_VERSION !== 'classification-download-persistence.1') {
    throw new WorkerExecutionError('VERSION_MISMATCH', 'lease', 'invalid persistence policy');
  }
  for (const name of PERSISTENT_DOWNLOAD_PATHS) {
    if (!isStrictlyBelow(env[name], env.SGX_DEPLOY_ROOT)) {
      throw new WorkerExecutionError('VERSION_MISMATCH', 'lease', `${name} must stay below SGX_DEPLOY_ROOT`);
    }
  }
  for (const name of ['SGX_RUNTIME_CACHE_ROOT', 'SGX_COMPILED_CACHE_ROOT']) {
    if (!isStrictlyBelow(env[name], env.SGX_RUNTIME_ROOT)) {
      throw new WorkerExecutionError('VERSION_MISMATCH', 'lease', `${name} must stay below SGX_RUNTIME_ROOT`);
    }
  }
  if (env.HF_HUB_OFFLINE !== '1' || env.TRANSFORMERS_OFFLINE !== '1' || env.SGX_ALLOW_MODEL_DOWNLOADS !== 'false') {
    throw new WorkerExecutionError('VERSION_MISMATCH', 'lease', 'runtime model transport must remain offline');
  }
  return env;
}
