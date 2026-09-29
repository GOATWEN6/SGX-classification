#!/usr/bin/env node

import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCORER_VERSION,
  SemanticScoringError,
  createScoringContext,
  scoreCasesFixture,
  scoreInput,
  sha256Bytes,
} from '../harness/classification/semantic-scoring-v2.mjs';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const allowed = new Set(['--policy', '--truth', '--cases', '--run', '--out']);

function usage() {
  console.log([
    '离线语义评分：',
    'Oracle 一致性：',
    'npm run classification:semantic-score -- --policy /absolute/policy.json --truth /absolute/truth.json --cases /absolute/cases.json --out /absolute/new-output-directory',
    '',
    '单次 runtime 输入：',
    'npm run classification:semantic-score -- --policy /absolute/policy.json --truth /absolute/truth.json --run /absolute/runtime-run.json --out /absolute/new-output-directory',
    '',
    '命令只读取给定的冻结文件，不读取密钥、不联网，并拒绝覆盖已存在的输出目录。',
  ].join('\n'));
}

function parseOptions() {
  if (args.includes('--help')) return null;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!allowed.has(key)) throw new SemanticScoringError('UNKNOWN_OPTION');
    if (!value || value.startsWith('--')) throw new SemanticScoringError('MISSING_OPTION_VALUE');
    if (options[key]) throw new SemanticScoringError('DUPLICATE_OPTION');
    options[key] = value;
  }
  for (const key of ['--policy', '--truth', '--out']) {
    if (!options[key]) throw new SemanticScoringError('MISSING_REQUIRED_OPTION');
    if (!path.isAbsolute(options[key])) throw new SemanticScoringError('ABSOLUTE_PATH_REQUIRED');
  }
  const inputModes = ['--cases', '--run'].filter(key => options[key]);
  if (inputModes.length !== 1) throw new SemanticScoringError('EXACTLY_ONE_INPUT_MODE_REQUIRED');
  if (!path.isAbsolute(options[inputModes[0]])) throw new SemanticScoringError('ABSOLUTE_PATH_REQUIRED');
  return options;
}

async function loadJsonWithBytes(filePath, invalidCode) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error?.code)) throw new SemanticScoringError('INPUT_ACCESS_DENIED');
    throw error;
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new SemanticScoringError(invalidCode);
  }
}

async function schemaValidators() {
  const relativePaths = [
    'contracts/classification-scoring-policy-v2.schema.json',
    'contracts/classification-truth-v2.schema.json',
    'contracts/classification-semantic-scoring-cases-v2.schema.json',
    'contracts/classification-semantic-score-report-v2.schema.json',
    'contracts/classification-semantic-runtime-v2.schema.json',
  ];
  const schemas = await Promise.all(relativePaths.map(async relativePath =>
    JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))));
  const ajv = new Ajv({ allErrors: true, strictKeywords: true });
  for (const schema of schemas) ajv.addSchema(schema);
  const byTitle = Object.fromEntries(schemas.map(schema => [schema.title, ajv.getSchema(schema.$id)]));
  return {
    policy: byTitle['SGX classification semantic scoring policy v2'],
    truth: byTitle['SGX classification semantic truth v2'],
    cases: byTitle['SGX classification semantic scoring cases v2'],
    report: byTitle['SGX classification semantic score report v2'],
    runtime: byTitle['SGX classification semantic runtime run and result v2'],
  };
}

function requireValid(validate, value, code) {
  if (!validate(value)) throw new SemanticScoringError(code);
}

