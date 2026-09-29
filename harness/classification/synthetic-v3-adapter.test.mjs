import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { png } from './fixtures/stage-a.mjs';

const require = createRequire(import.meta.url);
const adapter = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/synthetic-v3-adapter.js`);
const { parseIngestionEnvelope } = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/ingestion-contract.js`);
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const plainSha = bytes => createHash('sha256').update(bytes).digest('hex');

function source(groupId, type, relativePath, bytes, upstreamBundleId, overrides = {}) {
  return {
    assetId: `asset:${groupId}:${type}:001`, type, path: relativePath,
    mimeType: type === 'photo' ? 'image/png' : 'text/plain; charset=utf-8',
    bytes: bytes.length, sha256: sha(bytes), status: 'active', assetOrigin: 'synthetic_ai_generated', synthetic: true,
    upstreamBundleId, personMatchingAllowed: false, referenceOnly: false,
    ...(type === 'photo' ? { image: { format: 'png', width: 1, height: 1, mode: 'RGBA', orientation: 1 } } : {}),
    ...overrides
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-synthetic-v3-adapter-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const createdAt = '2026-09-28T00:00:00.000Z';
  const groups = [];
  const truths = [];
  const text = Buffer.from('1985年在武汉毕业', 'utf8');
  const definitions = [
    { id: 'sgx-v3-g001', partition: 'exploration', upstream: 'SYN-E001', withText: true },
    { id: 'sgx-v3-g002', partition: 't1_validation', upstream: 'SYN-H001', withText: false }
  ];
  const checksumPaths = [];
  for(const definition of definitions) {
    const dir = path.join(root, 'groups', definition.id); await mkdir(dir, { recursive: true });
    const imagePath = `groups/${definition.id}/photo_001.png`;
    const imageBytes = definition.partition === 'exploration' ? png : Buffer.concat([png, Buffer.from([0])]);
    await writeFile(path.join(root, imagePath), imageBytes); checksumPaths.push(imagePath);
    const sources = [source(definition.id, 'photo', imagePath, imageBytes, definition.upstream)];
    const bindings = [];
    if(definition.withText) {
      const textPath = `groups/${definition.id}/user_text_001.txt`;
      await writeFile(path.join(root, textPath), text); checksumPaths.push(textPath);
      sources.push(source(definition.id, 'user_text', textPath, text, definition.upstream));
      bindings.push({
        bindingId: `binding:${definition.id}:01`, sourceAssetId: `asset:${definition.id}:user_text:001`,
        target: { kind: 'contents', targetAssetIds: [`asset:${definition.id}:photo:001`] },
        authority: 'synthetic_fixture_explicit', mapsToIngestionAuthority: 'user_explicit', state: 'active', synthetic: true
      });
    }
    const input = {
      schemaVersion: 'sgx-t0-photorealistic-synthetic-input.1', datasetId: 'synthetic-v3-test', specVersion: '3.0.0',
      groupId: definition.id, partition: definition.partition, comboCategory: definition.withText ? 'image_user_text' : 'pure_image',
      context: { kind: 'album_upload', albumId: `syn-album-${definition.id}` },
      syntheticIdentity: { actorId: `syn-actor-${definition.id}`, subjectId: `syn-subject-${definition.id}`, ownerId: `syn-owner-${definition.id}`, contributorId: `syn-contributor-${definition.id}`, fictitious: true },
      lifecycle: 'active', lifecycleEvents: [{ event: 'synthetic_fixture_created', revision: 1 }],
      authorizationRevision: `syn-auth:${definition.id}:r1`, contextRevision: `syn-ctx:${definition.id}:r1`, personMatching: 'disabled',
      sources, bindings, scenarioTags: [definition.withText ? 'image_text' : 'single_image', 'album_upload'], contextClusterId: null,
      syntheticNotice: '全部内容为合成测试素材，不对应真实个人或家庭。'
    };
    const inputPath = `inputs/${definition.id}.json`; await mkdir(path.join(root, 'inputs'), { recursive: true });
    await writeFile(path.join(root, inputPath), JSON.stringify(input, null, 2) + '\n'); checksumPaths.push(inputPath);
    const truth = {
      schemaVersion: 'sgx-t0-photorealistic-synthetic-truth.1', datasetId: 'synthetic-v3-test', specVersion: '3.0.0', groupId: definition.id,
      truthType: 'synthetic_expected_behavior_fixture', expected: {
        action: 'auto_organize', riskLevel: 'low', storyKey: `story:${definition.id}`,
        facets: { event: ['毕业'], scene: ['校园'], time: ['1985'], place: ['武汉'], theme: [], peopleLabels: [], conflicts: [] },
        lifecycle: 'active', personMatching: 'disabled', evidenceAssetIds: sources.filter(item => item.type !== 'audio_original').map(item => item.assetId)
      },
      truthSourceBundleIds: [definition.upstream], reviewedBy: 'synthetic-fixture-review',
      claimBoundary: 'synthetic_fixture_and_current_offline_integration_only',
      syntheticNotice: '全部内容为合成测试素材，不对应真实个人或家庭。', notes: null
    };
    const truthPath = `truth/groups/${definition.id}.json`; await mkdir(path.join(root, 'truth/groups'), { recursive: true });
    await writeFile(path.join(root, truthPath), JSON.stringify(truth, null, 2) + '\n'); checksumPaths.push(truthPath); truths.push(truth);
    groups.push({
      groupId: definition.id, partition: definition.partition, comboCategory: input.comboCategory, contextKind: 'album_upload', lifecycle: 'active',
      inputPath, truthPath, upstreamBundleIds: [definition.upstream], scenarioTags: input.scenarioTags, contextClusterId: null,
      assetIds: sources.map(item => item.assetId), modalityCounts: { photo: 1, user_text: definition.withText ? 1 : 0, final_asr: 0, audio_original: 0 },
      expectedAction: 'auto_organize', riskLevel: 'low'
    });
  }
  const truthIndex = { schemaVersion: 'sgx-t0-photorealistic-synthetic-truth-index.1', datasetId: 'synthetic-v3-test', specVersion: '3.0.0', groupCount: 2, claimBoundary: 'synthetic_fixture_and_current_offline_integration_only', groups: truths };
  await writeFile(path.join(root, 'truth/truth.json'), JSON.stringify(truthIndex, null, 2) + '\n'); checksumPaths.push('truth/truth.json');
  const manifest = {
    schemaVersion: 'sgx-t0-photorealistic-synthetic-manifest.1', datasetId: 'synthetic-v3-test', specVersion: '3.0.0', status: 'complete_synthetic_fixture',
    claimBoundary: 'synthetic_fixture_and_current_offline_integration_only', incompatibleWithRealTemplateSchema: 'classification-t0-real-media.1', realDataCount: 0,
    plannedGroups: 2, completedGroups: 2, partitionTargets: { exploration: 1, t1_validation: 1 }, partitionCompleted: { exploration: 1, t1_validation: 1 },
    combinationTargets: { image_user_text: 1, pure_image: 1 }, combinationCompleted: { image_user_text: 1, pure_image: 1 }, requiredScenarioDimensions: ['image_text', 'single_image'],
    scenarioCoverage: { image_text: ['sgx-v3-g001'], single_image: ['sgx-v3-g002'] }, assetCounts: { photo: 2, user_text: 1, final_asr: 0, audio_original: 0 },
    assetOriginVocabulary: ['synthetic_ai_generated'], currentRunGeneration: { imagegenCalls: 0, ttsCalls: 0, externalModelCalls: 0, estimatedCostCny: 0 }, groups, createdAt,
    syntheticNotice: '全部内容为合成测试素材，不对应真实个人或家庭。'
  };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); checksumPaths.push('manifest.json');
  const lines = [];
  for(const relative of checksumPaths.sort()) lines.push(`${plainSha(await readFile(path.join(root, relative)))}  ${relative}`);
  await mkdir(path.join(root, 'checksums'), { recursive: true });
  await writeFile(path.join(root, 'checksums/SHA256SUMS'), lines.join('\n') + '\n');
  return { root, manifestPath: path.join(root, 'manifest.json'), manifest, groups };
}

