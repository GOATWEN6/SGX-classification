import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const contractUrl = new URL('../../contracts/', import.meta.url);

async function validator(definition) {
  const ajv = new Ajv({ allErrors: true, strictKeywords: true });
  const files = (await readdir(contractUrl)).filter((file) => file.endsWith('.schema.json'));
  const schemas = await Promise.all(files.map(async (file) => JSON.parse(await readFile(new URL(file, contractUrl), 'utf8'))));
  schemas.forEach((schema) => ajv.addSchema(schema));
  const validate = ajv.getSchema(`urn:sgx:classification-worker-control-plane:v1#/definitions/${definition}`);
  assert.equal(typeof validate, 'function');
  return validate;
}

const sha = (character) => `sha256:${character.repeat(64)}`;

const versions = {
  gitCommit: '8654a83',
  contractVersion: 'classification-ingestion-v2.0.0',
  providerVersion: 'stage-a-provider.1',
  promptVersion: 'sgx-five-facets.15',
  guardVersion: 'stage-a-guard.1',
  adapterVersion: 'cloud-worker.1',
  taxonomyVersion: 'sgx-taxonomy.1',
  ocrVersion: 'rapidocr-ppocrv5.shadow',
  embeddingVersion: 'siglip2-base.shadow',
};

const identity = {
  workerId: 'virtai-worker-1',
  jobId: 'job-1',
  runId: 'run-1',
  leaseToken: 'l'.repeat(32),
  jobRevision: 2,
  attemptRevision: 1,
  authorizationRevision: 'auth-3',
  inputHash: sha('a'),
  executionProfileDigest: sha('b'),
};

const executionContextBinding = {
  jobId: identity.jobId,
  runId: identity.runId,
  jobRevision: identity.jobRevision,
  attemptRevision: identity.attemptRevision,
  scope: { householdId: 'household-1', subjectId: 'subject-1' },
  authorizationRevision: identity.authorizationRevision,
  inputHash: identity.inputHash,
  executionProfileDigest: identity.executionProfileDigest,
};

test('worker lease request and response carry frozen capability and evidence identity', async () => {
  const [validateRequest, validateResponse] = await Promise.all([
    validator('LeaseRequest'),
    validator('LeaseResponse'),
  ]);
  const request = {
    protocolVersion: 'classification-worker-control-plane.v1',
    requestId: 'request-lease-1',
    workerId: 'virtai-worker-1',
    maxJobs: 2,
    versions,
    capabilities: {
      modalities: ['image', 'user_text', 'final_asr'],
      features: ['hash', 'phash', 'ocr', 'image_embedding', 'text_embedding', 'vlm_extract', 'vlm_relate', 'story_summary'],
      maxImagesPerJob: 30,
      personMatchingEnabled: false,
    },
  };
  assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));

  const response = {
    protocolVersion: 'classification-worker-control-plane.v1',
    requestId: 'request-lease-1',
    leases: [{
      jobId: identity.jobId,
      runId: identity.runId,
      leaseToken: identity.leaseToken,
      leaseExpiresAt: '2026-10-02T10:05:00.000Z',
      jobRevision: identity.jobRevision,
      attemptRevision: identity.attemptRevision,
      scope: { householdId: 'household-1', subjectId: 'subject-1' },
      authorizationRevision: identity.authorizationRevision,
      deadlineAt: '2026-10-02T10:10:00.000Z',
      inputHash: identity.inputHash,
      executionProfileDigest: identity.executionProfileDigest,
      evidence: [
        {
          evidenceId: 'evidence-image-1', contentId: 'content-1', modality: 'image', revision: 1,
          sourceHash: sha('c'), lifecycleState: 'active', bindingId: 'binding-1',
          artifact: {
            artifactId: 'artifact-image-1', downloadUrl: 'https://objects.example.test/read/1',
            expiresAt: '2026-10-02T10:04:00.000Z', sha256: sha('c'), byteLength: 2048, mimeType: 'image/jpeg',
          },
        },
        {
          evidenceId: 'evidence-text-1', contentId: 'content-1', modality: 'user_text', revision: 1,
          sourceHash: sha('d'), lifecycleState: 'active', bindingId: 'binding-1',
          inlineText: { text: '这是同一趟旅行的第二天。', sha256: sha('d') },
        },
      ],
      resultUpload: {
        artifactId: 'artifact-result-1', uploadUrl: 'https://objects.example.test/write/1',
        expiresAt: '2026-10-02T10:09:00.000Z', maxByteLength: 1048576, mimeType: 'application/json',
      },
    }],
  };
  assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));
});

