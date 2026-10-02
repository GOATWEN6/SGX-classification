import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const buildDir = process.env.CLASSIFICATION_BUILD_DIR;
if (!buildDir) throw new Error('CLASSIFICATION_BUILD_DIR_REQUIRED');

const { adaptStageAForOrganization } = require(
  path.join(buildDir, 'src/lib/algorithms/classification/stage-a-organization-adapter.js')
);
const { organizeSparseContent } = require(
  path.join(buildDir, 'src/lib/algorithms/classification/content-organization.js')
);
const {
  buildActiveEvidenceRulePolicy,
  collectEvidenceRuleReviewItems
} = require(
  path.join(buildDir, 'src/lib/algorithms/classification/evidence-rule-policy.js')
);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag.slice(2).toUpperCase()}_REQUIRED`);
  return path.resolve(process.argv[index + 1]);
}

function markdown(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const runDir = valueAfter('--run');
const manifest = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
const createdAt = '2026-10-02T00:00:00.000Z';
const tasks = [];

for (const task of manifest.tasks) {
  const stageResult = JSON.parse(await readFile(path.join(runDir, `result-${task.taskId}.json`), 'utf8'));
  const trustedOriginalCaptureEvidenceIds = task.request.photos
    .filter(photo => photo.exif?.originalCapture && photo.exif?.capturedAt)
    .map(photo => photo.photoId);
  const adapted = adaptStageAForOrganization({
    request: task.request,
    result: stageResult,
    createdAt,
    trustedOriginalCaptureEvidenceIds,
    placeKindPolicy: { genericLabels: ['家中', '室内', '户外'] },
    allowPersonMatching: false
  });
  const organized = organizeSparseContent({
    schemaVersion: '2.0',
    contractVersion: 'classification-hybrid.2',
    scope: task.request.scope,
    contents: adapted.contents,
    observations: adapted.observations,
    retrievalCandidates: adapted.retrievalCandidates,
    explicitAssociations: adapted.explicitAssociations,
    decisionPolicy: buildActiveEvidenceRulePolicy({
      maxCandidatesPerContent: task.request.budget.candidatesPerPhoto,
      createdAt
    }),
    createdAt
  });
  tasks.push({
    taskId: task.taskId,
    stageWorkflowStatus: stageResult.workflowStatus,
    stories: organized.stories,
    associations: organized.associations,
    decisionResults: organized.decisionResults,
    reviewItems: collectEvidenceRuleReviewItems(
      stageResult.reviewItems,
      adapted.reviewItems,
      organized.reviewItems
    ),
    unresolvedTemporalObservations: adapted.unresolvedTemporalObservations,
    audit: adapted.audit
  });
}

const output = {
  version: 'stage-a-product-replay.1',
  evidenceStatus: 'offline_replay_of_real_api_results',
  batchId: manifest.batchId,
  model: manifest.model,
  promptVersion: tasks[0]?.audit.modelVersion,
  generatedAt: createdAt,
  claimBoundary: '合成数据上的产品功能探索；不是现实家庭准确率、人物识别效果或生产验收。',
  tasks
};

const jsonPath = path.join(runDir, 'PRODUCT_RESULTS.json');
await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });

const lines = [
  '# 真实模型结果的产品组织离线回放',
  '',
  `- 批次：\`${manifest.batchId}\``,
  `- 模型：\`${manifest.model}\``,
  '- 数据边界：合成数据上的产品功能探索，不代表现实家庭准确率或生产验收。',
  '- 费用：本步骤只重放已经保存的真实 API 结果，没有新增模型调用或费用。',
  '',
  '|任务|Stage A 状态|故事卡|标题与成员|待确认项|',
  '|---|---|---:|---|---:|'
];
for (const task of tasks) {
  const stories = task.stories.map(story => `${story.titleCandidate} [${story.memberContentIds.join(', ')}]`).join('；');
  lines.push(`|${markdown(task.taskId)}|${markdown(task.stageWorkflowStatus)}|${task.stories.length}|${markdown(stories)}|${task.reviewItems.length}|`);
}
lines.push('', '详细结构、证据引用、关系决策和 unresolved time 见 `PRODUCT_RESULTS.json`。', '');
const reportPath = path.join(runDir, 'PRODUCT_REPORT.md');
await writeFile(reportPath, `${lines.join('\n')}\n`, { flag: 'wx' });

console.log(JSON.stringify({ runDir, jsonPath, reportPath, tasks: tasks.length }));
