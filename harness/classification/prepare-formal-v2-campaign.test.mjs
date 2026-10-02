import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CAMPAIGN_CAPS,
  EXPECTED_DATASET_DIGEST,
  FORMAL_SUBMISSIONS,
  PERSON_TRUTH_PHOTO_IDS,
  RELATION_ALLOWLIST,
  assertAcceptedDatasetMetadata,
  prepareFormalV2Campaign,
} from './prepare-formal-v2-campaign.mjs';

const DATASET = process.env.SGX_FORMAL_V2_DATASET
  ?? '/Users/wenqingzhong/Documents/Codex/2026-09-27/sgx-synthetic-multimodal-v2/outputs/sgx-synthetic-multimodal-testset-v2-spec-2.0.0-r1';
const ACCEPTANCE = process.env.SGX_FORMAL_V2_ACCEPTANCE
  ?? '/Users/wenqingzhong/Documents/Codex/2026-09-27/sgx-synthetic-v2-acceptance/outputs/ACCEPTED.json';
const hasAcceptedDataset = existsSync(path.join(DATASET, 'READY_FOR_ACCEPTANCE.json')) && existsSync(ACCEPTANCE);
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const TEST_SOURCE_REVISION = Object.freeze({
  version: 'sgx-formal-source-revision.1',
  gitCommit: 'a'.repeat(40),
  trackedTreeClean: true,
  generatorVersion: 'sgx-formal-v2-generator.1',
});

test('formal matrix freezes exact submissions and explicit unique relation allowlist', () => {
  assert.equal(FORMAL_SUBMISSIONS.length, 20);
  assert.deepEqual(FORMAL_SUBMISSIONS.map(item => item.submissionId), [
    'E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12',
    'V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08',
  ]);
  assert.equal(FORMAL_SUBMISSIONS.filter(item => item.phase === 'exploration').length, 12);
  assert.equal(FORMAL_SUBMISSIONS.filter(item => item.phase === 'validation').length, 8);
  assert.equal(FORMAL_SUBMISSIONS.filter(item => item.context === 'album_upload').length, 14);
  assert.equal(FORMAL_SUBMISSIONS.filter(item => item.context === 'family_transfer').length, 6);
  assert.deepEqual(FORMAL_SUBMISSIONS.find(item => item.submissionId === 'E01').bundleIds,
    ['SGX-V2-E004', 'SGX-V2-E009', 'SGX-V2-E013', 'SGX-V2-E014', 'SGX-V2-E015']);
  assert.deepEqual(FORMAL_SUBMISSIONS.find(item => item.submissionId === 'V01').bundleIds,
    ['SGX-SYN-H003', 'SGX-SYN-H001', 'SGX-V2-H008', 'SGX-V2-H009', 'SGX-V2-H010']);
  assert.deepEqual(FORMAL_SUBMISSIONS.slice(8, 12).flatMap(item => item.bundleIds),
    ['SGX-V2-T001', 'SGX-V2-T003', 'SGX-V2-A002', 'SGX-V2-A003']);

  assert.equal(RELATION_ALLOWLIST.length, 21);
  assert.deepEqual(
    Object.fromEntries(['same', 'different', 'unknown'].map(value => [value, RELATION_ALLOWLIST.filter(item => item.truth === value).length])),
    { same: 7, different: 11, unknown: 3 },
  );
  const pairKeys = RELATION_ALLOWLIST.map(item => [item.leftBundleId, item.rightBundleId].sort().join('|'));
  assert.equal(new Set(pairKeys).size, 21);
  assert.equal(RELATION_ALLOWLIST.filter(item => item.phase === 'exploration').length, 13);
  assert.equal(RELATION_ALLOWLIST.filter(item => item.phase === 'validation').length, 8);
  assert.deepEqual(CAMPAIGN_CAPS, { maxRequests: 150, maxCostCny: 25, maxRetries: 0 });
});

