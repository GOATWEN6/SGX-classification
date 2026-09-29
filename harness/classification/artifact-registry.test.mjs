import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ArtifactRegistryError,
  createArtifactRegistry,
  preflightArtifactRegistry,
  registryHash,
} from './artifact-registry.mjs';

const createdAt = '2026-09-29T08:00:00.000Z';
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const require = createRequire(import.meta.url);
const Ajv = require('ajv');

function expectCode(code) {
  return error => error instanceof ArtifactRegistryError && error.code === code;
}

async function fixture(t) {
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'sgx-artifact-registry-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  await mkdir(path.join(outputRoot, 'inputs'), { recursive: true });
  await mkdir(path.join(outputRoot, 'results'), { recursive: true });
  const manifestBytes = Buffer.from('{"datasetId":"dataset_fixture"}\n');
  const truthBytes = Buffer.from('{"version":"fixture-truth.1"}\n');
  const scoringPolicyBytes = Buffer.from('{"version":"fixture-scoring.1"}\n');
  const checksumBytes = Buffer.from('fixture-checksum-manifest\n');
  const secretCanary = 'PRIVATE_PAYLOAD_CANARY_MUST_NOT_ENTER_REGISTRY';
  const responseBytes = Buffer.from(`{"privatePayload":"${secretCanary}"}\n`);
  await writeFile(path.join(outputRoot, 'inputs/manifest.json'), manifestBytes);
  await writeFile(path.join(outputRoot, 'inputs/truth.json'), truthBytes);
  await writeFile(path.join(outputRoot, 'inputs/scoring-policy.json'), scoringPolicyBytes);
  await writeFile(path.join(outputRoot, 'inputs/checksums.txt'), checksumBytes);
  await writeFile(path.join(outputRoot, 'results/provider-response.json'), responseBytes);

  const input = {
    version: 'sgx-artifact-registry.1',
    registryId: 'registry_fixture_1',
    revision: 1,
    claimBoundary: 'synthetic_fixture',
    outputRoot,
    createdAt,
    identity: {
      pipeline: 'classification_stage_a',
      datasetId: 'dataset_fixture',
      batchId: 'batch_fixture',
      runId: 'run_fixture',
      provider: 'fixture_provider',
      model: 'fixture_model',
      promptVersion: 'fixture_prompt.1',
      guardVersion: 'sgx-five-facets.12',
      taxonomyVersion: 'fixture_taxonomy.1',
      truthVersion: 'sgx-truth.2',
      scoringPolicyVersion: 'sgx-scoring-policy.2',
    },
    authorization: {
      approvalHash: sha('approval fixture'),
      evidenceRefHash: sha('authorization evidence reference summary'),
      expiresAt: '2026-09-30T08:00:00.000Z',
      caps: {
        maxRequests: 10,
        maxInputTokens: 1000000,
        maxOutputTokens: 50000,
        maxCostCny: 30,
        maxDurationSeconds: 3600,
        maxRetries: 0,
      },
    },
    sourceRegistryRefs: [],
    artifacts: [
      {
        artifactId: 'dataset_manifest',
        kind: 'dataset_manifest',
        relativePath: 'inputs/manifest.json',
        sensitivity: 'metadata_only',
        provenanceArtifactIds: [],
        createdAt,
      },
      {
        artifactId: 'provider_response_1',
        kind: 'provider_response',
        relativePath: 'results/provider-response.json',
        sensitivity: 'restricted',
        provenanceArtifactIds: ['dataset_manifest'],
        createdAt,
      },
      {
        artifactId: 'truth',
        kind: 'truth',
        relativePath: 'inputs/truth.json',
        sensitivity: 'metadata_only',
        provenanceArtifactIds: ['dataset_manifest'],
        createdAt,
      },
      {
        artifactId: 'scoring_policy',
        kind: 'scoring_policy',
        relativePath: 'inputs/scoring-policy.json',
        sensitivity: 'metadata_only',
        provenanceArtifactIds: [],
        createdAt,
      },
      {
        artifactId: 'checksum_manifest',
        kind: 'checksum_manifest',
        relativePath: 'inputs/checksums.txt',
        sensitivity: 'metadata_only',
        provenanceArtifactIds: ['dataset_manifest', 'truth'],
        createdAt,
      },
    ],
  };
  return {
    input,
    manifestBytes,
    outputRoot,
    responseBytes,
    scoringPolicyBytes,
    secretCanary,
    truthBytes,
    checksumBytes,
  };
}

