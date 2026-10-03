#!/usr/bin/env node
import {
  createJsonLogger,
  LocalFeatureBundleProcessor,
  WorkerRuntime,
} from './worker-runtime.mjs';
import {
  HttpArtifactClient,
  HttpControlPlaneClient,
  LocalFeatureServiceClient,
  requireRuntimeEnvironment,
} from './http-clients.mjs';
import {
  StageAPipelineProcessor,
  SubprocessStageABridge,
} from './pipeline-processor.mjs';

function boolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`invalid boolean configuration`);
}

function integer(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('invalid integer configuration');
  return parsed;
}

const env = requireRuntimeEnvironment();
const logger = createJsonLogger();
const personMatchingEnabled = boolean(env.SGX_PERSON_MATCHING_ENABLED, false);
const processorMode = env.SGX_PROCESSOR_MODE ?? 'stage_a';
const vlmProvider = env.SGX_VLM_PROVIDER ?? 'qwen';
const vlmModel = env.SGX_VLM_MODEL ?? 'qwen3.7-flash-2026-07-15';
const promptVersion = env.SGX_PROMPT_VERSION ?? 'sgx-five-facets.16';
if (!['stage_a', 'feature_bundle_only'].includes(processorMode)) {
  throw new Error('invalid SGX_PROCESSOR_MODE');
}
if (processorMode === 'feature_bundle_only' && personMatchingEnabled) {
  throw new Error('SGX_PERSON_MATCHING_ENABLED requires stage_a authorization context');
}
if (integer(env.SGX_VLM_AUTO_RETRIES, 0) !== 0) {
  throw new Error('SGX_VLM_AUTO_RETRIES must remain 0');
}
const versions = {
  gitCommit: env.SGX_GIT_COMMIT,
  contractVersion: env.SGX_CONTRACT_VERSION ?? 'classification-ingestion.2',
  providerVersion: env.SGX_PROVIDER_VERSION
    ?? `${vlmProvider}:${vlmModel}:${promptVersion}:stage-a-validation.2`,
  promptVersion,
  guardVersion: env.SGX_GUARD_VERSION ?? 'classification-lab-guard.1',
  adapterVersion: env.SGX_ADAPTER_VERSION ?? 'classification-lab-stage-a-composition.1',
  taxonomyVersion: env.SGX_TAXONOMY_VERSION ?? 'sgx-taxonomy.1',
  ocrVersion: env.SGX_OCR_MODEL_REVISION ?? 'unconfigured',
  embeddingVersion: env.SGX_EMBEDDING_REVISION ?? 'unconfigured',
};
const capabilities = {
  modalities: ['image', 'user_text', 'final_asr'],
  features: [
    'hash',
    'ocr',
    'image_embedding',
    'text_embedding',
    ...(processorMode === 'stage_a' ? ['vlm_extract', 'vlm_relate', 'story_summary'] : []),
  ],
  maxImagesPerJob: integer(env.SGX_MAX_IMAGES_PER_JOB, 30),
  personMatchingEnabled,
};
const featureService = new LocalFeatureServiceClient({
  endpoint: env.SGX_FEATURE_ENDPOINT ?? 'http://127.0.0.1:8765',
});
const controlPlane = new HttpControlPlaneClient({
  baseUrl: env.SGX_CONTROL_PLANE_BASE_URL,
  token: env.SGX_CONTROL_PLANE_TOKEN,
});
const featureProcessor = new LocalFeatureBundleProcessor({
  featureService,
  personMatchingEnabled,
});
const processor = processorMode === 'feature_bundle_only'
  ? featureProcessor
  : new StageAPipelineProcessor({
    featureProcessor,
    contextProvider: controlPlane,
    historicalRetrieval: controlPlane,
    bridge: new SubprocessStageABridge({
      buildDir: env.SGX_CLASSIFICATION_BUILD_DIR,
    }),
  });
const runtime = new WorkerRuntime({
  workerId: env.SGX_WORKER_ID,
  versions,
  capabilities,
  controlPlane,
  artifacts: new HttpArtifactClient({}),
  processor,
  scratchRoot: env.SGX_JOB_TMP_ROOT ?? '/tmp/sgx-classification/jobs',
  maxJobs: integer(env.SGX_MAX_CONCURRENCY, 1),
  executionProfileDigest: env.SGX_EXECUTION_PROFILE_DIGEST,
  heartbeatIntervalMs: integer(env.SGX_HEARTBEAT_INTERVAL_MS, 10_000),
  pollIntervalMs: integer(env.SGX_POLL_INTERVAL_MS, 2_000),
  logger,
});

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => controller.abort());
}

await runtime.runForever({ signal: controller.signal });
