import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  SemanticScoringError,
  createScoringContext,
  scoreCasesFixture,
  scoreInput,
  sha256Bytes,
} from './semantic-scoring-v2.mjs';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = path.join(root, 'harness/classification/fixtures');
const clone = value => JSON.parse(JSON.stringify(value));
const sorted = values => [...values].sort();

async function loadFixture(name) {
  const bytes = await readFile(path.join(fixtureDir, name));
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

async function loadContext() {
  const [policy, truth, scorerBytes] = await Promise.all([
    loadFixture('semantic-scoring-policy-v2.json'),
    loadFixture('semantic-truth-v2.json'),
    readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs')),
  ]);
  return {
    policy,
    truth,
    context: createScoringContext({
      policy: policy.value,
      truth: truth.value,
      policyBytes: policy.bytes,
      truthBytes: truth.bytes,
      scorerBytes,
    }),
  };
}

function oracleView(result) {
  return {
    classifications: result.classifications,
    missingRequiredAssertionIds: result.missingRequiredAssertionIds,
    conflictStatus: result.conflictAssessment.status,
    workflowAssessment: result.workflowAssessment,
    includedInFixedDenominator: result.includedInFixedDenominator,
    observationAssessment: result.observationAssessment,
  };
}

function expectCode(code, fn) {
  assert.throws(fn, error => error instanceof SemanticScoringError && error.code === code);
}

test('E2 scorer executes every frozen E1 oracle case and emits a strict report', async () => {
  const [{ context }, cases, reportSchema] = await Promise.all([
    loadContext(),
    loadFixture('semantic-scoring-v2-cases.json'),
    loadFixture('../../../contracts/classification-semantic-score-report-v2.schema.json'),
  ]);
  const report = scoreCasesFixture(context, cases.value, { casesBytes: cases.bytes });

  assert.equal(report.oracle.total, cases.value.cases.length);
  assert.equal(report.oracle.passed, cases.value.cases.length);
  assert.equal(report.oracle.failed, 0);
  assert.equal(report.fixedDenominator.total, cases.value.cases.length);
  assert.equal(report.fixedDenominator.included, cases.value.cases.length);
  assert.equal(report.aggregateScore, null);
  assert.equal(report.functionalGate.status, 'pending_real_data_calibration');
  assert.equal(report.functionalGate.numericPassThreshold, null);
  assert.equal(report.safetyGate.maximumAllowed, 0);
  assert.equal(report.safetyGate.status, 'not_applicable_oracle_fixture');
  assert.equal(report.safetyGate.actual, null);
  assert.equal(report.safetyGate.passed, null);
  assert.equal(report.scorerRef.sourceSha256, sha256Bytes(
    await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs')),
  ));
  assert.equal(report.casesRef.sha256, sha256Bytes(cases.bytes));

  for (const expectedCase of cases.value.cases) {
    const actual = report.cases.find(entry => entry.caseId === expectedCase.caseId);
    assert.ok(actual, expectedCase.caseId);
    assert.deepEqual(oracleView(actual), expectedCase.expected, expectedCase.caseId);
  }

  const ajv = new Ajv({ allErrors: true, strictKeywords: true });
  const validate = ajv.compile(reportSchema.value);
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  const extraField = clone(report);
  extraField.unfrozenMetric = 1;
  assert.equal(validate(extraField), false);
  const inventedAggregate = clone(report);
  inventedAggregate.aggregateScore = 0.9;
  assert.equal(validate(inventedAggregate), false);
  assert.doesNotMatch(JSON.stringify(report), /"(?:accuracy|f1|f1Score)"/i);
});

test('E2 freeze binds the E1 freeze and every E2 artifact by raw bytes', async () => {
  const freezePath = path.join(root, 'docs/algorithms/evidence/CLASSIFICATION_SEMANTIC_SCORER_V2_FREEZE_2026-09-29.json');
  const freeze = JSON.parse(await readFile(freezePath, 'utf8'));
  assert.equal(
    freeze.e1SemanticFreeze.sha256,
    sha256Bytes(await readFile(path.join(root, freeze.e1SemanticFreeze.path))),
  );
  assert.equal(
    freeze.e1Cases.sha256,
    sha256Bytes(await readFile(path.join(root, freeze.e1Cases.path))),
  );
  for (const artifact of freeze.artifacts) {
    assert.equal(artifact.sha256, sha256Bytes(await readFile(path.join(root, artifact.path))), artifact.path);
  }
  assert.equal(freeze.scorer.aggregateScore, null);
  assert.equal(freeze.boundaries.readyForRealDistributionClaims, false);
});

test('normalization and aliases are directional, provenance-aware and order invariant', async () => {
  const { context } = await loadContext();
  const base = {
    workflowStatus: 'succeeded',
    predictions: [{
      predictionId: 'p-alias', facet: 'event', value: '\u3000\u5c0f\u805a\u3000',
      sourceRefs: ['asset:sgx-v3-g007:user_text:001'], evidenceKinds: ['user_text'],
    }],
    conflicts: [], observations: [],
  };
  const normalized = scoreInput(context, { caseId: 'normalization', truthItemId: 'sgx-v3-g007', input: base });
  assert.deepEqual(normalized.classifications, [{
    predictionId: 'p-alias', class: 'required_core', satisfiesAssertionId: 'truth:g007:event:gathering',
  }]);

  const conflict = {
    workflowStatus: 'needs_review',
    predictions: [
      { predictionId: 'p2', facet: 'time', value: '2010', timeRole: 'event', precision: 'year', sourceRefs: ['asset:sgx-v3-g011:final_asr:001'], evidenceKinds: ['final_asr'] },
      { predictionId: 'p1', facet: 'time', value: '2008', timeRole: 'event', precision: 'year', sourceRefs: ['asset:sgx-v3-g011:user_text:001'], evidenceKinds: ['user_text'] },
    ],
    conflicts: ['time'], observations: [],
  };
  const forward = scoreInput(context, { caseId: 'ordered-a', truthItemId: 'sgx-v3-g011', input: conflict });
  const reverse = scoreInput(context, {
    caseId: 'ordered-a', truthItemId: 'sgx-v3-g011',
    input: { ...conflict, predictions: [...conflict.predictions].reverse() },
  });
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.conflictAssessment.consumedPredictionIds, ['p1', 'p2']);
});