const requiredKindsByLane = {
  synthetic_fixture: ['dataset_manifest', 'truth', 'scoring_policy', 'checksum_manifest'],
  real_model_on_synthetic: [
    'dataset_manifest', 'truth', 'scoring_policy', 'preflight', 'approval_reference',
    'provider_response', 'request_ledger', 'metrics', 'report',
  ],
  real_user_authorized: [
    'dataset_manifest', 'truth', 'scoring_policy', 'preflight', 'approval_reference',
    'provider_response', 'request_ledger', 'metrics', 'report',
  ],
  mock_transport: ['dataset_manifest', 'truth', 'scoring_policy', 'request_ledger', 'metrics', 'report'],
  offline_replay: [
    'truth', 'scoring_policy', 'source_response_reference', 'replay_result',
    'request_ledger', 'metrics', 'report',
  ],
  summary_only_missing: ['missing_evidence_ledger', 'report'],
};

async function prepareLane(f, lane) {
  f.input.claimBoundary = lane;
  if(lane === 'offline_replay') {
    f.input.authorization = null;
    f.input.sourceRegistryRefs = [{
      registryId: 'registry_parent_1',
      registryHash: sha('parent registry bytes'),
      artifactIds: ['provider_response_1'],
    }];
  }
  if(lane === 'summary_only_missing') f.input.authorization = null;
  for(const kind of requiredKindsByLane[lane]) {
    if(f.input.artifacts.some(artifact => artifact.kind === kind)) continue;
    const relativePath = `results/${kind}.json`;
    await writeFile(path.join(f.outputRoot, relativePath), `${JSON.stringify({ kind })}\n`);
    f.input.artifacts.push({
      artifactId: kind,
      kind,
      relativePath,
      sensitivity: 'metadata_only',
      provenanceArtifactIds: [],
      createdAt,
    });
  }
  if(lane === 'real_user_authorized') {
    for(const artifact of f.input.artifacts) {
      if(!['scoring_policy', 'checksum_manifest', 'provider_response'].includes(artifact.kind)) {
        artifact.sensitivity = 'private';
      }
    }
  }
}

test('creates and verifies a private metadata-only registry without copying payload content', async t => {
  const f = await fixture(t);
  const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
  assert.equal(created.registryPath, path.join(f.outputRoot, 'artifact-registry.json'));
  assert.match(created.registryHash, /^sha256:[a-f0-9]{64}$/);
  const manifest = created.registry.artifacts.find(artifact => artifact.artifactId === 'dataset_manifest');
  const response = created.registry.artifacts.find(artifact => artifact.artifactId === 'provider_response_1');
  assert.equal(manifest.sha256, sha(f.manifestBytes));
  assert.equal(response.sha256, sha(f.responseBytes));
  assert.equal(response.byteLength, f.responseBytes.length);

  const registryBytes = await readFile(created.registryPath);
  assert.equal(registryHash(registryBytes), created.registryHash);
  assert.equal(registryBytes.includes(f.secretCanary), false);
  const checked = await preflightArtifactRegistry(created.registryPath, {
    allowEphemeralForTest: true,
    expectedRegistryHash: created.registryHash,
  });
  assert.equal(checked.ready, true);
  assert.equal(checked.summary.artifacts, 5);
  assert.equal(
    checked.summary.totalBytes,
    f.manifestBytes.length + f.responseBytes.length + f.truthBytes.length
      + f.scoringPolicyBytes.length + f.checksumBytes.length,
  );
  assert.equal(checked.credentialsRead, false);
  assert.equal(checked.externalCalls, 0);
});

test('detects artifact length and same-length content tampering', async t => {
  const f = await fixture(t);
  const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
  const filename = path.join(f.outputRoot, 'inputs/manifest.json');
  await writeFile(filename, Buffer.concat([f.manifestBytes, Buffer.from('tampered')]));
  await assert.rejects(
    preflightArtifactRegistry(created.registryPath, { allowEphemeralForTest: true }),
    expectCode('ARTIFACT_LENGTH_MISMATCH'),
  );

  await writeFile(filename, Buffer.alloc(f.manifestBytes.length, 0x78));
  await assert.rejects(
    preflightArtifactRegistry(created.registryPath, { allowEphemeralForTest: true }),
    expectCode('ARTIFACT_HASH_MISMATCH'),
  );
});

test('registers a legitimate empty ledger without inventing content', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.outputRoot, 'results/empty-errors.jsonl'), '');
  f.input.artifacts.push({
    artifactId: 'empty_error_ledger',
    kind: 'error_ledger',
    relativePath: 'results/empty-errors.jsonl',
    sensitivity: 'metadata_only',
    provenanceArtifactIds: ['dataset_manifest'],
    createdAt,
  });
  const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
  const empty = created.registry.artifacts.find(artifact => artifact.artifactId === 'empty_error_ledger');
  assert.equal(empty.byteLength, 0);
  assert.equal(empty.sha256, sha(''));
});

