#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CONTROLLED_EVENTS = new Set(['求学','毕业','工作','婚礼','生日','节庆','旅行','搬家','退休','家庭聚会','兴趣活动','纪念事件','其他']);
const CONTROLLED_SCENES = new Set(['室内','室内家庭','校园','工作场所','户外','交通','庆典','自然景观','其他']);

const textSupport = photo => {
  const evidence = photo.textEvidence?.[0];
  if(!evidence) return undefined;
  return { photoId: photo.photoId, source: evidence.source, evidenceId: evidence.evidenceId, quote: evidence.text.slice(0, 512) };
};
const visualSupport = photo => ({ photoId: photo.photoId, source: 'visual', quote: 'synthetic fixture visual expectation' });

function decodeTime(encoded) {
  const match = encoded.match(/^event:(date|year|decade|relative):(.+)$/);
  if(!match) return undefined;
  return { value: match[2], precision: match[1], role: 'event' };
}

export function buildOracleObservation(photo, truth) {
  const text = textSupport(photo);
  const visual = visualSupport(photo);
  const times = truth.facets.time.map(item => decodeTime(item.value)).filter(Boolean).filter(item => {
    if(!text) return false;
    if(item.precision === 'relative') return true;
    return text.quote.includes(item.value) || text.quote.includes(item.value.slice(0, 4));
  }).map(item => ({ ...item, supports: [text] }));
  const places = truth.facets.place.map(item => ({ label: item.value, supports: [text ?? visual] }));
  const events = truth.facets.event.filter(item => CONTROLLED_EVENTS.has(item.value)).map(item => ({ type: item.value, supports: [text ?? visual] }));
  const scenes = truth.facets.scene.filter(item => CONTROLLED_SCENES.has(item.value)).map(item => ({ label: item.value, supports: [visual] }));
  const mentions = [];
  const unknownFacets = [];
  if(!mentions.length) unknownFacets.push('person');
  if(!times.length) unknownFacets.push('time');
  if(!places.length) unknownFacets.push('place');
  if(!events.length) unknownFacets.push('event');
  if(!scenes.length) unknownFacets.push('scene');
  return { photoId: photo.photoId, people: [], mentions, times, places, events, scenes, unknownFacets, conflicts: truth.expectedConflicts };
}

export function evaluateDiagnosticPlan(plan, groupsById) {
  const results = [];
  for(const run of plan.runs) {
    const groups = run.groupIds.map(id => groupsById.get(id)).filter(Boolean);
    const errors = [];
    if(groups.length !== run.groupIds.length) errors.push('GROUP_MISSING');
    if(groups.some(group => group.partition !== run.partition)) errors.push('PARTITION_MISMATCH');
    if(new Set(groups.map(group => group.envelope.scope.householdId)).size > 1) errors.push('CROSS_SCOPE_BATCH');
    if(run.kind === 'large_batch') {
      const imageCount = groups.flatMap(group => group.envelope.evidence.filter(item => item.modality === 'image' && item.lifecycleState === 'active')).length;
      if(imageCount < 5 || imageCount > 10) errors.push('LARGE_BATCH_IMAGE_COUNT');
    }
    results.push({ runId: run.runId, partition: run.partition, kind: run.kind, status: errors.length ? 'failed' : 'passed', errors });
  }
  return results;
}