test('scoring is pure and does not mutate policy, truth, fixture or run input', async () => {
  const { policy, truth } = await loadContext();
  const cases = await loadFixture('semantic-scoring-v2-cases.json');
  const before = JSON.stringify({ policy: policy.value, truth: truth.value, cases: cases.value });
  const context = createScoringContext({
    policy: policy.value, truth: truth.value, policyBytes: policy.bytes, truthBytes: truth.bytes,
    scorerBytes: await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs')),
  });
  scoreCasesFixture(context, cases.value, { casesBytes: cases.bytes });
  assert.equal(JSON.stringify({ policy: policy.value, truth: truth.value, cases: cases.value }), before);
  const source = await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs'), 'utf8');
  assert.doesNotMatch(source, /g007|g011|g023|g025|groupId/);
});

test('hash and taxonomy bindings fail closed with stable codes', async () => {
  const { policy, truth } = await loadContext();
  const scorerBytes = await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs'));
  expectCode('POLICY_HASH_MISMATCH', () => createScoringContext({
    policy: policy.value, truth: truth.value, policyBytes: Buffer.from('{}'), truthBytes: truth.bytes, scorerBytes,
  }));

  const driftedTruth = clone(truth.value);
  driftedTruth.taxonomyVersion = 'classification-taxonomy.drifted';
  expectCode('TAXONOMY_VERSION_MISMATCH', () => createScoringContext({
    policy: policy.value, truth: driftedTruth, policyBytes: policy.bytes,
    truthBytes: Buffer.from(JSON.stringify(driftedTruth)), scorerBytes,
  }));

  const { context } = await loadContext();
  const cases = await loadFixture('semantic-scoring-v2-cases.json');
  const driftedCases = clone(cases.value);
  driftedCases.truthSha256 = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  expectCode('TRUTH_HASH_MISMATCH', () => scoreCasesFixture(context, driftedCases, {
    casesBytes: Buffer.from(JSON.stringify(driftedCases)),
  }));
  expectCode('CASES_BYTES_MISMATCH', () => scoreCasesFixture(context, cases.value, { casesBytes: Buffer.from('{}') }));
});