test('only response or error streams may be empty; required evidence documents may not', async t => {
  await t.test('empty provider response records a zero-request run', async t => {
    const f = await fixture(t);
    await prepareLane(f, 'real_model_on_synthetic');
    await writeFile(path.join(f.outputRoot, 'results/provider-response.json'), '');
    const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
    const response = created.registry.artifacts.find(artifact => artifact.kind === 'provider_response');
    assert.equal(response.byteLength, 0);
    assert.equal(response.sha256, sha(''));
  });

  await t.test('empty truth is invalid', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.outputRoot, 'inputs/truth.json'), '');
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('INVALID_ARTIFACT_REGISTRY'),
    );
  });
});

test('rejects absolute and escaping artifact paths', async t => {
  const f = await fixture(t);
  f.input.artifacts[0].relativePath = path.join(f.outputRoot, 'inputs/manifest.json');
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('ABSOLUTE_ARTIFACT_PATH_REQUIRED'),
  );

  f.input.artifacts[0].relativePath = '../outside.json';
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('ARTIFACT_PATH_ESCAPE'),
  );
});

test('rejects symlinked and hard-linked artifacts', async t => {
  await t.test('symlink', async t => {
    const f = await fixture(t);
    await symlink('manifest.json', path.join(f.outputRoot, 'inputs/manifest-link.json'));
    f.input.artifacts[0].relativePath = 'inputs/manifest-link.json';
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('ARTIFACT_SYMLINK_ESCAPE'),
    );
  });

  await t.test('hard link', async t => {
    const f = await fixture(t);
    await link(
      path.join(f.outputRoot, 'inputs/manifest.json'),
      path.join(f.outputRoot, 'inputs/manifest-hardlink.json'),
    );
    f.input.artifacts[0].relativePath = 'inputs/manifest-hardlink.json';
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('ARTIFACT_HARDLINK_REJECTED'),
    );
  });
});

test('strict schema and writer reject sensitive or unrecognized fields', async t => {
  const f = await fixture(t);
  f.input.apiKey = 'not-a-real-key';
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('INVALID_ARTIFACT_REGISTRY'),
  );

  delete f.input.apiKey;
  const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
  const registry = JSON.parse(await readFile(created.registryPath, 'utf8'));
  registry.artifacts[0].rawText = 'private text must not be accepted';
  await writeFile(created.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  await assert.rejects(
    preflightArtifactRegistry(created.registryPath, { allowEphemeralForTest: true }),
    expectCode('INVALID_ARTIFACT_REGISTRY'),
  );
});

test('sensitivity floors prevent raw responses and real-user evidence from being mislabeled', async t => {
  await t.test('writer rejects metadata-only provider response', async t => {
    const f = await fixture(t);
    f.input.artifacts.find(artifact => artifact.kind === 'provider_response').sensitivity = 'metadata_only';
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('PROVIDER_RESPONSE_MUST_BE_RESTRICTED'),
    );
  });

  await t.test('writer rejects metadata-only real-user truth', async t => {
    const f = await fixture(t);
    await prepareLane(f, 'real_user_authorized');
    f.input.artifacts.find(artifact => artifact.kind === 'truth').sensitivity = 'metadata_only';
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('REAL_USER_ARTIFACT_MUST_BE_PRIVATE'),
    );
  });

  await t.test('verifier rejects an externally downgraded provider response', async t => {
    const f = await fixture(t);
    const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
    const registry = JSON.parse(await readFile(created.registryPath, 'utf8'));
    registry.artifacts.find(artifact => artifact.kind === 'provider_response').sensitivity = 'metadata_only';
    await writeFile(created.registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(
      preflightArtifactRegistry(created.registryPath, { allowEphemeralForTest: true }),
      expectCode('INVALID_ARTIFACT_REGISTRY'),
    );
  });
});

test('rejects duplicate artifact IDs and paths', async t => {
  const f = await fixture(t);
  f.input.artifacts.push({ ...structuredClone(f.input.artifacts[0]), relativePath: 'results/provider-response.json' });
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('DUPLICATE_ARTIFACT_ID'),
  );

  f.input.artifacts.pop();
  f.input.artifacts.push({ ...structuredClone(f.input.artifacts[0]), artifactId: 'manifest_alias' });
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('DUPLICATE_ARTIFACT_PATH'),
  );
});