test('worker completion binds result artifact, versions, usage and immutable run identity', async () => {
  const validate = await validator('CompleteRequest');
  const complete = {
    protocolVersion: 'classification-worker-control-plane.v1',
    requestId: 'request-complete-1',
    identity,
    status: 'needs_review',
    versions,
    resultArtifact: {
      artifactId: 'artifact-result-1', sha256: sha('e'), byteLength: 4096, mimeType: 'application/json',
    },
    usage: {
      endToEndLatencyMs: 12000, providerLatencyMs: 8000, inputTokens: 2400,
      outputTokens: 800, costCny: 0.03, providerCalls: 2,
    },
  };
  assert.equal(validate(complete), true, JSON.stringify(validate.errors));

  const stale = { ...complete, extra: true };
  assert.equal(validate(stale), false);
});

test('execution context is a frozen lease-bound request and response', async () => {
  const [validateRequest, validateResponse] = await Promise.all([
    validator('ExecutionContextRequest'),
    validator('ExecutionContextResponse'),
  ]);
  const request = {
    protocolVersion: 'classification-worker-control-plane.v1',
    requestId: 'request-context-1',
    identity,
  };
  assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));

  const response = {
    protocolVersion: 'classification-worker-control-plane.v1',
    requestId: request.requestId,
    contextVersion: 'classification-worker-stage-a-context.1',
    binding: executionContextBinding,
    execution: {
      job: { version: 'classification-lab-job.2' },
      guard: { version: 'classification-lab-guard.1' },
      placeKindPolicy: { policyVersion: 'classification-place-kind.1' },
    },
  };
  assert.equal(validateResponse(response), true, JSON.stringify(validateResponse.errors));

  assert.equal(validateResponse({
    ...response,
    binding: { ...response.binding, authorizationRevision: 'stale-auth' },
  }), true, 'schema validates shape; runtime binding comparison rejects stale values');
  assert.equal(validateResponse({
    ...response,
    execution: { ...response.execution, apiKey: 'forbidden' },
  }), false, 'execution envelope remains closed to credential fields');
});

test('worker failure and cancel acknowledgement preserve cost and cleanup evidence', async () => {
  const [validateFailure, validateCancel] = await Promise.all([
    validator('FailRequest'),
    validator('CancelAckRequest'),
  ]);
  const usage = {
    endToEndLatencyMs: 9000, providerLatencyMs: 7000, inputTokens: 1800,
    outputTokens: 0, costCny: 0.02, providerCalls: 1,
  };
  assert.equal(validateFailure({
    protocolVersion: 'classification-worker-control-plane.v1',
    requestId: 'request-fail-1',
    identity,
    errorCode: 'PROVIDER_TIMEOUT',
    stage: 'vlm_extract',
    retryable: false,
    providerCalled: true,
    usage,
  }), true, JSON.stringify(validateFailure.errors));
  assert.equal(validateCancel({
    protocolVersion: 'classification-worker-control-plane.v1',
    requestId: 'request-cancel-1',
    identity,
    reason: 'authorization_changed',
    temporaryFilesDeleted: true,
  }), true, JSON.stringify(validateCancel.errors));
});

test('worker protocol rejects malformed hashes, missing versions and wrong evidence transport', async () => {
  const [validateRequest, validateEvidence] = await Promise.all([
    validator('LeaseRequest'),
    validator('EvidenceLease'),
  ]);
  const badRequest = {
    protocolVersion: 'classification-worker-control-plane.v1',
    requestId: 'request-1',
    workerId: 'worker-1',
    maxJobs: 1,
    versions: { ...versions, embeddingVersion: undefined },
    capabilities: { modalities: ['image'], features: ['ocr'], maxImagesPerJob: 5, personMatchingEnabled: false },
  };
  assert.equal(validateRequest(badRequest), false);

  const imageWithInlineText = {
    evidenceId: 'evidence-1', contentId: 'content-1', modality: 'image', revision: 1,
    sourceHash: 'not-a-hash', lifecycleState: 'active',
    inlineText: { text: 'wrong transport', sha256: sha('f') },
  };
  assert.equal(validateEvidence(imageWithInlineText), false);
});
