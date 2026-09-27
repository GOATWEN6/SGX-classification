import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { preflightT0RealMedia, T0_REQUIRED_SCENARIOS } = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/t0-real-media.js`);
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const createdAt = '2026-09-27T12:00:00.000Z';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function validators() {
  const Ajv = require('ajv');
  const ajv = new Ajv({ strictKeywords: true, allErrors: true });
  const contractDirectory = path.join(repositoryRoot, 'contracts');
  const files = await readdir(contractDirectory);
  for(const file of files.filter(value => value.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(await readFile(path.join(contractDirectory, file), 'utf8')));
  }
  return {
    manifest: ajv.getSchema('urn:sgx:classification-t0-real-media:v2#/definitions/Manifest'),
    truth: ajv.getSchema('urn:sgx:classification-t0-real-media:v2#/definitions/Truth')
  };
}

function png(index, width = 2, height = 2) {
  const bytes = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(index, 24);
  return bytes;
}

async function buildFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-t0-real-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plans = Array.from({ length: 30 }, (_, offset) => ({ images: 1, tags: ['album_upload'], index: offset + 1 }));
  Object.assign(plans[0], { tags: ['single_image', 'album_upload', 'old_photo'] });
  Object.assign(plans[1], { images: 2, text: 1, explicitMulti: true, tags: ['multi_image', 'image_text', 'explicit_multi_binding', 'same_event', 'near_duplicate'] });
  Object.assign(plans[2], { images: 0, text: 1, tags: ['text_only', 'batch_text'] });
  Object.assign(plans[3], { images: 0, asr: 1, tags: ['asr_only'] });
  Object.assign(plans[4], { text: 1, tags: ['image_text', 'new_photo'] });
  Object.assign(plans[5], { asr: 1, tags: ['image_asr'] });
  Object.assign(plans[6], { text: 1, asr: 1, tags: ['image_text_asr'] });
  Object.assign(plans[7], { images: 0, text: 1, family: true, highRisk: true, tags: ['family_transfer', 'sensitive_high_risk'] });
  Object.assign(plans[8], { text: 1, abstain: true, tags: ['batch_text', 'abstain'] });
  Object.assign(plans[9], { withdrawn: true, tags: ['withdrawal'] });
  Object.assign(plans[10], { images: 2, tags: ['different_event_same_context'] });
  Object.assign(plans[11], { tags: ['conflict'] });

  const groups = [];
  const truthGroups = [];
  for(const plan of plans) {
    const suffix = String(plan.index).padStart(2, '0');
    const groupId = `group_${suffix}`;
    const directory = `groups/${groupId}`;
    await mkdir(path.join(root, directory), { recursive: true });
    const evidence = [];
    const contents = [];
    const sources = [];
    const bindings = [];
    const truthContents = [];
    const imageContentIds = [];
    const addSource = async ({ modality, number, bytes, mimeType, dimensions }) => {
      const evidenceId = `evidence_${modality}_${suffix}_${number}`;
      const contentId = `content_${modality}_${suffix}_${number}`;
      const extension = modality === 'image' ? 'png' : 'txt';
      const relativePath = `${directory}/${evidenceId}.${extension}`;
      await writeFile(path.join(root, relativePath), bytes);
      const sourceHash = sha(bytes);
      const lifecycleState = plan.withdrawn ? 'trashed' : 'active';
      evidence.push({
        evidenceId, subjectId: 'elder_real', householdId: 'house_real', schemaVersion: '1.0',
        ownerId: 'elder_real', contributorId: plan.family ? 'daughter_real' : 'elder_real', consentRef: `consent_${suffix}`,
        visibility: plan.family ? 'household' : 'private', ingestedAt: createdAt, lifecycleState,
        sourceRef: { kind: modality === 'user_text' ? 'message' : 'object', id: `source_${evidenceId}` },
        sourceHash, revision: 1, byteLength: bytes.length,
        modality: modality === 'user_text' ? 'text' : modality === 'final_asr' ? 'transcript' : 'image', mimeType,
        ...(dimensions ? { dimensions } : {}),
        ...(modality === 'final_asr' ? { asr: { final: true, producerVersion: 'fixture-asr.1' } } : {})
      });
      contents.push({ contentId, evidenceId, modality, lifecycleState: plan.withdrawn ? 'withdrawn' : 'active' });
      sources.push({ evidenceId, path: relativePath, sourceHash, byteLength: bytes.length, mimeType, consentRef: `consent_${suffix}`, origin: 'real_user_provided' });
      truthContents.push({
        contentId, evidenceId, sourceHash, expectedStoryKey: `story_${suffix}`,
        expectedAction: plan.highRisk ? 'needs_review' : plan.abstain ? 'abstain' : 'auto_organize',
        riskLevel: plan.highRisk ? 'high' : 'low',
        facets: { time: [], place: [], event: [], scene: [], theme: [] }
      });
      if(modality === 'image') imageContentIds.push(contentId);
      return { evidenceId, contentId };
    };
    for(let image = 0; image < (plan.images ?? 0); image += 1) await addSource({ modality: 'image', number: image + 1, bytes: png(plan.index * 10 + image), mimeType: 'image/png', dimensions: { width: 2, height: 2 } });
    const textSources = [];
    for(let textIndex = 0; textIndex < (plan.text ?? 0); textIndex += 1) textSources.push(await addSource({ modality: 'user_text', number: textIndex + 1, bytes: Buffer.from(`第${plan.index}组用户说明`, 'utf8'), mimeType: 'text/plain' }));
    const asrSources = [];
    for(let asrIndex = 0; asrIndex < (plan.asr ?? 0); asrIndex += 1) asrSources.push(await addSource({ modality: 'final_asr', number: asrIndex + 1, bytes: Buffer.from(`第${plan.index}组最终语音转写`, 'utf8'), mimeType: 'text/plain' }));
    for(const source of [...textSources, ...asrSources]) {
      const target = plan.explicitMulti ? { kind: 'contents', contentIds: imageContentIds } : { kind: 'batch' };
      const targetEvidenceIds = target.kind === 'contents' ? evidence.filter(item => target.contentIds.some(contentId => contents.find(content => content.contentId === contentId)?.evidenceId === item.evidenceId)).map(item => item.evidenceId) : [];
      bindings.push({
        bindingId: `binding_${source.contentId}`, sourceContentId: source.contentId, target,
        authority: 'user_explicit', state: 'active', method: plan.explicitMulti ? 'user-selection.1' : 'user-unspecified-batch.1',
        evidenceRefs: [source.evidenceId, ...targetEvidenceIds], createdAt
      });
    }
    const envelope = {
      specVersion: '2.0.0', contractVersion: 'classification-ingestion.2', ingestionId: `ingestion_${suffix}`, batchId: groupId,
      scope: { householdId: 'house_real', subjectId: 'elder_real' }, actorId: plan.family ? 'daughter_real' : 'elder_real',
      context: plan.family ? { kind: 'family_transfer', senderId: 'daughter_real', recipientIds: ['elder_real'] } : { kind: 'album_upload' },
      authorizationRevision: 'auth_1', taxonomyVersion: 'taxonomy.1', purposes: ['classification', 'album_organization'],
      evidence, contents, bindings,
      ...(plan.family ? { reviewPolicy: { policyVersion: 'family-inbox.1', remindAfterDays: 3, hideFromHomeAfterDays: 7, highRiskRetention: 'until_resolved' } } : {}),
      createdAt
    };
    const envelopePath = `${directory}/envelope.json`;
    await writeFile(path.join(root, envelopePath), `${JSON.stringify(envelope, null, 2)}\n`);
    groups.push({ groupId, partition: plan.index <= 20 ? 'exploration' : 't1_validation', leakageGroup: `leakage_${suffix}`, envelopePath, sources, scenarioTags: plan.tags });
    truthGroups.push({ groupId, contents: truthContents });
  }
  const truth = { specVersion: '2.0.0', contractVersion: 'classification-t0-truth.1', datasetId: 'real_batch_1', reviewedBy: 'human_reviewer', frozenAt: createdAt, groups: truthGroups };
  const truthBytes = Buffer.from(`${JSON.stringify(truth, null, 2)}\n`);
  await writeFile(path.join(root, 'truth.json'), truthBytes);
  const manifest = {
    specVersion: '2.0.0', contractVersion: 'classification-t0-real-media.1', datasetId: 'real_batch_1', status: 'frozen',
    purpose: 't0_t1_calibration', plannedGroups: 30, personMatching: 'disabled', rawMediaPolicy: 'outside_git',
    requiredScenarioTags: [...T0_REQUIRED_SCENARIOS], truth: { path: 'truth.json', sourceHash: sha(truthBytes) }, groups, createdAt
  };
  const manifestPath = path.join(root, 'manifest.json');
  const saveManifest = async () => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await saveManifest();
  return { root, manifest, truth, manifestPath, saveManifest };
}

test('frozen 30-group real-media batch passes offline checks without credentials or external calls', async t => {
  const fixture = await buildFixture(t);
  const result = await preflightT0RealMedia(fixture.manifestPath);
  const validate = await validators();
  assert.equal(validate.manifest(structuredClone(result.manifest)), true, JSON.stringify(validate.manifest.errors));
  assert.equal(validate.truth(structuredClone(result.truth)), true, JSON.stringify(validate.truth.errors));
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.summary.groups, 30);
  assert.ok(result.summary.images > 0);
  assert.ok(result.summary.userTexts > 0);
  assert.ok(result.summary.finalAsr > 0);
  assert.ok(result.summary.albumUploads > 0);
  assert.ok(result.summary.familyTransfers > 0);
  assert.equal(result.summary.credentialsRead, false);
  assert.equal(result.summary.externalCalls, 0);
  assert.deepEqual(result.summary.missingScenarioTags, []);
  const cli = spawnSync(process.execPath, ['scripts/classification-t0-preflight.mjs', '--manifest', fixture.manifestPath], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).groups, 30);
});

test('draft, denominator drift and pending truth remain explicit blockers', async t => {
  const fixture = await buildFixture(t);
  fixture.manifest.status = 'draft';
  fixture.manifest.plannedGroups = 31;
  await fixture.saveManifest();
  const result = await preflightT0RealMedia(fixture.manifestPath);
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes('MANIFEST_DRAFT'));
  assert.ok(result.blockers.includes('PLANNED_GROUP_COUNT_MISMATCH'));
});

test('source traversal, tampering and image dimension drift are rejected before evaluation', async t => {
  const fixture = await buildFixture(t);
  const first = fixture.manifest.groups[0].sources[0];
  first.path = '../outside.png';
  await fixture.saveManifest();
  await assert.rejects(preflightT0RealMedia(fixture.manifestPath), /SOURCE_PATH_ESCAPE/);

  first.path = `groups/group_01/${first.evidenceId}.png`;
  await fixture.saveManifest();
  const sourcePath = path.join(fixture.root, first.path);
  const original = await readFile(sourcePath);
  await writeFile(sourcePath, Buffer.concat([original, Buffer.from('tampered')]));
  await assert.rejects(preflightT0RealMedia(fixture.manifestPath), /SOURCE_LENGTH_MISMATCH|SOURCE_HASH_MISMATCH/);

  await writeFile(sourcePath, original);
  const envelopePath = path.join(fixture.root, fixture.manifest.groups[0].envelopePath);
  const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
  envelope.evidence[0].dimensions.width = 3;
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`);
  await assert.rejects(preflightT0RealMedia(fixture.manifestPath), /IMAGE_DIMENSIONS_MISMATCH/);
});

test('frozen batches cannot omit the approved scenario matrix or risk/abstention truth', async t => {
  const fixture = await buildFixture(t);
  fixture.manifest.requiredScenarioTags = fixture.manifest.requiredScenarioTags.filter(tag => tag !== 'conflict');
  await fixture.saveManifest();
  const result = await preflightT0RealMedia(fixture.manifestPath);
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes('REQUIRED_SCENARIO_MATRIX_INCOMPLETE'));
});