test('adapts every fixed-denominator group to ingestion and image groups to Stage A without claiming real provenance', async t => {
  const f = await fixture(t);
  const result = await adapter.adaptSyntheticV3Dataset(f.manifestPath, { now: '2026-09-28T00:00:00.000Z' });
  assert.equal(result.report.fixedDenominator.plannedGroups, 2);
  assert.equal(result.report.fixedDenominator.ingestionGroups, 2);
  assert.equal(result.report.fixedDenominator.stageAEligibleGroups, 2);
  assert.deepEqual(result.report.partitions, { exploration: 1, t1_validation: 1 });
  assert.deepEqual(result.report.routes, { stage_a_photo_anchored: 2, content_organization_only: 0, withdrawn: 0 });
  assert.ok(result.report.routing.every(item => item.route === 'stage_a_photo_anchored'));
  for(const group of result.groups) assert.equal(parseIngestionEnvelope(group.envelope).batchId, group.groupId);
  assert.equal(result.stageA.exploration.manifest.partition, 'exploration');
  assert.equal(result.stageA.t1_validation.manifest.partition, 'holdout');
  assert.deepEqual(result.stageA.exploration.manifest.tasks[0].request.photos[0].textEvidence.map(item => item.source), ['user_text']);
  assert.equal(JSON.stringify(result).includes('real_user_provided'), false);
  assert.equal(result.report.provenance, 'synthetic_fixture');
  assert.equal(result.report.externalCalls, 0);
});