try {
  const options = parseOptions();
  if (!options) {
    usage();
  } else {
    const mode = options['--cases'] ? 'oracle' : 'runtime';
    const inputPath = options[mode === 'oracle' ? '--cases' : '--run'];
    const scorerSourcePath = path.join(root, 'harness/classification/semantic-scoring-v2.mjs');
    const [policy, truth, document, scorerBytes, validators] = await Promise.all([
      loadJsonWithBytes(options['--policy'], 'INVALID_POLICY_JSON'),
      loadJsonWithBytes(options['--truth'], 'INVALID_TRUTH_JSON'),
      loadJsonWithBytes(inputPath, mode === 'oracle' ? 'INVALID_CASES_JSON' : 'INVALID_RUNTIME_JSON'),
      readFile(scorerSourcePath),
      schemaValidators(),
    ]);
    requireValid(validators.policy, policy.value, 'INVALID_POLICY_CONTRACT');
    requireValid(validators.truth, truth.value, 'INVALID_TRUTH_CONTRACT');
    requireValid(mode === 'oracle' ? validators.cases : validators.runtime, document.value,
      mode === 'oracle' ? 'INVALID_CASES_CONTRACT' : 'INVALID_RUNTIME_CONTRACT');
    if (mode === 'runtime' && document.value.schemaVersion !== 'sgx-semantic-runtime-run.2') {
      throw new SemanticScoringError('INVALID_RUNTIME_RUN_VERSION');
    }
    const context = createScoringContext({
      policy: policy.value,
      truth: truth.value,
      policyBytes: policy.bytes,
      truthBytes: truth.bytes,
      scorerBytes,
      expectedPolicySha256: document.value.policySha256,
      expectedTruthSha256: document.value.truthSha256,
    });
    let output;
    let outputName;
    if (mode === 'oracle') {
      output = scoreCasesFixture(context, document.value, { casesBytes: document.bytes });
      requireValid(validators.report, output, 'INVALID_SCORE_REPORT');
      outputName = 'semantic-score-report.json';
    } else {
      const result = scoreInput(context, {
        caseId: document.value.runId,
        truthItemId: document.value.truthItemId,
        input: document.value.input,
      });
      output = {
        schemaVersion: 'sgx-semantic-runtime-result.2',
        claimBoundary: 'offline_runtime_input_only',
        runRef: {
          runId: document.value.runId,
          schemaVersion: document.value.schemaVersion,
          sha256: sha256Bytes(document.bytes),
        },
        policyRef: { policyId: policy.value.policyId, sha256: context.policySha256 },
        truthRef: { truthId: truth.value.truthId, sha256: context.truthSha256 },
        scorerRef: { version: SCORER_VERSION, sourceSha256: context.scorerSha256 },
        result,
      };
      requireValid(validators.runtime, output, 'INVALID_RUNTIME_SCORE');
      outputName = 'semantic-runtime-score.json';
    }
    try {
      await mkdir(options['--out'], { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') throw new SemanticScoringError('OUTPUT_DIRECTORY_EXISTS');
      if (error?.code === 'ENOENT') throw new SemanticScoringError('OUTPUT_PARENT_NOT_FOUND');
      if (['EACCES', 'EPERM'].includes(error?.code)) throw new SemanticScoringError('OUTPUT_ACCESS_DENIED');
      throw error;
    }
    const reportPath = path.join(options['--out'], outputName);
    try {
      await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (['EACCES', 'EPERM'].includes(error?.code)) throw new SemanticScoringError('OUTPUT_ACCESS_DENIED');
      throw error;
    }
    console.log(JSON.stringify({
      mode: mode === 'oracle' ? 'offline_semantic_score' : 'offline_semantic_runtime_score',
      ready: true,
      reportPath,
      ...(mode === 'oracle'
        ? { cases: output.cases.length, oraclePassed: output.oracle.passed, oracleFailed: output.oracle.failed }
        : { runId: output.runRef.runId, truthItemId: output.result.truthItemId }),
      aggregateScore: null,
      functionalGate: mode === 'oracle' ? output.functionalGate.status : 'not_evaluated_single_runtime_input',
      credentialsRead: false,
      externalCalls: 0,
    }, null, 2));
  }
} catch (error) {
  const code = error instanceof SemanticScoringError
    ? error.code
    : ['EACCES', 'EPERM'].includes(error?.code)
      ? 'INPUT_ACCESS_DENIED'
    : error?.code === 'ENOENT'
      ? 'INPUT_FILE_NOT_FOUND'
      : 'SEMANTIC_SCORING_ERROR';
  console.error(code);
  process.exitCode = 2;
}