test('rejects dangling and cyclic provenance references', async t => {
  const f = await fixture(t);
  f.input.artifacts[1].provenanceArtifactIds = ['missing_artifact'];
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('INVALID_PROVENANCE_REF'),
  );

  f.input.artifacts[1].provenanceArtifactIds = ['dataset_manifest'];
  f.input.artifacts[0].provenanceArtifactIds = ['provider_response_1'];
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('CYCLIC_PROVENANCE'),
  );
});

test('expected registry hash detects metadata drift before accepting the run', async t => {
  const f = await fixture(t);
  const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
  const registryBytes = await readFile(created.registryPath);
  await writeFile(created.registryPath, Buffer.concat([registryBytes, Buffer.from('\n')]));
  await assert.rejects(
    preflightArtifactRegistry(created.registryPath, {
      allowEphemeralForTest: true,
      expectedRegistryHash: created.registryHash,
    }),
    expectCode('REGISTRY_HASH_MISMATCH'),
  );
});

test('persistent output roots are required unless a test explicitly allows an ephemeral root', async t => {
  const f = await fixture(t);
  await assert.rejects(createArtifactRegistry(f.input), expectCode('EPHEMERAL_OUTPUT_ROOT'));
});

test('all conventional temporary roots are rejected by the formal writer', async t => {
  const conventionalRoot = '/private/var/tmp';
  try {
    await lstat(conventionalRoot);
  } catch {
    t.skip(`${conventionalRoot} is unavailable on this platform`);
    return;
  }
  const f = await fixture(t);
  f.input.outputRoot = conventionalRoot;
  await assert.rejects(createArtifactRegistry(f.input), expectCode('EPHEMERAL_OUTPUT_ROOT'));
});

test('rejects output roots inside the current or any foreign Git checkout', async t => {
  await t.test('current worktree', async t => {
    const f = await fixture(t);
    f.input.outputRoot = process.cwd();
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('OUTPUT_ROOT_INSIDE_GIT'),
    );
  });

  for(const markerType of ['directory', 'file']) {
    await t.test(`foreign Git ${markerType} marker`, async t => {
      const f = await fixture(t);
      const checkout = path.join(f.outputRoot, `foreign-${markerType}`);
      const runRoot = path.join(checkout, 'private-run');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      if(markerType === 'directory') await mkdir(path.join(checkout, '.git'), { mode: 0o700 });
      else await writeFile(path.join(checkout, '.git'), 'gitdir: /private/nonexistent\n', { mode: 0o600 });
      f.input.outputRoot = runRoot;
      await assert.rejects(
        createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
        expectCode('OUTPUT_ROOT_INSIDE_GIT'),
      );
    });
  }
});

test('rejects unregistered files added before or after finalization', async t => {
  await t.test('before finalization', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.outputRoot, 'unregistered.txt'), 'unexpected');
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('UNREGISTERED_ARTIFACT'),
    );
  });

  await t.test('after finalization', async t => {
    const f = await fixture(t);
    const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
    await writeFile(path.join(f.outputRoot, 'unregistered.txt'), 'unexpected');
    await assert.rejects(
      preflightArtifactRegistry(created.registryPath, { allowEphemeralForTest: true }),
      expectCode('UNREGISTERED_ARTIFACT'),
    );
  });
});

test('rejects control characters in artifact paths', async t => {
  const f = await fixture(t);
  f.input.artifacts[0].relativePath = 'inputs/manifest\n.json';
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('INVALID_ARTIFACT_PATH'),
  );
});

test('standalone schema rejects every relative path shape rejected by the writer', async t => {
  const schema = JSON.parse(await readFile(
    new URL('../../contracts/classification-artifact-registry-v1.schema.json', import.meta.url),
    'utf8',
  ));
  const validate = new Ajv({ allErrors: true, format: 'full', strictKeywords: true }).compile(schema);
  const f = await fixture(t);
  const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
  assert.equal(validate(created.registry), true);

  for(const relativePath of ['../escape.json', './local.json', 'a/./b.json', 'a//b.json', 'a\\b.json', 'a\nb.json']) {
    const candidate = structuredClone(created.registry);
    candidate.artifacts[0].relativePath = relativePath;
    assert.equal(validate(candidate), false, relativePath);
  }

  const real = await fixture(t);
  await prepareLane(real, 'real_model_on_synthetic');
  const realRegistry = (await createArtifactRegistry(real.input, { allowEphemeralForTest: true })).registry;
  for(const kind of requiredKindsByLane.real_model_on_synthetic) {
    const candidate = structuredClone(realRegistry);
    candidate.artifacts = candidate.artifacts.filter(artifact => artifact.kind !== kind);
    assert.equal(validate(candidate), false, `missing ${kind}`);
  }
});