test('writes non-overwriting ingestion and Stage A artifacts whose media and truth hashes are frozen', async t => {
  const f = await fixture(t); const out = path.join(f.root, 'adapted');
  const result = await adapter.writeSyntheticV3Artifacts(f.manifestPath, out, { now: '2026-09-28T00:00:00.000Z' });
  assert.equal(JSON.parse(await readFile(path.join(out, 'adapter-report.json'), 'utf8')).fixedDenominator.ingestionGroups, 2);
  assert.equal(JSON.parse(await readFile(path.join(out, 'ingestion/sgx-v3-g001.json'), 'utf8')).contractVersion, 'classification-ingestion.2');
  const batch = JSON.parse(await readFile(path.join(out, 'stage-a/exploration/batch.json'), 'utf8'));
  const truth = await readFile(path.join(out, 'stage-a/exploration/truth.json'));
  assert.equal(batch.truth.sha256, sha(truth));
  const media = await readFile(path.join(out, 'stage-a/exploration', batch.photos[0].path));
  assert.equal(batch.photos[0].photo.sourceHash, sha(media));
  assert.equal(result.report.artifactStatus, 'offline_adapter_output');
  await assert.rejects(() => adapter.writeSyntheticV3Artifacts(f.manifestPath, out), /OUTPUT_DIRECTORY_EXISTS/);
});

test('rejects source hash drift, path escape, symlink source, non-synthetic provenance and split leakage', async t => {
  const cases = [
    ['SOURCE_HASH_MISMATCH', async f => writeFile(path.join(f.root, 'groups/sgx-v3-g001/photo_001.png'), Buffer.from('changed'))],
    ['SOURCE_PATH_ESCAPE', async f => { const inputPath = path.join(f.root, f.groups[0].inputPath); const input = JSON.parse(await readFile(inputPath)); input.sources[0].path = '../outside.png'; await writeFile(inputPath, JSON.stringify(input)); await refreshChecksum(f.root, f.groups[0].inputPath); }],
    ['SOURCE_NOT_REGULAR_FILE', async f => { const target = path.join(f.root, 'groups/sgx-v3-g001/photo_001.png'); const real = `${target}.real`; const fs = await import('node:fs/promises'); await fs.rename(target, real); await symlink(real, target); }],
    ['NON_SYNTHETIC_SOURCE', async f => { const inputPath = path.join(f.root, f.groups[0].inputPath); const input = JSON.parse(await readFile(inputPath)); input.sources[0].synthetic = false; await writeFile(inputPath, JSON.stringify(input)); await refreshChecksum(f.root, f.groups[0].inputPath); }],
    ['UPSTREAM_BUNDLE_CROSSES_PARTITION', async f => {
      const group = f.groups[1]; const inputPath = path.join(f.root, group.inputPath); const input = JSON.parse(await readFile(inputPath)); input.sources[0].upstreamBundleId = 'SYN-E001';
      await writeFile(inputPath, JSON.stringify(input)); await refreshChecksum(f.root, group.inputPath);
      const truthPath = path.join(f.root, group.truthPath); const truth = JSON.parse(await readFile(truthPath)); truth.truthSourceBundleIds = ['SYN-E001']; await writeFile(truthPath, JSON.stringify(truth)); await refreshChecksum(f.root, group.truthPath);
      const manifest = JSON.parse(await readFile(f.manifestPath)); manifest.groups[1].upstreamBundleIds = ['SYN-E001']; await writeFile(f.manifestPath, JSON.stringify(manifest)); await refreshChecksum(f.root, 'manifest.json');
    }]
  ];
  for(const [code, mutate] of cases) {
    const f = await fixture(t); await mutate(f);
    await assert.rejects(() => adapter.adaptSyntheticV3Dataset(f.manifestPath), new RegExp(code));
  }
});

test('rejects a changed planned denominator instead of silently adapting a subset', async t => {
  const f = await fixture(t); const manifest = JSON.parse(await readFile(f.manifestPath)); manifest.plannedGroups = 3;
  await writeFile(f.manifestPath, JSON.stringify(manifest)); await refreshChecksum(f.root, 'manifest.json');
  await assert.rejects(() => adapter.adaptSyntheticV3Dataset(f.manifestPath), /FIXED_DENOMINATOR_MISMATCH/);
});