test('undecided truth and required provenance policy drift fail closed', async () => {
  const { policy, truth } = await loadContext();
  const scorerBytes = await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs'));
  const undecided = clone(truth.value);
  undecided.items[0].decisionStatus = 'pending';
  expectCode('UNDECIDED_TRUTH_ITEM', () => createScoringContext({
    policy: policy.value, truth: undecided, policyBytes: policy.bytes,
    truthBytes: Buffer.from(JSON.stringify(undecided)), scorerBytes,
  }));

  const weakenedPolicy = clone(policy.value);
  weakenedPolicy.matchPolicy.provenanceValidationPrecedesSemanticMatch = false;
  const weakenedBytes = Buffer.from(JSON.stringify(weakenedPolicy));
  const reboundTruth = clone(truth.value);
  reboundTruth.scoringPolicy.sha256 = sha256Bytes(weakenedBytes);
  expectCode('UNSUPPORTED_MATCH_POLICY', () => createScoringContext({
    policy: weakenedPolicy, truth: reboundTruth, policyBytes: weakenedBytes,
    truthBytes: Buffer.from(JSON.stringify(reboundTruth)), scorerBytes,
  }));
});

test('unknown, duplicate, excluded and ambiguous inputs fail closed with stable codes', async () => {
  const { context, policy, truth } = await loadContext();
  const scorerBytes = await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs'));
  const empty = { workflowStatus: 'succeeded', predictions: [], conflicts: [], observations: [] };
  expectCode('UNKNOWN_TRUTH_ITEM', () => scoreInput(context, { truthItemId: 'unknown', input: empty }));

  expectCode('EXCLUDED_FACET_ENABLED', () => scoreInput(context, {
    truthItemId: 'sgx-v3-g023', input: { ...empty, predictions: [{
      predictionId: 'p1', facet: 'theme', value: '家庭',
      sourceRefs: ['asset:sgx-v3-g023:photo:001'], evidenceKinds: ['visual_content'],
    }] },
  }));

  const prediction = {
    predictionId: 'p1', facet: 'scene', value: '户外',
    sourceRefs: ['asset:sgx-v3-g023:photo:001'], evidenceKinds: ['visual_content'],
  };
  expectCode('DUPLICATE_PREDICTION_ID', () => scoreInput(context, {
    truthItemId: 'sgx-v3-g023', input: { ...empty, predictions: [prediction, { ...prediction }] },
  }));
  expectCode('DUPLICATE_PREDICTION', () => scoreInput(context, {
    truthItemId: 'sgx-v3-g023', input: {
      ...empty,
      predictions: [prediction, { ...prediction, predictionId: 'p2', value: '\u3000\u6237\u5916\u3000' }],
    },
  }));

  const ambiguousTruth = clone(truth.value);
  const item = ambiguousTruth.items.find(entry => entry.itemId === 'sgx-v3-g023');
  item.requiredCore.push({ ...clone(item.requiredCore[1]), assertionId: 'truth:g023:scene:outdoor-copy' });
  ambiguousTruth.scoringPolicy.sha256 = context.policySha256;
  const ambiguousBytes = Buffer.from(JSON.stringify(ambiguousTruth));
  expectCode('AMBIGUOUS_SEMANTIC_MATCH', () => createScoringContext({
    policy: policy.value, truth: ambiguousTruth, policyBytes: policy.bytes, truthBytes: ambiguousBytes,
    scorerBytes,
  }));
});