test('real model lanes require model identity and authorization; replay requires a source registry anchor', async t => {
  await t.test('missing real-model authorization', async t => {
    const f = await fixture(t);
    await prepareLane(f, 'real_model_on_synthetic');
    f.input.authorization = null;
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('INVALID_ARTIFACT_REGISTRY'),
    );
  });

  await t.test('missing real-model identity', async t => {
    const f = await fixture(t);
    await prepareLane(f, 'real_user_authorized');
    f.input.identity.model = null;
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('INVALID_ARTIFACT_REGISTRY'),
    );
  });

  await t.test('unanchored replay', async t => {
    const f = await fixture(t);
    await prepareLane(f, 'offline_replay');
    f.input.sourceRegistryRefs = [];
    await assert.rejects(
      createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
      expectCode('INVALID_ARTIFACT_REGISTRY'),
    );
  });

  await t.test('anchored replay', async t => {
    const f = await fixture(t);
    await prepareLane(f, 'offline_replay');
    const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
    assert.deepEqual(created.registry.sourceRegistryRefs, f.input.sourceRegistryRefs);
  });
});

test('every evidence lane rejects omission of each required artifact role', async t => {
  for(const [lane, requiredKinds] of Object.entries(requiredKindsByLane)) {
    await t.test(lane, async t => {
      for(const kind of requiredKinds) {
        await t.test(`missing ${kind}`, async t => {
          const f = await fixture(t);
          await prepareLane(f, lane);
          const removed = f.input.artifacts.find(artifact => artifact.kind === kind);
          f.input.artifacts = f.input.artifacts.filter(artifact => artifact.kind !== kind);
          await rm(path.join(f.outputRoot, removed.relativePath));
          await assert.rejects(
            createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
            expectCode(`MISSING_REQUIRED_ARTIFACT_KIND_${kind.toUpperCase()}`),
          );
        });
      }
    });
  }
});

test('source registry anchors cannot be self-referential or duplicated', async t => {
  const f = await fixture(t);
  const ref = {
    registryId: f.input.registryId,
    registryHash: sha('self registry'),
    artifactIds: ['provider_response_1'],
  };
  f.input.sourceRegistryRefs = [ref];
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('SOURCE_REGISTRY_SELF_REFERENCE'),
  );

  ref.registryId = 'registry_parent_1';
  f.input.sourceRegistryRefs = [structuredClone(ref), structuredClone(ref)];
  await assert.rejects(
    createArtifactRegistry(f.input, { allowEphemeralForTest: true }),
    expectCode('DUPLICATE_SOURCE_REGISTRY'),
  );
});

test('verifier rejects an externally written self-referential source registry anchor', async t => {
  const f = await fixture(t);
  const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
  const registry = JSON.parse(await readFile(created.registryPath, 'utf8'));
  registry.sourceRegistryRefs = [{
    registryId: registry.registryId,
    registryHash: sha('externally written source registry'),
    artifactIds: ['provider_response_1'],
  }];
  await writeFile(created.registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    preflightArtifactRegistry(created.registryPath, { allowEphemeralForTest: true }),
    expectCode('SOURCE_REGISTRY_SELF_REFERENCE'),
  );
});

test('verifier rejects a registry file whose owner-only permissions drift', async t => {
  const f = await fixture(t);
  const created = await createArtifactRegistry(f.input, { allowEphemeralForTest: true });
  await chmod(created.registryPath, 0o644);
  await assert.rejects(
    preflightArtifactRegistry(created.registryPath, { allowEphemeralForTest: true }),
    expectCode('REGISTRY_PERMISSIONS'),
  );
});

test('legacy temporary artifacts stay summary-only and cannot be mistaken for replayable evidence', async () => {
  const ledger = JSON.parse(await readFile(
    new URL('../../docs/algorithms/evidence/CLASSIFICATION_LEGACY_ARTIFACT_AVAILABILITY_2026-09-29.json', import.meta.url),
    'utf8',
  ));

  assert.equal(ledger.schemaVersion, 'sgx-legacy-artifact-availability.1');
  assert.equal(ledger.entries.length, 4);
  assert.equal(new Set(ledger.entries.map(entry => entry.legacyEvidenceId)).size, 4);
  for(const entry of ledger.entries) {
    assert.equal(entry.availability, 'summary_only');
    assert.equal(entry.knownDigest, null);
    assert.equal(entry.recoveryStatus, 'not_found');
    assert.equal(entry.recoveryPolicy, 'do_not_reconstruct');
    assert.match(entry.lastKnownPath, /^\/private\/tmp\//);
    assert.ok(entry.expectedArtifacts.length > 0);
  }
});