test('accepts a consistently frozen specVersion 3.1.0 without changing its synthetic claim boundary', async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(await readFile(f.manifestPath)); manifest.specVersion = '3.1.0'; await writeFile(f.manifestPath, JSON.stringify(manifest)); await refreshChecksum(f.root, 'manifest.json');
  for(const group of f.groups) {
    for(const relativePath of [group.inputPath, group.truthPath]) {
      const filename = path.join(f.root, relativePath); const value = JSON.parse(await readFile(filename)); value.specVersion = '3.1.0';
      await writeFile(filename, JSON.stringify(value)); await refreshChecksum(f.root, relativePath);
    }
  }
  const result = await adapter.adaptSyntheticV3Dataset(f.manifestPath);
  assert.equal(result.manifest.specVersion, '3.1.0');
  assert.equal(result.report.provenance, 'synthetic_fixture');
  assert.equal(JSON.stringify(result).includes('real_user_provided'), false);
});

test('adapts unresolved structured time candidates with distinct event and capture roles', async t => {
  const f = await fixture(t); const truthPath = path.join(f.root, f.groups[0].truthPath);
  const truth = JSON.parse(await readFile(truthPath));
  truth.expected.facets.time = ['1998', '2001']; truth.expected.facets.conflicts = ['time'];
  truth.expected.structured = {
    requiredAssertions: [], forbiddenAssertions: [],
    conflicts: [{ facet: 'time', candidates: [
      { value: '1998', role: 'event', sourceRefs: ['asset:sgx-v3-g001:user_text:001'], status: 'asserted' },
      { value: '2001', role: 'capture', sourceRefs: ['asset:sgx-v3-g001:photo:001'], status: 'asserted' }
    ], resolution: 'unresolved' }],
    relationships: [], unknownFacets: [], resultStatus: 'partial', workflowStatus: 'needs_review', qualityFlags: []
  };
  await writeFile(truthPath, JSON.stringify(truth)); await refreshChecksum(f.root, f.groups[0].truthPath);
  const result = await adapter.adaptSyntheticV3Dataset(f.manifestPath);
  assert.deepEqual(result.stageA.exploration.truth.photos[0].facets.time.map(item => item.value), ['event:year:1998', 'capture:year:2001']);
});

test('rejects truth labels outside the executable event and scene taxonomies', async t => {
  for(const [facet, code] of [['event', 'TRUTH_EVENT_ONTOLOGY_MISMATCH'], ['scene', 'TRUTH_SCENE_ONTOLOGY_MISMATCH']]) {
    const f = await fixture(t); const truthPath = path.join(f.root, f.groups[0].truthPath);
    const truth = JSON.parse(await readFile(truthPath)); truth.expected.facets[facet] = ['不存在的分类'];
    await writeFile(truthPath, JSON.stringify(truth)); await refreshChecksum(f.root, f.groups[0].truthPath);
    await assert.rejects(() => adapter.adaptSyntheticV3Dataset(f.manifestPath), new RegExp(code));
  }
});

test('keeps batch evidence at batch scope and derives a stable household from scopeId', async t => {
  const f = await fixture(t);
  const inputPath = path.join(f.root, f.groups[0].inputPath);
  const input = JSON.parse(await readFile(inputPath));
  input.context.scopeId = 'syn-household-stable-alpha';
  input.bindings[0].target = { kind: 'batch', targetAssetIds: [input.sources[0].assetId] };
  await writeFile(inputPath, JSON.stringify(input));
  await refreshChecksum(f.root, f.groups[0].inputPath);

  const result = await adapter.adaptSyntheticV3Dataset(f.manifestPath);
  const group = result.groups.find(item => item.groupId === f.groups[0].groupId);
  assert.equal(group.envelope.scope.householdId, 'syn-household-stable-alpha');
  assert.equal(group.stage.request.photos[0].textEvidence.length, 0);
  assert.deepEqual(group.stage.contentOrganizationEvidenceIds, [input.bindings[0].sourceAssetId]);
  assert.deepEqual(result.report.routing[0].contentOrganizationEvidenceIds, [input.bindings[0].sourceAssetId]);
});

async function refreshChecksum(root, relativePath) {
  const checksumPath = path.join(root, 'checksums/SHA256SUMS');
  const hash = plainSha(await readFile(path.join(root, relativePath)));
  const lines = (await readFile(checksumPath, 'utf8')).trimEnd().split('\n').map(line => line.endsWith(`  ${relativePath}`) ? `${hash}  ${relativePath}` : line);
  await writeFile(checksumPath, lines.join('\n') + '\n');
}