test('one truth assertion cannot receive duplicate credit through canonical, alias or variant predictions', async () => {
  const { context } = await loadContext();
  const input = {
    workflowStatus: 'succeeded',
    predictions: [
      {
        predictionId: 'p1', facet: 'event', value: '聚会',
        sourceRefs: ['asset:sgx-v3-g007:user_text:001'], evidenceKinds: ['user_text'],
      },
      {
        predictionId: 'p2', facet: 'event', value: '小聚',
        sourceRefs: ['asset:sgx-v3-g007:user_text:001'], evidenceKinds: ['user_text'],
      },
    ],
    conflicts: [], observations: [],
  };
  expectCode('DUPLICATE_ASSERTION_CREDIT', () => scoreInput(context, {
    truthItemId: 'sgx-v3-g007', input,
  }));
});

test('failed and not_run terminal states cannot carry semantic output payloads', async () => {
  const { context } = await loadContext();
  const prediction = {
    predictionId: 'p1', facet: 'event', value: '聚会',
    sourceRefs: ['asset:sgx-v3-g007:user_text:001'], evidenceKinds: ['user_text'],
  };
  for (const workflowStatus of ['failed', 'not_run']) {
    expectCode('TERMINAL_RUN_HAS_OUTPUT', () => scoreInput(context, {
      truthItemId: 'sgx-v3-g007',
      input: { workflowStatus, predictions: [prediction], conflicts: [], observations: [] },
    }));
  }
});

test('truth semantic keys are unique across required, variant, supported, conflict and observation lanes', async () => {
  const { policy, truth } = await loadContext();
  const scorerBytes = await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs'));

  const crossLane = clone(truth.value);
  const g023 = crossLane.items.find(entry => entry.itemId === 'sgx-v3-g023');
  g023.supportedExtras.push({
    assertionId: 'truth:g023:extra:ordinary-daily-copy', facet: 'event', value: '普通日常', aliases: [],
    sourceRefs: ['asset:sgx-v3-g023:photo:001'], authority: 'visual_direct', rationale: 'duplicate lane test',
  });
  expectCode('AMBIGUOUS_TRUTH_LANE', () => createScoringContext({
    policy: policy.value, truth: crossLane, policyBytes: policy.bytes,
    truthBytes: Buffer.from(JSON.stringify(crossLane)), scorerBytes,
  }));

  const conflictCollision = clone(truth.value);
  const g011 = conflictCollision.items.find(entry => entry.itemId === 'sgx-v3-g011');
  g011.requiredCore.push({
    assertionId: 'truth:g011:time:2008-copy', facet: 'time', value: '2008', aliases: [],
    sourceRefs: ['asset:sgx-v3-g011:user_text:001'], authority: 'user_explicit',
    timeRole: 'event', precision: 'year', rationale: 'conflict lane collision test',
  });
  expectCode('AMBIGUOUS_TRUTH_LANE', () => createScoringContext({
    policy: policy.value, truth: conflictCollision, policyBytes: policy.bytes,
    truthBytes: Buffer.from(JSON.stringify(conflictCollision)), scorerBytes,
  }));

  const observationCollision = clone(truth.value);
  const g025 = observationCollision.items.find(entry => entry.itemId === 'sgx-v3-g025');
  g025.observations.push({ ...clone(g025.observations[0]), observationId: 'truth:g025:observation:visible-date-copy' });
  expectCode('DUPLICATE_TRUTH_OBSERVATION', () => createScoringContext({
    policy: policy.value, truth: observationCollision, policyBytes: policy.bytes,
    truthBytes: Buffer.from(JSON.stringify(observationCollision)), scorerBytes,
  }));
});