test('accepted dataset metadata rejects any digest drift before campaign generation', () => {
  const checksumBytes = Buffer.from('not-the-sealed-checksum-manifest');
  const readyBytes = Buffer.from('{}\n');
  assert.throws(() => assertAcceptedDatasetMetadata({
    ready: {
      schemaVersion: 'sgx-ready-for-acceptance.1',
      specVersion: '2.0.0',
      datasetRootDigest: EXPECTED_DATASET_DIGEST,
      checksumManifest: { path: 'checksums/SHA256SUMS' },
    },
    accepted: {
      schemaVersion: 'sgx-synthetic-v2-accepted.1',
      datasetRootDigest: EXPECTED_DATASET_DIGEST,
      controlDigests: { checksums: EXPECTED_DATASET_DIGEST, ready: hash(readyBytes) },
      validOnlyWhileDigestMatches: true,
    },
    checksumBytes,
    readyBytes,
  }), /CHECKSUM_MANIFEST_DIGEST_MISMATCH/);
});

test('formal generation requires a persistent output outside the accepted dataset', async () => {
  await assert.rejects(() => prepareFormalV2Campaign({
    dataset: DATASET,
    acceptance: ACCEPTANCE,
    out: path.join(tmpdir(), 'sgx-formal-v2-forbidden'),
    sourceRevision: TEST_SOURCE_REVISION,
    now: new Date('2026-10-03T00:00:00+08:00'),
  }), /PERSISTENT_OUTPUT_REQUIRED/);
  await assert.rejects(() => prepareFormalV2Campaign({
    dataset: DATASET,
    acceptance: ACCEPTANCE,
    out: path.join(DATASET, 'campaign-output'),
    sourceRevision: TEST_SOURCE_REVISION,
    now: new Date('2026-10-03T00:00:00+08:00'),
    allowEphemeralOutputForTest: true,
  }), /OUTPUT_INSIDE_ACCEPTED_DATASET/);
});

