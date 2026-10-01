import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EXPECTED_DATASET_DIGEST = 'sha256:2d18d96933f5c85454357eedee45cb185c9ad5eefac6f21e513ce0166ded0f2a';
const MODEL = 'qwen3.7-flash-2026-07-15';
const CASE_IDS = ['H002', 'H003', 'H004', 'H005', 'H006', 'H008', 'H009', 'H010', 'H011', 'H012'];

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dataset = option('--dataset');
const acceptance = option('--acceptance');
const out = option('--out');
const nowValue = option('--now');

if(args.includes('--help') || !dataset || !acceptance || !out) {
  console.log([
    '准备 SGX v2 产品功能真实模型批次（只读数据、不读凭据、不联网）：',
    'node harness/classification/prepare-v2-product-functional-eval.mjs \\',
    '  --dataset /absolute/accepted-dataset-root \\',
    '  --acceptance /absolute/ACCEPTED.json \\',
    '  --out /absolute/new-batch-dir [--now 2026-10-02T00:00:00+08:00]'
  ].join('\n'));
  process.exitCode = args.includes('--help') ? 0 : 2;
} else {
  const datasetRoot = path.resolve(dataset);
  const acceptancePath = path.resolve(acceptance);
  const outRoot = path.resolve(out);
  const now = nowValue ? new Date(nowValue) : new Date();
  if(!Number.isFinite(now.getTime())) throw new Error('INVALID_NOW');
  try { await stat(outRoot); throw new Error('OUTPUT_EXISTS'); }
  catch(error) { if(error.code !== 'ENOENT') throw error; }

  const ready = JSON.parse(await readFile(path.join(datasetRoot, 'READY_FOR_ACCEPTANCE.json'), 'utf8'));
  const accepted = JSON.parse(await readFile(acceptancePath, 'utf8'));
  if(ready.specVersion !== '2.0.0'
    || ready.datasetRootDigest !== EXPECTED_DATASET_DIGEST
    || accepted.datasetRootDigest !== EXPECTED_DATASET_DIGEST
    || accepted.validOnlyWhileDigestMatches !== true) {
    throw new Error('DATASET_ACCEPTANCE_MISMATCH');
  }

  await mkdir(path.join(outRoot, 'images'), { recursive: true, mode: 0o700 });
  const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const expected = (value, aliases = []) => ({ value, aliases });
  const inputs = new Map();
  const truths = new Map();
  const photos = new Map();
  const manifestPhotos = [];
  const truthPhotos = [];

  for(const shortId of CASE_IDS) {
    const bundleId = `SGX-V2-${shortId}`;
    const input = JSON.parse(await readFile(path.join(datasetRoot, 'inputs', 'extension', `${bundleId}.json`), 'utf8'));
    const truth = JSON.parse(await readFile(path.join(datasetRoot, 'truth', 'extension', `${bundleId}.json`), 'utf8'));
    if(input.bundleId !== bundleId || truth.bundleId !== bundleId || truth.split !== 'holdout') throw new Error(`CASE_MISMATCH_${shortId}`);
    const photoEvidence = input.evidence.find(item => item.type === 'photo' && item.status === 'active');
    if(!photoEvidence?.stageADerived?.path) throw new Error(`DERIVED_IMAGE_MISSING_${shortId}`);
    const source = path.join(datasetRoot, photoEvidence.stageADerived.path);
    const bytes = await readFile(source);
    const sourceHash = sha(bytes);
    if(sourceHash !== `sha256:${photoEvidence.stageADerived.sha256}` || bytes.length > 1024 * 1024) throw new Error(`DERIVED_IMAGE_INVALID_${shortId}`);
    const imageName = `${bundleId}.jpg`;
    await copyFile(source, path.join(outRoot, 'images', imageName));

    const textEvidence = [];
    for(const [sourceType, text] of [['user_text', input.user_original_text], ['final_asr', input.final_asr_transcript]]) {
      if(!text) continue;
      textEvidence.push({
        evidenceId: `${bundleId}:${sourceType.replace('_', '-')}`,
        revision: 1,
        sourceHash: sha(Buffer.from(text)),
        source: sourceType,
        text
      });
    }
    const scope = { householdId: input.scopeId, subjectId: input.subjectId };
    const photo = {
      photoId: bundleId,
      scope,
      revision: input.revision,
      sourceRef: photoEvidence.sourceRef,
      sourceHash,
      mimeType: 'image/jpeg',
      caption: '',
      ...(textEvidence.length ? { textEvidence } : {}),
      ...(truth.trustedExif ? { exif: truth.trustedExif } : {}),
      active: true
    };
    inputs.set(shortId, input);
    truths.set(shortId, truth);
    photos.set(shortId, photo);
    manifestPhotos.push({
      photo,
      path: `images/${imageName}`,
      split: 'holdout',
      leakageGroup: truth.eventStoryTruth.leakageGroup.replaceAll(':', '_'),
      externalConsentRef: input.consentRef
    });
    const eventTruth = truth.eventStoryTruth;
    truthPhotos.push({
      photoId: bundleId,
      sourceHash,
      facets: {
        time: eventTruth.time.map(item => expected(`${item.role}:${item.precision}:${item.value}`, relativeAliases(item))),
        place: eventTruth.place.map(value => expected(value)),
        event: eventTruth.event ? [expected(eventTruth.event)] : [],
        scene: eventTruth.scene.map(value => expected(value))
      },
      faces: [],
      eventInstance: eventTruth.eventInstanceId ? eventTruth.eventInstanceId.replaceAll(':', '_') : null,
      expectedUnknownFacets: eventTruth.unknownFacets,
      expectedConflicts: eventTruth.conflicts
    });
  }

  function relativeAliases(item) {
    if(item.precision !== 'relative') return [];
    const aliases = {
      trip_day_1: ['event:relative:第一天', 'event:relative:旅行第一天'],
      trip_day_2: ['event:relative:第二天', 'event:relative:旅行第二天'],
      following_year: ['event:relative:第二年', 'event:relative:次年']
    };
    return aliases[item.value] ?? [];
  }

  const caps = {
    maxRequests: 20,
    maxInputTokens: 1_500_000,
    maxOutputTokens: 50_000,
    maxCostCny: 5,
    maxDurationSeconds: 1200,
    maxRetries: 0
  };
  const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
  const buildRequest = (taskId, ids) => {
    const selected = ids.map(id => photos.get(id));
    const scope = selected[0].scope;
    if(selected.some(photo => photo.scope.householdId !== scope.householdId || photo.scope.subjectId !== scope.subjectId)) throw new Error(`CROSS_SCOPE_${taskId}`);
    return {
      contractVersion: 'classification-stage-a.1',
      runId: `product_${taskId}_20261002`,
      scope,
      authorizationRevision: `approved_${taskId}_20261002`,
      trigger: 'upload',
      photos: selected,
      references: [],
      corrections: [],
      budget: {
        maxRequests: caps.maxRequests,
        maxInputTokens: caps.maxInputTokens,
        maxOutputTokens: caps.maxOutputTokens,
        maxCostCny: caps.maxCostCny,
        deadlineAt: expiresAt,
        candidatesPerPhoto: 4,
        maxOutputPerRequest: 4096,
        stageOutputTokens: { extract: 4096, relate: 1024 },
        maxCallDurationMs: 60_000
      }
    };
  };
  const task = (taskId, ids, eventPairs = false) => ({
    taskId,
    request: buildRequest(taskId, ids),
    evaluatePhotoIds: ids.map(id => `SGX-V2-${id}`),
    expectedUnchangedPhotoIds: [],
    evaluation: { facets: ['time', 'place', 'event', 'scene'], personPairs: false, eventPairs, identityCandidates: false }
  });
  const tasks = [
    task('pure_image_abstain', ['H002']),
    task('time_conflict', ['H003']),
    task('multimodal_roles', ['H004']),
    task('asr_injection', ['H011']),
    task('metadata_like_boundary', ['H012']),
    task('graduations_separate', ['H005', 'H006'], true),
    task('trip_group_and_separate', ['H008', 'H009', 'H010'], true)
  ];

  const truth = {
    version: 'sgx-truth.1',
    reviewedBy: `accepted-dataset:${EXPECTED_DATASET_DIGEST}`,
    photos: truthPhotos,
    taskOverrides: []
  };
  const truthBytes = Buffer.from(`${JSON.stringify(truth, null, 2)}\n`);
  await writeFile(path.join(outRoot, 'truth.json'), truthBytes, { mode: 0o600 });
  const manifest = {
    version: 'sgx-eval.1',
    batchId: 'sgx_v2_product_functional_qwen20_20261002',
    status: 'ready',
    partition: 'holdout',
    provider: 'qwen',
    model: MODEL,
    providerUseReviewRef: 'chat_2026_10_01_qwen20_cny5_no_face_zero_retry',
    prices: {
      inputCnyPerMillion: 1.2,
      outputCnyPerMillion: 4.8,
      source: 'https://help.aliyun.com/zh/model-studio/qwen3-7-flash',
      checkedAt: now.toISOString()
    },
    caps,
    truth: { path: 'truth.json', sha256: sha(truthBytes) },
    photos: manifestPhotos,
    tasks
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outRoot, 'batch.json'), manifestBytes, { mode: 0o600 });
  await writeFile(path.join(outRoot, 'AUTHORIZATION_REQUEST.json'), `${JSON.stringify({
    version: 'sgx-eval-authorization-request.1',
    batchId: manifest.batchId,
    manifestHash: sha(manifestBytes),
    approvedScope: { provider: 'qwen', model: MODEL, caps, allowPersonMatching: false, automaticRetries: 0, expiresAt },
    planned: { tasks: tasks.length, photos: CASE_IDS.length, coldCacheRequests: 14 },
    authorizationEvidenceRef: manifest.providerUseReviewRef,
    datasetRootDigest: EXPECTED_DATASET_DIGEST
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(outRoot, 'README.md'), [
    '# SGX v2 产品功能真实模型批次',
    '',
    '- 目标：验证单图拒判、多模态时间角色、冲突、提示注入、多图同事件成组与相似事件分离。',
    '- 数据：独立验收通过的纯合成 v2 固定集；不代表真实家庭准确率。',
    '- 计划：7 个任务、10 张图、冷缓存上限 14 次请求；批准上限 20 次/¥5，0 自动重试，不做人脸匹配。',
    '- 停止：任一工程错误、模型版本漂移、错误合并或授权/预算变化即停止；未运行任务保留在分母。',
    '- 真值：直接转换自已验收数据集，运行后不得修改。',
    ''
  ].join('\n'), { mode: 0o600 });
  console.log(JSON.stringify({
    out: outRoot,
    datasetRootDigest: EXPECTED_DATASET_DIGEST,
    tasks: tasks.length,
    photos: CASE_IDS.length,
    coldCacheRequests: 14,
    caps,
    expiresAt,
    manifestHash: sha(manifestBytes),
    credentialsRead: false,
    externalCalls: 0
  }, null, 2));
}