test('truth IDs are unique within their explicit global namespaces', async () => {
  const { policy, truth } = await loadContext();
  const scorerBytes = await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs'));
  const contextFor = changedTruth => createScoringContext({
    policy: policy.value,
    truth: changedTruth,
    policyBytes: policy.bytes,
    truthBytes: Buffer.from(JSON.stringify(changedTruth)),
    scorerBytes,
  });

  const assertionCollision = clone(truth.value);
  assertionCollision.items.find(entry => entry.itemId === 'sgx-v3-g025').supportedExtras[0].assertionId =
    assertionCollision.items.find(entry => entry.itemId === 'sgx-v3-g007').requiredCore[0].assertionId;
  expectCode('DUPLICATE_TRUTH_ASSERTION_ID', () => contextFor(assertionCollision));

  const variantCollision = clone(truth.value);
  const variantItem = variantCollision.items.find(entry => entry.itemId === 'sgx-v3-g023');
  variantItem.acceptableVariants.push({
    ...clone(variantItem.acceptableVariants[0]),
    values: ['另一种受控写法'],
  });
  expectCode('DUPLICATE_VARIANT_ID', () => contextFor(variantCollision));

  const forbiddenCollision = clone(truth.value);
  const forbiddenItem = forbiddenCollision.items.find(entry => entry.itemId === 'sgx-v3-g007');
  forbiddenItem.forbiddenAssertions[1].assertionId = forbiddenItem.forbiddenAssertions[0].assertionId;
  expectCode('DUPLICATE_TRUTH_ASSERTION_ID', () => contextFor(forbiddenCollision));

  const conflictCollision = clone(truth.value);
  const conflictItem = conflictCollision.items.find(entry => entry.itemId === 'sgx-v3-g011');
  conflictItem.conflicts.push(clone(conflictItem.conflicts[0]));
  expectCode('DUPLICATE_CONFLICT_ID', () => contextFor(conflictCollision));

  const observationCollision = clone(truth.value);
  const observationItem = observationCollision.items.find(entry => entry.itemId === 'sgx-v3-g025');
  observationItem.observations.push({
    ...clone(observationItem.observations[0]),
    normalizedValue: '另一个日期',
  });
  expectCode('DUPLICATE_TRUTH_OBSERVATION_ID', () => contextFor(observationCollision));
});

test('runtime policy classes must equal the frozen constants', async () => {
  const { policy, truth } = await loadContext();
  const scorerBytes = await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs'));
  const changedPolicy = clone(policy.value);
  changedPolicy.riskPolicy.unsupportedLowImpactClass = 'required_core';
  const changedPolicyBytes = Buffer.from(JSON.stringify(changedPolicy));
  const reboundTruth = clone(truth.value);
  reboundTruth.scoringPolicy.sha256 = sha256Bytes(changedPolicyBytes);
  expectCode('INVALID_RISK_CLASS', () => createScoringContext({
    policy: changedPolicy,
    truth: reboundTruth,
    policyBytes: changedPolicyBytes,
    truthBytes: Buffer.from(JSON.stringify(reboundTruth)),
    scorerBytes,
  }));
});

test('unmatched places require auditable placeKind and use policy risk classes', async () => {
  const { context } = await loadContext();
  const base = {
    predictionId: 'p1', facet: 'place', value: '北京',
    sourceRefs: ['asset:sgx-v3-g007:photo:001'], evidenceKinds: ['visual_content'],
  };
  const run = prediction => ({
    truthItemId: 'sgx-v3-g007',
    input: { workflowStatus: 'succeeded', predictions: [prediction], conflicts: [], observations: [] },
  });
  expectCode('PLACE_KIND_REQUIRED', () => scoreInput(context, run(base)));
  assert.equal(scoreInput(context, run({ ...base, placeKind: 'named' })).classifications[0].class,
    context.policy.riskPolicy.unsupportedHighImpactClass);
  assert.equal(scoreInput(context, run({ ...base, placeKind: 'generic', value: '室外区域' })).classifications[0].class,
    context.policy.riskPolicy.unsupportedLowImpactClass);
});