async function compileClassification() {
  const build = await mkdtemp(path.join(tmpdir(), 'sgx-v31-mock-'));
  await symlink(path.join(root, 'node_modules'), path.join(build, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = (await readdir(path.join(root, 'src/lib/algorithms/classification'))).filter(file => file.endsWith('.ts')).map(file => `src/lib/algorithms/classification/${file}`);
  const compile = spawnSync(process.execPath, [
    'node_modules/typescript/bin/tsc', '--outDir', build, '--rootDir', '.', '--module', 'commonjs', '--moduleResolution', 'node',
    '--target', 'es2022', '--lib', 'es2022,dom', '--esModuleInterop', '--resolveJsonModule', '--strict', '--skipLibCheck',
    '--noEmit', 'false', '--incremental', 'false', ...files
  ], { cwd: root, stdio: 'inherit' });
  if(compile.error) throw compile.error;
  if(compile.status !== 0) throw new Error('SYNTHETIC_V31_MOCK_COMPILE_FAILED');
  return build;
}

async function exists(filename) {
  try { await lstat(filename); return true; } catch(error) { if(error?.code === 'ENOENT') return false; throw error; }
}

export async function runSyntheticV31Mock(datasetDirectory, adaptedDirectory, outputDirectory) {
  const output = path.resolve(outputDirectory);
  if(await exists(output)) throw new Error('OUTPUT_DIRECTORY_EXISTS');
  const dataset = path.resolve(datasetDirectory);
  const adapted = path.resolve(adaptedDirectory);
  const ready = JSON.parse(await readFile(path.join(dataset, 'READY_FOR_ACCEPTANCE.json'), 'utf8'));
  const adapterReport = JSON.parse(await readFile(path.join(adapted, 'adapter-report.json'), 'utf8'));
  if(ready.datasetRootDigest !== adapterReport.checksumManifestHash) throw new Error('DATASET_DIGEST_MISMATCH');
  if(ready.planned !== 40 || adapterReport.fixedDenominator.ingestionGroups !== 40) throw new Error('FIXED_DENOMINATOR_MISMATCH');
  const diagnostics = JSON.parse(await readFile(path.join(dataset, 'diagnostics/diagnostic-runs.json'), 'utf8'));
  const build = await compileClassification();
  const staging = await mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.tmp-`));
  try {
    const require = createRequire(import.meta.url);
    const { ClassificationEngine, MemorySnapshotStore } = require(path.join(build, 'src/lib/algorithms/classification/stage-a-pipeline.js'));
    const { digest, photoHash, StageError } = require(path.join(build, 'src/lib/algorithms/classification/stage-a-contract.js'));
    const groups = [];
    for(const route of adapterReport.routing) {
      const envelope = JSON.parse(await readFile(path.join(adapted, 'ingestion', `${route.groupId}.json`), 'utf8'));
      groups.push({ ...route, envelope });
    }
    const groupsById = new Map(groups.map(group => [group.groupId, group]));
    const stageResults = [];
    const truthByPhoto = new Map();
    const requestByGroup = new Map();
    const tasks = [];
    for(const partition of ['exploration', 't1-validation']) {
      const directory = path.join(adapted, 'stage-a', partition);
      const batch = JSON.parse(await readFile(path.join(directory, 'batch.json'), 'utf8'));
      const truth = JSON.parse(await readFile(path.join(directory, 'truth.json'), 'utf8'));
      for(const item of truth.photos) truthByPhoto.set(item.photoId, item);
      for(const task of batch.tasks) {
        const groupId = task.taskId.replace(/^task-/, '');
        requestByGroup.set(groupId, task.request);
        tasks.push({ partition, groupId, task });
      }
    }
    const makeProvider = ({ failPhotoId, failCode = 'INVALID_OUTPUT' } = {}) => {
      const calls = [];
      const provider = {
        version: 'synthetic-oracle-mock.1', mode: 'mock_transport', inputCnyPerMillion: 0, outputCnyPerMillion: 0,
        async invoke(call, signal) {
          if(signal.aborted) throw new Error('CANCELLED');
          calls.push({ stage: call.stage, photoIds: call.photos.map(photo => photo.photoId) });
          if(call.stage === 'extract') {
            if(failPhotoId && call.photos.some(photo => photo.photoId === failPhotoId)) throw new StageError(failCode);
            return {
              value: { observations: call.photos.map(photo => buildOracleObservation(photo, truthByPhoto.get(photo.photoId))) },
              usage: { inputTokens: 1, outputTokens: 1 }, responseId: `mock-extract-${call.photos[0].photoId}`, model: 'synthetic-oracle-mock.1'
            };
          }
          const [left, right] = call.photos;
          const leftTruth = truthByPhoto.get(left.photoId); const rightTruth = truthByPhoto.get(right.photoId);
          const decision = leftTruth.expectedConflicts.includes('event') || rightTruth.expectedConflicts.includes('event')
            ? 'unknown' : leftTruth.eventInstance === rightTruth.eventInstance ? 'same' : 'different';
          return {
            value: { relations: [{ kind: 'event', left: { photoId: left.photoId }, right: { photoId: right.photoId }, decision, supports: [visualSupport(left), visualSupport(right)], rationale: 'synthetic fixture event-instance oracle for pipeline testing' }] },
            usage: { inputTokens: 1, outputTokens: 1 }, responseId: `mock-relate-${left.photoId}-${right.photoId}`, model: 'synthetic-oracle-mock.1'
          };
        }
      };
      return { provider, calls };
    };
    const runRequest = async (rawRequest, provider, store = new MemorySnapshotStore()) => {
      const request = structuredClone(rawRequest);
      request.budget.deadlineAt = new Date(Date.now() + 60_000).toISOString();
      const auth = {
          scope: request.scope,
          authorizationRevision: request.authorizationRevision,
          allowedPhotoIds: request.photos.filter(photo => photo.active).map(photo => photo.photoId),
          allowPersonMatching: false,
          photoVersions: Object.fromEntries(request.photos.filter(photo => photo.active).map(photo => [photo.photoId, photoHash(photo)])),
          contextRevision: 'synthetic-v31-mock.1',
          reviewContextHash: digest([request.references, request.corrections]),
          active: true
      };
      return new ClassificationEngine(provider, store).process(request, () => auth);
    };
    const baseProvider = makeProvider();
    for(const { partition, groupId, task } of tasks) {
      const result = await runRequest(task.request, baseProvider.provider);
      stageResults.push({ partition, taskId: task.taskId, groupId, workflowStatus: result.workflowStatus, changedPhotoIds: result.changedPhotoIds, reviewItems: result.reviewItems, errors: result.errors, usage: result.usage });
    }
    const contentOrganization = groups.filter(group => group.route === 'content_organization_only').map(group => ({
      groupId: group.groupId,
      status: group.contentOrganizationEvidenceIds.length > 0 && group.envelope.contents.every(item => item.lifecycleState === 'active') ? 'passed' : 'failed',
      evidenceIds: group.contentOrganizationEvidenceIds
    }));
    const withdrawal = groups.filter(group => group.route === 'withdrawn').map(group => ({
      groupId: group.groupId,
      status: group.envelope.evidence.every(item => item.lifecycleState !== 'active') && group.envelope.bindings.length === 0 ? 'passed' : 'failed'
    }));
    const mergeRequests = (run, selectedPhotos) => {
      const requests = run.groupIds.map(id => requestByGroup.get(id)).filter(Boolean);
      if(!requests.length) throw new Error(`DIAGNOSTIC_REQUEST_MISSING:${run.runId}`);
      const photos = selectedPhotos ?? requests.flatMap(request => request.photos);
      return {
        ...structuredClone(requests[0]), runId: `run-${run.runId}`, authorizationRevision: `synthetic-diag-auth-${run.runId.replace(/[ab]$/, '')}`,
        photos, references: [], corrections: [], trigger: 'upload',
        budget: { ...requests[0].budget, maxRequests: 1000, maxInputTokens: 100000000, maxOutputTokens: 10000000, maxCostCny: 0 }
      };
    };
    const diagnosticResults = [];
    const sequenceState = new Map();
    for(const run of diagnostics.runs) {
      const structural = evaluateDiagnosticPlan({ runs: [run] }, groupsById)[0];
      const assertions = [];
      const errors = [...structural.errors];
      let workflowStatus = 'not_run';
      let inputDigest = digest(run);
      if(!errors.length && run.kind === 'large_batch') {
        const baseRequest = mergeRequests(run);
        const failurePhotoId = run.failureInjection ? baseRequest.photos.find(photo => photo.sourceRef === run.failureInjection.assetId.replace(/[^A-Za-z0-9_-]/g, '_'))?.photoId : undefined;
        const controlled = makeProvider({ failPhotoId: failurePhotoId, failCode: run.failureInjection?.code });
        const result = await runRequest(baseRequest, controlled.provider);
        workflowStatus = result.workflowStatus;
        inputDigest = digest([run, baseRequest.photos.map(photo => photo.sourceHash)]);
        if(run.failureInjection) {
          const expectedError = result.errors.some(error => error.code === run.failureInjection.code && error.photoIds.includes(failurePhotoId));
          const observed = Object.keys(result.snapshot?.observations ?? {}).length;
          const isolated = expectedError && observed === baseRequest.photos.length - 1 && result.workflowStatus === 'needs_review';
          assertions.push({ name: 'partial_failure_isolated', passed: isolated, observedSuccessfulPhotos: observed, expectedFailedPhotoId: failurePhotoId, expectedError, workflowStatus: result.workflowStatus, engineErrors: result.errors });
          if(!isolated) errors.push('PARTIAL_FAILURE_NOT_ISOLATED');
        } else if(result.workflowStatus === 'failed' || result.errors.length) {
          errors.push('LARGE_BATCH_ENGINE_FAILURE');
        }
        assertions.push({ name: 'bounded_requests', passed: result.usage.requests <= baseRequest.budget.maxRequests, requests: result.usage.requests });
        if(run.crossScopeProbeGroupId) {
          const probe = requestByGroup.get(run.crossScopeProbeGroupId)?.photos[0];
          const before = controlled.calls.length;
          const forged = { ...baseRequest, runId: `${baseRequest.runId}-cross-scope`, photos: [...baseRequest.photos, probe] };
          const rejected = await runRequest(forged, controlled.provider);
          const passed = rejected.workflowStatus === 'failed' && rejected.errors.some(error => error.code === 'CROSS_SCOPE') && controlled.calls.length === before;
          assertions.push({ name: 'cross_scope_probe_rejected_before_provider', passed });
          if(!passed) errors.push('CROSS_SCOPE_PROBE_NOT_REJECTED');
        }
      } else if(!errors.length) {
        const key = run.runId.replace(/[ab]$/, '');
        const state = sequenceState.get(key) ?? { store: new MemorySnapshotStore(), previousPhotoIds: [] };
        const allPhotos = run.groupIds.flatMap(id => requestByGroup.get(id)?.photos ?? []);
        const selectedPhotos = run.assetSelectors?.includes('all') ? allPhotos : allPhotos.filter(photo => run.assetSelectors?.some(selector => photo.photoId.endsWith(selector.replace(':', '_'))));
        const request = mergeRequests(run, selectedPhotos);
        request.authorizationRevision = `synthetic-diag-auth-${key}`;
        const controlled = makeProvider();
        const result = await runRequest(request, controlled.provider, state.store);
        workflowStatus = result.workflowStatus;
        inputDigest = digest([run, request.photos.map(photo => photo.sourceHash)]);
        if(result.workflowStatus === 'failed' || result.errors.length) errors.push('INCREMENTAL_ENGINE_FAILURE');
        if(run.phase === 2) {
          const expectedChanged = selectedPhotos.map(photo => photo.photoId).filter(id => !state.previousPhotoIds.includes(id)).sort();
          const stable = JSON.stringify([...result.changedPhotoIds].sort()) === JSON.stringify(expectedChanged);
          assertions.push({ name: 'unchanged_digest_stable', passed: stable, expectedChanged, actualChanged: [...result.changedPhotoIds].sort() });
          if(!stable) errors.push('UNCHANGED_CONTENT_REEXTRACTED');
          const eventGroups = result.snapshot?.groups.filter(group => group.kind === 'event').map(group => group.members.map(member => member.photoId)) ?? [];
          if(run.invariants.includes('different_events_not_merged')) {
            const merged = eventGroups.some(members => selectedPhotos.every(photo => members.includes(photo.photoId)));
            assertions.push({ name: 'different_events_not_merged', passed: !merged });
            if(merged) errors.push('DIFFERENT_EVENTS_MERGED');
          } else {
            const grouped = eventGroups.some(members => selectedPhotos.every(photo => members.includes(photo.photoId)));
            assertions.push({ name: 'same_story_grouped', passed: grouped });
            if(!grouped) errors.push('SAME_STORY_NOT_GROUPED');
          }
        }
        state.previousPhotoIds = selectedPhotos.map(photo => photo.photoId);
        sequenceState.set(key, state);
      }
      diagnosticResults.push({ runId: run.runId, partition: run.partition, kind: run.kind, inputDigest, workflowStatus, status: errors.length ? 'failed' : 'passed', assertions, errors });
    }
    const failures = [
      ...stageResults.filter(item => item.workflowStatus === 'failed' || item.errors.length).map(item => ({ kind: 'stage_a', id: item.taskId, errors: item.errors })),
      ...contentOrganization.filter(item => item.status !== 'passed').map(item => ({ kind: 'content_organization', id: item.groupId })),
      ...withdrawal.filter(item => item.status !== 'passed').map(item => ({ kind: 'withdrawal', id: item.groupId })),
      ...diagnosticResults.filter(item => item.status !== 'passed').map(item => ({ kind: 'diagnostic', id: item.runId, errors: item.errors }))
    ];
    const report = {
      schemaVersion: 'sgx-synthetic-v31-mock-report.1', datasetId: ready.datasetId, datasetRootDigest: ready.datasetRootDigest,
      claimBoundary: 'synthetic_contract_and_pipeline_function_only', provider: 'synthetic-oracle-mock.1', externalCalls: 0, credentialsRead: false,
      fixedDenominator: { groups: 40, stageA: stageResults.length, contentOrganization: contentOrganization.length, withdrawal: withdrawal.length, diagnostics: diagnosticResults.length },
      status: failures.length ? 'failed' : 'passed', failures,
      stageA: stageResults, contentOrganization, withdrawal, diagnostics: diagnosticResults,
      warning: 'The oracle Mock uses frozen synthetic truth to exercise integration. It is not model accuracy, real-world accuracy, or product-effect evidence.'
    };
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, 'MOCK_REPORT.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(staging, 'MOCK_REPORT.md'), [
      '# SGX synthetic v3.1 deterministic Mock report', '',
      `- Status: **${report.status.toUpperCase()}**`,
      `- Dataset digest: \`${ready.datasetRootDigest}\``,
      `- Fixed denominator: 40 groups = ${stageResults.length} Stage A + ${contentOrganization.length} content organization + ${withdrawal.length} withdrawal`,
      `- Diagnostic runs: ${diagnosticResults.filter(item => item.status === 'passed').length}/${diagnosticResults.length}`,
      `- External calls: 0`, `- Credentials read: false`, '',
      '该结果只证明冻结合成夹具可以经过当前契约、路由、ClassificationEngine、生命周期和诊断检查；不表示真实模型准确率或真实产品效果。', ''
    ].join('\n'), { mode: 0o600 });
    await rename(staging, output);
    return report;
  } catch(error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if(args.includes('--help') || !option('--dataset') || !option('--adapted') || !option('--out')) {
    console.log('node harness/classification/synthetic-v31-mock.mjs --dataset /absolute/v3.1 --adapted /absolute/adapter-output --out /absolute/new-report-dir');
    process.exitCode = args.includes('--help') ? 0 : 2;
    return;
  }
  const report = await runSyntheticV31Mock(option('--dataset'), option('--adapted'), option('--out'));
  console.log(JSON.stringify({ out: path.resolve(option('--out')), status: report.status, fixedDenominator: report.fixedDenominator, failures: report.failures.length }, null, 2));
}

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