test('generator materializes the exact offline campaign without mutating the accepted dataset', { skip: !hasAcceptedDataset }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'sgx-formal-v2-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const out = path.join(temporary, 'campaign');
  const checksumPath = path.join(DATASET, 'checksums', 'SHA256SUMS');
  const checksumBefore = await readFile(checksumPath);
  const checksumStatBefore = await stat(checksumPath);

  const result = await prepareFormalV2Campaign({
    dataset: DATASET,
    acceptance: ACCEPTANCE,
    out,
    sourceRevision: TEST_SOURCE_REVISION,
    now: new Date('2026-10-03T00:00:00+08:00'),
    allowEphemeralOutputForTest: true,
  });
  assert.deepEqual(result.summary, {
    submissions: 20,
    evidence: 53,
    images: 30,
    userText: 12,
    finalAsr: 11,
    singleImage: 8,
    twoImage: 6,
    fiveImage: 2,
    textOnly: 2,
    asrOnly: 2,
    albumUpload: 14,
    familyTransfer: 6,
    relationSame: 7,
    relationDifferent: 11,
    relationUnknown: 3,
    providerExtractCalls: 30,
    providerRelateCalls: 21,
    providerCalls: 51,
    deterministicEvaluations: 4,
    evaluationUnits: 55,
  });
  assert.equal(result.datasetRootDigest, EXPECTED_DATASET_DIGEST);
  assert.equal(result.runnerExecutable, false);
  assert.equal(result.personOverlayReady, false);

  const [campaign, exploration, validation, explorationManifest, validationManifest, deterministic, gap, overlay, authorization, generatedManifest] = await Promise.all([
    readJson(path.join(out, 'campaign.json')),
    readJson(path.join(out, 'phases', 'exploration.json')),
    readJson(path.join(out, 'phases', 'validation.json')),
    readJson(path.join(out, 'manifests', 'exploration.json')),
    readJson(path.join(out, 'manifests', 'validation.json')),
    readJson(path.join(out, 'deterministic-plan.json')),
    readJson(path.join(out, 'RUNNER_SCHEMA_GAP.json')),
    readJson(path.join(out, 'fixtures', 'person-overlay.json')),
    readJson(path.join(out, 'AUTHORIZATION_REQUEST.json')),
    readJson(path.join(out, 'MANIFEST.sha256.json')),
  ]);
  assert.equal(campaign.totals.providerCalls, 51);
  assert.equal(campaign.totals.deterministicEvaluations, 4);
  assert.deepEqual(campaign.caps, CAMPAIGN_CAPS);
  assert.deepEqual(campaign.sourceRevision, TEST_SOURCE_REVISION);
  assert.deepEqual(exploration.planned, {
    submissions: 12, evidence: 32, images: 18, userText: 7, finalAsr: 7,
    singleImage: 1, twoImage: 6, fiveImage: 1, textOnly: 2, asrOnly: 2,
    albumUpload: 8, familyTransfer: 4, relationSame: 6, relationDifferent: 6,
    relationUnknown: 1, providerExtractCalls: 18, providerRelateCalls: 13,
    providerCalls: 31, deterministicEvaluations: 4, evaluationUnits: 35,
  });
  assert.deepEqual(validation.planned, {
    submissions: 8, evidence: 21, images: 12, userText: 5, finalAsr: 4,
    singleImage: 7, twoImage: 0, fiveImage: 1, textOnly: 0, asrOnly: 0,
    albumUpload: 6, familyTransfer: 2, relationSame: 1, relationDifferent: 5,
    relationUnknown: 2, providerExtractCalls: 12, providerRelateCalls: 8,
    providerCalls: 20, deterministicEvaluations: 0, evaluationUnits: 20,
  });
  assert.equal(exploration.relationSelection.allPairsExpansion, false);
  assert.equal(validation.relationSelection.allPairsExpansion, false);
  assert.equal(explorationManifest.version, 'sgx-eval.1');
  assert.deepEqual(explorationManifest.sourceRevision, TEST_SOURCE_REVISION);
  assert.equal(explorationManifest.status, 'draft');
  assert.equal(explorationManifest.tasks.length, 4);
  assert.equal(explorationManifest.photos.length, 18);
  assert.equal(explorationManifest.tasks.reduce((sum, task) => sum + task.request.photos.length + task.relationPairs.length, 0), 31);
  assert.equal(explorationManifest.tasks.reduce((sum, task) => sum + task.relationPairs.length, 0), 13);
  assert.equal(validationManifest.tasks.length, 4);
  assert.equal(validationManifest.photos.length, 12);
  assert.equal(validationManifest.tasks.reduce((sum, task) => sum + task.request.photos.length + task.relationPairs.length, 0), 20);
  assert.equal(validationManifest.tasks.reduce((sum, task) => sum + task.relationPairs.length, 0), 8);
  assert.equal([...explorationManifest.tasks, ...validationManifest.tasks].every(task => !('retrievalHints' in task.request) && !('generatedAt' in task.request)), true);
  assert.equal([...explorationManifest.photos, ...validationManifest.photos].every(photo => typeof photo.personConsentRef === 'string' && photo.personConsentRef.length > 0), true);
  assert.equal(deterministic.tasks.length, 4);
  assert.equal(deterministic.providerCalls, 0);
  assert.equal(deterministic.tasks.every(task => task.fixture.evidence.length === 1 && task.providerCalls === 0), true);
  assert.equal(deterministic.version, 'sgx-formal-v2-deterministic-plan.2');
  assert.equal(deterministic.tasks.every(task => /^sha256:[a-f0-9]{64}$/.test(task.fixture.evidence[0].sourceHash)
    && /^sha256:[a-f0-9]{64}$/.test(task.fixture.evidence[0].textHash)
    && task.fixture.evidence[0].sourceHash !== task.fixture.evidence[0].textHash), true);
  const t003 = deterministic.tasks.find(task => task.bundleId === 'SGX-V2-T003');
  assert.deepEqual(t003.expected.semantic.candidate.person, ['同事']);
  assert.deepEqual(t003.expected.semantic.candidate.event, ['欢送会']);
  assert.equal(t003.expected.semantic.unknownFacets.includes('person'), false);
  assert.equal(t003.expected.semantic.unknownFacets.includes('event'), false);
  assert.deepEqual(t003.expected.semantic.forbiddenValues.event, ['退休']);
  assert.equal(t003.expected.semantic.formalAdjudication.basis, 'explicit_text_semantics_overlay');
  assert.equal(gap.status, 'provider_manifests_executable');
  assert.equal(gap.minimalGaps.some(item => item.code === 'EXPLICIT_RELATION_ALLOWLIST_UNSUPPORTED'), false);
  assert.equal(gap.minimalGaps.some(item => item.code === 'ZERO_IMAGE_DETERMINISTIC_TASK_UNSUPPORTED'), true);
  assert.equal(overlay.status, 'pending_detector_materialization');
  assert.equal(overlay.persistence, 'required_under_campaign_root');
  assert.deepEqual(overlay.entries, []);
  assert.equal(/displayName|relativeName|kinship|storyMemory|longTermMemory/.test(JSON.stringify(overlay)), false);
  assert.equal(authorization.campaignHash, result.campaignHash);
  assert.deepEqual(authorization.caps, CAMPAIGN_CAPS);
  assert.equal(authorization.allowPersonMatching, true);
  assert.equal(authorization.externalCallsMadeByGenerator, 0);
  assert.equal(generatedManifest.files.filter(item => item.path.startsWith('images/')).length, 30);

  if(process.env.CLASSIFICATION_BUILD_DIR) {
    const { preflight } = await import('./stage-a-evaluation.mjs');
    const explorationPreflight = await preflight(path.join(out, 'manifests', 'exploration.json'));
    const validationPreflight = await preflight(path.join(out, 'manifests', 'validation.json'));
    assert.equal(explorationPreflight.ready, false);
    assert.deepEqual(explorationPreflight.blockers, ['MANIFEST_DRAFT']);
    assert.equal(explorationPreflight.summary.photos, 18);
    assert.equal(explorationPreflight.summary.coldCacheRequestEstimate, 31);
    assert.equal(validationPreflight.ready, false);
    assert.deepEqual(validationPreflight.blockers, ['MANIFEST_DRAFT']);
    assert.equal(validationPreflight.summary.photos, 12);
    assert.equal(validationPreflight.summary.coldCacheRequestEstimate, 20);
  }

  const checksumAfter = await readFile(checksumPath);
  const checksumStatAfter = await stat(checksumPath);
  assert.equal(hash(checksumAfter), hash(checksumBefore));
  assert.equal(checksumStatAfter.mtimeMs, checksumStatBefore.mtimeMs);
  await assert.rejects(() => prepareFormalV2Campaign({ dataset: DATASET, acceptance: ACCEPTANCE, out, sourceRevision: TEST_SOURCE_REVISION, now: new Date(), allowEphemeralOutputForTest: true }), /OUTPUT_EXISTS/);

  const photoById = new Map([...explorationManifest.photos, ...validationManifest.photos].map(item => [item.photo.photoId, item.photo]));
  const personOverlay = {
    version: 'sgx-formal-v2-person-overlay.1',
    datasetRootDigest: EXPECTED_DATASET_DIGEST,
    generatedAt: '2026-10-03T00:00:00.000Z',
    reviewedBy: 'test-fixture',
    detector: { modelId: 'test-yunet', modelRevision: 'test-only' },
    claimBoundary: 'anonymous_synthetic_person_truth_only',
    entries: PERSON_TRUTH_PHOTO_IDS.map(photoId => {
      const sourceHash = photoById.get(photoId).sourceHash;
      if(photoId.startsWith('SGX-V2-E')) return { photoId, sourceHash, faces: [{ faceId: `face-${photoId}`, personId: 'anon-bamboo-bike-01', box: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } }] };
      if(photoId === 'SGX-V2-H010') return { photoId, sourceHash, faces: [
        { faceId: `face-${photoId}-left`, personId: 'anon-river-h010-left', box: { x: 0.15, y: 0.15, width: 0.2, height: 0.2 } },
        { faceId: `face-${photoId}-right`, personId: 'anon-river-h010-right', box: { x: 0.6, y: 0.15, width: 0.2, height: 0.2 } },
      ] };
      return { photoId, sourceHash, faces: [
        { faceId: `face-${photoId}-left`, personId: 'anon-river-travel-left', box: { x: 0.15, y: 0.15, width: 0.2, height: 0.2 } },
        { faceId: `face-${photoId}-right`, personId: 'anon-river-travel-right', box: { x: 0.6, y: 0.15, width: 0.2, height: 0.2 } },
      ] };
    }),
  };
  const readyOut = path.join(temporary, 'campaign-ready');
  const readyResult = await prepareFormalV2Campaign({
    dataset: DATASET,
    acceptance: ACCEPTANCE,
    out: readyOut,
    personOverlay,
    sourceRevision: TEST_SOURCE_REVISION,
    now: new Date('2026-10-03T00:00:00+08:00'),
    allowEphemeralOutputForTest: true,
  });
  assert.equal(readyResult.runnerExecutable, true);
  assert.equal(readyResult.personOverlayReady, true);
  const [readyExploration, readyValidation, readyExplorationTruth, readyValidationTruth] = await Promise.all([
    readJson(path.join(readyOut, 'manifests', 'exploration.json')),
    readJson(path.join(readyOut, 'manifests', 'validation.json')),
    readJson(path.join(readyOut, 'truth', 'exploration.json')),
    readJson(path.join(readyOut, 'truth', 'validation.json')),
  ]);
  assert.equal(readyExploration.status, 'ready');
  assert.equal(readyValidation.status, 'ready');
  assert.equal(readyExplorationTruth.photos.reduce((sum, photo) => sum + photo.faces.length, 0), 3);
  assert.equal(readyValidationTruth.photos.reduce((sum, photo) => sum + photo.faces.length, 0), 6);
  assert.equal(readyExploration.tasks.some(task => task.evaluation.personPairs), true);
  assert.equal(readyValidation.tasks.some(task => task.evaluation.personPairs), true);
  if(process.env.CLASSIFICATION_BUILD_DIR) {
    const { preflight } = await import('./stage-a-evaluation.mjs');
    assert.equal((await preflight(path.join(readyOut, 'manifests', 'exploration.json'))).ready, true);
    assert.equal((await preflight(path.join(readyOut, 'manifests', 'validation.json'))).ready, true);
  }
});

test('generator rejects an acceptance file rebound to any other digest', { skip: !hasAcceptedDataset }, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'sgx-formal-v2-bad-acceptance-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const accepted = JSON.parse(await readFile(ACCEPTANCE, 'utf8'));
  accepted.datasetRootDigest = `sha256:${'0'.repeat(64)}`;
  const badAcceptance = path.join(temporary, 'ACCEPTED.json');
  await writeFile(badAcceptance, `${JSON.stringify(accepted)}\n`);
  await assert.rejects(() => prepareFormalV2Campaign({
    dataset: DATASET,
    acceptance: badAcceptance,
    out: path.join(temporary, 'out'),
    sourceRevision: TEST_SOURCE_REVISION,
    now: new Date('2026-10-03T00:00:00+08:00'),
    allowEphemeralOutputForTest: true,
  }), /ACCEPTANCE_DIGEST_MISMATCH/);
});

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}
