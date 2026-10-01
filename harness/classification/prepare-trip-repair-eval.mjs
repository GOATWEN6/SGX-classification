import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_MANIFEST_HASH = 'sha256:5f26a3339b37d8a440c59a790fc8edfd84a661b38b4b3eda1730bea384ad0deb';
const DATASET_DIGEST = 'sha256:2d18d96933f5c85454357eedee45cb185c9ad5eefac6f21e513ce0166ded0f2a';
const MODEL = 'qwen3.7-flash-2026-07-15';
const PHOTO_IDS = ['SGX-V2-H008', 'SGX-V2-H009', 'SGX-V2-H010'];
const PRIOR_USAGE = { requests: 14, costCny: 0.122226 };
const CUMULATIVE_CAPS = { maxRequests: 20, maxCostCny: 5 };

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const source = option('--source-batch');
const out = option('--out');
const nowValue = option('--now');
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

if(args.includes('--help') || !source || !out) {
  console.log([
    '准备 sgx-five-facets.13 三图旅行定点复测（离线，不读凭据、不联网）：',
    'node harness/classification/prepare-trip-repair-eval.mjs \\',
    '  --source-batch /absolute/sgx_v2_product_functional_qwen20_20261002 \\',
    '  --out /absolute/new-batch-dir [--now 2026-10-02T12:00:00+08:00]'
  ].join('\n'));
  process.exitCode = args.includes('--help') ? 0 : 2;
} else {
  const sourceRoot = path.resolve(source);
  const outRoot = path.resolve(out);
  const now = nowValue ? new Date(nowValue) : new Date();
  if(!Number.isFinite(now.getTime())) throw new Error('INVALID_NOW');
  try { await stat(outRoot); throw new Error('OUTPUT_EXISTS'); }
  catch(error) { if(error.code !== 'ENOENT') throw error; }

  const sourceManifestBytes = await readFile(path.join(sourceRoot, 'batch.json'));
  if(sha(sourceManifestBytes) !== SOURCE_MANIFEST_HASH) throw new Error('SOURCE_MANIFEST_CHANGED');
  const sourceManifest = JSON.parse(sourceManifestBytes);
  const sourceTruth = JSON.parse(await readFile(path.join(sourceRoot, 'truth.json'), 'utf8'));
  const sourceLedger = JSON.parse(await readFile(path.join(sourceRoot, 'run', 'ledger.json'), 'utf8'));
  if(sourceLedger.totals?.requests !== PRIOR_USAGE.requests
    || Math.abs(sourceLedger.totals?.costCny - PRIOR_USAGE.costCny) > 1e-9
    || sourceLedger.completedEntries !== sourceLedger.plannedTasks) {
    throw new Error('PRIOR_USAGE_MISMATCH');
  }

  const sourceTask = sourceManifest.tasks.find(task => task.taskId === 'trip_group_and_separate');
  const photos = sourceManifest.photos.filter(item => PHOTO_IDS.includes(item.photo.photoId));
  const truthPhotos = sourceTruth.photos.filter(item => PHOTO_IDS.includes(item.photoId));
  if(!sourceTask || photos.length !== 3 || truthPhotos.length !== 3) throw new Error('TRIP_FIXTURE_INCOMPLETE');
  if(sourceTask.request.photos.map(photo => photo.photoId).join(',') !== PHOTO_IDS.join(',')) throw new Error('TRIP_TASK_CHANGED');

  await mkdir(path.join(outRoot, 'images'), { recursive: true, mode: 0o700 });
  for(const item of photos) {
    const filename = path.basename(item.path);
    const sourceImage = path.join(sourceRoot, item.path);
    const bytes = await readFile(sourceImage);
    if(sha(bytes) !== item.photo.sourceHash) throw new Error(`PHOTO_HASH_MISMATCH_${item.photo.photoId}`);
    await copyFile(sourceImage, path.join(outRoot, 'images', filename));
    item.path = `images/${filename}`;
  }

  const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
  const caps = {
    maxRequests: 6,
    maxInputTokens: 300_000,
    maxOutputTokens: 16_000,
    maxCostCny: 1,
    maxDurationSeconds: 1200,
    maxRetries: 0
  };
  const request = structuredClone(sourceTask.request);
  request.runId = 'product_trip_repair_prompt13_20261002';
  request.authorizationRevision = 'approved_trip_repair_prompt13_20261002';
  request.budget = {
    ...request.budget,
    maxRequests: caps.maxRequests,
    maxInputTokens: caps.maxInputTokens,
    maxOutputTokens: caps.maxOutputTokens,
    maxCostCny: caps.maxCostCny,
    deadlineAt: expiresAt,
    maxCallDurationMs: 60_000
  };
  const task = {
    taskId: 'trip_group_and_separate_prompt13',
    request,
    evaluatePhotoIds: PHOTO_IDS,
    expectedUnchangedPhotoIds: [],
    evaluation: { facets: ['event'], personPairs: false, eventPairs: true, identityCandidates: false }
  };

  const truth = {
    version: 'sgx-truth.1',
    reviewedBy: `repair-subset-of:${SOURCE_MANIFEST_HASH}`,
    photos: truthPhotos,
    taskOverrides: []
  };
  const truthBytes = Buffer.from(`${JSON.stringify(truth, null, 2)}\n`);
  await writeFile(path.join(outRoot, 'truth.json'), truthBytes, { mode: 0o600 });
  const authorizationEvidenceRef = 'chat_2026_10_02_qwen20_cny5_cumulative_no_face_zero_retry';
  const manifest = {
    version: 'sgx-eval.1',
    batchId: 'sgx_v2_trip_repair_prompt13_qwen6_20261002',
    status: 'ready',
    partition: 'holdout',
    provider: 'qwen',
    model: MODEL,
    providerUseReviewRef: authorizationEvidenceRef,
    prices: {
      inputCnyPerMillion: sourceManifest.prices.inputCnyPerMillion,
      outputCnyPerMillion: sourceManifest.prices.outputCnyPerMillion,
      source: sourceManifest.prices.source,
      checkedAt: now.toISOString()
    },
    caps,
    truth: { path: 'truth.json', sha256: sha(truthBytes) },
    photos,
    tasks: [task]
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestHash = sha(manifestBytes);
  await writeFile(path.join(outRoot, 'batch.json'), manifestBytes, { mode: 0o600 });
  await writeFile(path.join(outRoot, 'AUTHORIZATION_REQUEST.json'), `${JSON.stringify({
    version: 'sgx-eval-authorization-request.1',
    batchId: manifest.batchId,
    manifestHash,
    approvedScope: { provider: 'qwen', model: MODEL, caps, allowPersonMatching: false, automaticRetries: 0, expiresAt },
    planned: { tasks: 1, photos: 3, coldCacheRequests: 6 },
    priorUsage: PRIOR_USAGE,
    cumulativeCaps: CUMULATIVE_CAPS,
    cumulativeWorstCase: { requests: PRIOR_USAGE.requests + caps.maxRequests, costCny: PRIOR_USAGE.costCny + caps.maxCostCny },
    authorizationEvidenceRef,
    datasetRootDigest: DATASET_DIGEST,
    sourceManifestHash: SOURCE_MANIFEST_HASH
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(outRoot, 'README.md'), [
    '# SGX 三图旅行定点复测',
    '',
    '- 唯一目标：验证同一趟三天旅行 H008/H009 自动成组，次年另一趟 H010 保持独立。',
    '- 本批上限：6 次、¥1、0 自动重试、不做人脸匹配。',
    `- 前批已使用：${PRIOR_USAGE.requests} 次、¥${PRIOR_USAGE.costCny}；两批累计硬上限仍为 20 次、¥5。`,
    '- 评分只启用 event 与 eventPairs，避免已知有缺陷的时间/地点真值干扰本轮唯一判断。',
    '- 数据仍为已验收合成集；结果不代表真实家庭准确率或生产验收。',
    ''
  ].join('\n'), { mode: 0o600 });
  console.log(JSON.stringify({
    out: outRoot,
    batchId: manifest.batchId,
    datasetRootDigest: DATASET_DIGEST,
    manifestHash,
    priorUsage: PRIOR_USAGE,
    caps,
    cumulativeWorstCase: { requests: 20, costCny: PRIOR_USAGE.costCny + caps.maxCostCny },
    expiresAt,
    credentialsRead: false,
    externalCalls: 0
  }, null, 2));
}