test('malformed library inputs always return SemanticScoringError', async () => {
  const { context } = await loadContext();
  const cyclic = { workflowStatus: 'succeeded', predictions: [], conflicts: [], observations: [] };
  cyclic.self = cyclic;
  expectCode('MALFORMED_SCORING_INPUT', () => scoreInput(context, {
    truthItemId: 'sgx-v3-g007', input: cyclic,
  }));
  expectCode('MALFORMED_SCORING_INPUT', () => scoreInput(context, {
    truthItemId: 'sgx-v3-g007',
    input: {
      workflowStatus: 'succeeded',
      predictions: [{
        predictionId: 'p1', facet: 'event', value: 1,
        sourceRefs: ['asset:sgx-v3-g007:user_text:001'], evidenceKinds: ['user_text'],
      }],
      conflicts: [], observations: [],
    },
  }));
});

test('multi-conflict, resolved conflict and unrecognized observations fail closed', async () => {
  const { context, policy, truth } = await loadContext();
  const scorerBytes = await readFile(path.join(root, 'harness/classification/semantic-scoring-v2.mjs'));
  const multi = clone(truth.value);
  const g011 = multi.items.find(entry => entry.itemId === 'sgx-v3-g011');
  g011.conflicts.push({ ...clone(g011.conflicts[0]), conflictId: 'truth:g011:conflict:event-year-copy' });
  expectCode('MULTIPLE_CONFLICTS_PER_FACET', () => createScoringContext({
    policy: policy.value, truth: multi, policyBytes: policy.bytes, truthBytes: Buffer.from(JSON.stringify(multi)), scorerBytes,
  }));

  const resolved = clone(truth.value);
  resolved.items.find(entry => entry.itemId === 'sgx-v3-g011').conflicts[0].resolution = 'user_corrected';
  expectCode('RESOLVED_CONFLICT_NOT_SCORABLE', () => createScoringContext({
    policy: policy.value, truth: resolved, policyBytes: policy.bytes, truthBytes: Buffer.from(JSON.stringify(resolved)), scorerBytes,
  }));

  expectCode('UNRECOGNIZED_OBSERVATION', () => scoreInput(context, {
    truthItemId: 'sgx-v3-g025',
    input: {
      workflowStatus: 'needs_review', predictions: [], conflicts: [],
      observations: [{
        observationId: 'o-unknown', facet: 'time', kind: 'visible_time_text', rawValue: '1999',
        normalizedValue: '1999', role: 'role_unknown', precision: 'year',
        sourceRefs: ['asset:sgx-v3-g025:photo:001'], evidenceKinds: ['ocr_candidate'],
      }],
    },
  }));
});

test('offline CLI writes once, validates the report and refuses overwrite', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sgx-semantic-score-'));
  const out = path.join(temp, 'run');
  const args = [
    path.join(root, 'scripts/classification-semantic-score.mjs'),
    '--policy', path.join(fixtureDir, 'semantic-scoring-policy-v2.json'),
    '--truth', path.join(fixtureDir, 'semantic-truth-v2.json'),
    '--cases', path.join(fixtureDir, 'semantic-scoring-v2-cases.json'),
    '--out', out,
  ];
  try {
    const first = await execFileAsync(process.execPath, args, { cwd: root });
    assert.match(first.stdout, /"mode": "offline_semantic_score"/);
    const report = JSON.parse(await readFile(path.join(out, 'semantic-score-report.json'), 'utf8'));
    assert.equal(report.oracle.failed, 0);
    assert.equal((await stat(out)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(out, 'semantic-score-report.json'))).mode & 0o777, 0o600);
    await assert.rejects(execFileAsync(process.execPath, args, { cwd: root }), error => {
      assert.match(error.stderr, /OUTPUT_DIRECTORY_EXISTS/);
      return true;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('offline CLI maps unreadable input to a stable access error', async () => {
  if (process.platform === 'win32') return;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sgx-semantic-score-denied-'));
  const policyCopy = path.join(temp, 'policy.json');
  await copyFile(path.join(fixtureDir, 'semantic-scoring-policy-v2.json'), policyCopy);
  await chmod(policyCopy, 0o000);
  const args = [
    path.join(root, 'scripts/classification-semantic-score.mjs'),
    '--policy', policyCopy,
    '--truth', path.join(fixtureDir, 'semantic-truth-v2.json'),
    '--cases', path.join(fixtureDir, 'semantic-scoring-v2-cases.json'),
    '--out', path.join(temp, 'run'),
  ];
  try {
    await assert.rejects(execFileAsync(process.execPath, args, { cwd: root }), error => {
      assert.match(error.stderr, /INPUT_ACCESS_DENIED/);
      return true;
    });
  } finally {
    await chmod(policyCopy, 0o600);
    await rm(temp, { recursive: true, force: true });
  }
});

test('offline CLI maps unwritable output parent to a stable access error', async () => {
  if (process.platform === 'win32') return;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sgx-semantic-score-output-denied-'));
  const args = [
    path.join(root, 'scripts/classification-semantic-score.mjs'),
    '--policy', path.join(fixtureDir, 'semantic-scoring-policy-v2.json'),
    '--truth', path.join(fixtureDir, 'semantic-truth-v2.json'),
    '--cases', path.join(fixtureDir, 'semantic-scoring-v2-cases.json'),
    '--out', path.join(temp, 'run'),
  ];
  await chmod(temp, 0o500);
  try {
    await assert.rejects(execFileAsync(process.execPath, args, { cwd: root }), error => {
      assert.match(error.stderr, /OUTPUT_ACCESS_DENIED/);
      return true;
    });
  } finally {
    await chmod(temp, 0o700);
    await rm(temp, { recursive: true, force: true });
  }
});

test('offline CLI runtime mode machine-validates placeKind and emits a hash-bound strict result', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sgx-semantic-runtime-'));
  const [policy, truth] = await Promise.all([
    loadFixture('semantic-scoring-policy-v2.json'),
    loadFixture('semantic-truth-v2.json'),
  ]);
  const runtimeRun = {
    schemaVersion: 'sgx-semantic-runtime-run.2',
    runId: 'runtime-place-named',
    claimBoundary: 'offline_runtime_input_only',
    policySha256: sha256Bytes(policy.bytes),
    truthSha256: sha256Bytes(truth.bytes),
    truthItemId: 'sgx-v3-g007',
    input: {
      workflowStatus: 'succeeded',
      predictions: [{
        predictionId: 'p-place', facet: 'place', value: '北京', placeKind: 'named',
        sourceRefs: ['asset:sgx-v3-g007:photo:001'], evidenceKinds: ['visual_content'],
      }],
      conflicts: [],
      observations: [],
    },
  };
  const runPath = path.join(temp, 'runtime-run.json');
  const runBytes = Buffer.from(`${JSON.stringify(runtimeRun, null, 2)}\n`);
  await writeFile(runPath, runBytes, { mode: 0o600 });
  const out = path.join(temp, 'valid');
  const baseArgs = [
    path.join(root, 'scripts/classification-semantic-score.mjs'),
    '--policy', path.join(fixtureDir, 'semantic-scoring-policy-v2.json'),
    '--truth', path.join(fixtureDir, 'semantic-truth-v2.json'),
  ];
  try {
    const completed = await execFileAsync(process.execPath, [...baseArgs, '--run', runPath, '--out', out], { cwd: root });
    assert.match(completed.stdout, /offline_semantic_runtime_score/);
    const resultPath = path.join(out, 'semantic-runtime-score.json');
    const envelope = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(envelope.runRef.sha256, sha256Bytes(runBytes));
    assert.equal(envelope.result.classifications[0].class, 'unsafe_false_positive');
    assert.equal((await stat(out)).mode & 0o777, 0o700);
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);

    const invalidRun = clone(runtimeRun);
    delete invalidRun.input.predictions[0].placeKind;
    const invalidPath = path.join(temp, 'runtime-run-missing-place-kind.json');
    await writeFile(invalidPath, `${JSON.stringify(invalidRun, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(
      execFileAsync(process.execPath, [...baseArgs, '--run', invalidPath, '--out', path.join(temp, 'invalid')], { cwd: root }),
      error => {
        assert.match(error.stderr, /INVALID_RUNTIME_CONTRACT/);
        return true;
      },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
