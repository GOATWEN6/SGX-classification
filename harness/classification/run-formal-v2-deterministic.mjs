import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const buildRoot = process.env.CLASSIFICATION_BUILD_DIR;
const ensure = (condition, code) => { if(!condition) throw new Error(code); };
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const isWithin = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const normalize = value => String(value).normalize('NFKC').trim().toLocaleLowerCase();

function loadRuntime() {
  ensure(buildRoot, 'CLASSIFICATION_BUILD_DIR_REQUIRED');
  const base = `${buildRoot}/src/lib/algorithms/classification`;
  return {
    DeterministicTextExtractor: require(`${base}/text-extractor.js`).DeterministicTextExtractor,
    organizeSparseContent: require(`${base}/content-organization.js`).organizeSparseContent,
  };
}

function validatePlan(raw) {
  ensure(raw?.version === 'sgx-formal-v2-deterministic-plan.2', 'DETERMINISTIC_PLAN_VERSION_MISMATCH');
  ensure(raw.providerCalls === 0, 'DETERMINISTIC_PROVIDER_CALLS_FORBIDDEN');
  ensure(Array.isArray(raw.tasks) && raw.tasks.length > 0, 'DETERMINISTIC_TASKS_REQUIRED');
  const taskIds = new Set();
  for(const task of raw.tasks) {
    ensure(typeof task?.taskId === 'string' && !taskIds.has(task.taskId), 'DETERMINISTIC_TASK_ID_INVALID');
    taskIds.add(task.taskId);
    ensure(task.providerCalls === 0, 'DETERMINISTIC_PROVIDER_CALLS_FORBIDDEN');
    ensure(task.inputMode === 'text_only' || task.inputMode === 'asr_only', 'DETERMINISTIC_INPUT_MODE_INVALID');
    ensure(task.scope?.householdId && task.scope?.subjectId, 'DETERMINISTIC_SCOPE_REQUIRED');
    ensure(task.fixture?.contentOrganizationFixture === true && task.fixture?.stageAEligibility === false, 'DETERMINISTIC_FIXTURE_BOUNDARY_INVALID');
    ensure(Array.isArray(task.fixture.evidence) && task.fixture.evidence.length === 1, 'DETERMINISTIC_EVIDENCE_COUNT_INVALID');
    const evidence = task.fixture.evidence[0];
    ensure(evidence.type === (task.inputMode === 'text_only' ? 'user_text' : 'final_asr'), 'DETERMINISTIC_EVIDENCE_TYPE_INVALID');
    ensure(typeof evidence.text === 'string' && evidence.text.trim(), 'DETERMINISTIC_TEXT_REQUIRED');
    ensure(/^sha256:[a-f0-9]{64}$/.test(evidence.sourceHash), 'DETERMINISTIC_SOURCE_HASH_INVALID');
    ensure(sha(Buffer.from(evidence.text, 'utf8')) === evidence.textHash, 'DETERMINISTIC_TEXT_HASH_MISMATCH');
    ensure(task.expected?.semantic && typeof task.expected.semantic === 'object', 'DETERMINISTIC_SEMANTIC_TRUTH_REQUIRED');
  }
  return raw;
}

function evaluateSemantic(task, extraction, organization) {
  const semantic = task.expected.semantic;
  const checks = [];
  const mismatch = (code, detail) => checks.push({ code, pass: false, detail });
  const pass = (code, detail) => checks.push({ code, pass: true, detail });
  const observations = extraction.observations.filter(item => !['content_type', 'theme'].includes(item.facet));
  const values = (facet, state) => observations.filter(item => item.facet === facet && item.state === state).map(item => normalize(item.normalizedValue ?? item.rawValue));
  for(const facet of ['person', 'time', 'place', 'event', 'scene']) {
    const expectedCandidates = (semantic.candidate?.[facet] ?? []).map(normalize);
    const actualCandidates = values(facet, 'candidate');
    const missing = expectedCandidates.filter(value => !actualCandidates.includes(value));
    if(missing.length) mismatch(`MISSING_CANDIDATE_${facet.toUpperCase()}`, missing);
    else pass(`EXPECTED_CANDIDATE_${facet.toUpperCase()}`, expectedCandidates);
    if((semantic.unknownFacets ?? []).includes(facet) && expectedCandidates.length === 0 && actualCandidates.length) {
      mismatch(`UNKNOWN_FACET_ASSERTED_${facet.toUpperCase()}`, actualCandidates);
    }
    const expectedConflicted = (semantic.conflicted?.[facet] ?? []).map(normalize);
    const actualConflicted = values(facet, 'conflicted');
    const missingConflicted = expectedConflicted.filter(value => !actualConflicted.includes(value));
    if(missingConflicted.length) mismatch(`MISSING_CONFLICTED_${facet.toUpperCase()}`, missingConflicted);
    else if(expectedConflicted.length) pass(`EXPECTED_CONFLICTED_${facet.toUpperCase()}`, expectedConflicted);
    if((semantic.conflictFacets ?? []).includes(facet) && actualConflicted.length === 0) mismatch(`CONFLICT_NOT_PRESERVED_${facet.toUpperCase()}`, []);
    for(const forbidden of semantic.forbiddenValues?.[facet] ?? []) {
      const found = observations.some(item => item.facet === facet && normalize(item.normalizedValue ?? item.rawValue) === normalize(forbidden));
      if(found) mismatch(`FORBIDDEN_VALUE_${facet.toUpperCase()}`, forbidden);
      else pass(`FORBIDDEN_VALUE_ABSENT_${facet.toUpperCase()}`, forbidden);
    }
  }
  const evidence = task.fixture.evidence[0];
  const supportIntegrity = extraction.observations.every(item => item.evidenceId === evidence.sourceRef
    && item.supports.every(support => support.evidenceId === evidence.sourceRef && support.sourceType === evidence.type));
  supportIntegrity ? pass('SUPPORT_INTEGRITY', evidence.sourceRef) : mismatch('SUPPORT_INTEGRITY', evidence.sourceRef);
  const originalPreserved = organization.stories.length === 1
    && organization.stories[0].memberContentIds.length === 1
    && organization.stories[0].memberContentIds[0] === `content-${task.bundleId}`;
  originalPreserved ? pass('ORGANIZATION_SINGLETON_PRESERVED', task.bundleId) : mismatch('ORGANIZATION_SINGLETON_PRESERVED', organization.stories.map(item => item.memberContentIds));
  return { pass: checks.every(item => item.pass), checks };
}

export async function runDeterministicPlan({ planPath, out, now = new Date(), allowEphemeralOutputForTest = false }) {
  ensure(now instanceof Date && Number.isFinite(now.getTime()), 'INVALID_NOW');
  const resolvedPlan = path.resolve(planPath);
  const outRoot = path.resolve(out);
  if(!allowEphemeralOutputForTest) {
    const ephemeral = [...new Set([tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].map(value => path.resolve(value)))];
    ensure(!ephemeral.some(root => isWithin(root, outRoot)), 'PERSISTENT_OUTPUT_REQUIRED');
  }
  try { await stat(outRoot); throw new Error('OUTPUT_EXISTS'); }
  catch(error) { if(error?.code !== 'ENOENT') throw error; }
  const planBytes = await readFile(resolvedPlan);
  const plan = validatePlan(JSON.parse(planBytes));
  const { DeterministicTextExtractor, organizeSparseContent } = loadRuntime();
  const extractor = new DeterministicTextExtractor();
  const createdAt = now.toISOString();
  const results = [];
  for(const task of plan.tasks) {
    const evidence = task.fixture.evidence[0];
    const content = {
      contentId: `content-${task.bundleId}`,
      scope: task.scope,
      modality: evidence.type,
      evidenceIds: [evidence.sourceRef],
      originalText: evidence.text,
      lifecycle: 'active',
    };
    const extraction = extractor.extract({ scope: task.scope, content, taxonomyVersion: 'sgx-synthetic-v2.0.0' });
    const organization = organizeSparseContent({
      schemaVersion: '2.0',
      contractVersion: 'classification-hybrid.2',
      scope: task.scope,
      contents: [content],
      observations: extraction.observations,
      retrievalCandidates: [],
      explicitAssociations: [],
      decisionPolicy: {
        schemaVersion: '2.0', contractVersion: 'classification-hybrid.2', policyVersion: 'formal-v2-deterministic.1',
        mode: 'shadow', decisionMode: 'evidence_rules', calibrated: false, maxCandidatesPerContent: 8,
        riskPolicyVersion: 'impact-risk.1', createdAt,
      },
      createdAt,
    });
    const semantic = evaluateSemantic(task, extraction, organization);
    results.push({
      taskId: task.taskId,
      submissionId: task.submissionId,
      bundleId: task.bundleId,
      inputMode: task.inputMode,
      status: semantic.pass ? 'passed' : 'semantic_mismatch',
      providerCalls: 0,
      sourceHash: evidence.sourceHash,
      textHash: evidence.textHash,
      extractorVersion: extraction.extractorVersion,
      extraction,
      organization,
      semantic,
    });
  }
  const summary = {
    version: 'sgx-formal-v2-deterministic-result.1',
    campaignId: plan.campaignId,
    generatedAt: createdAt,
    planPath: resolvedPlan,
    planHash: sha(planBytes),
    planned: plan.tasks.length,
    completed: results.length,
    passed: results.filter(item => item.status === 'passed').length,
    semanticMismatches: results.filter(item => item.status === 'semantic_mismatch').length,
    failed: 0,
    providerCalls: 0,
    claimBoundary: 'Deterministic synthetic content-organization checks only; not provider accuracy or real-user evidence.',
  };
  const parent = path.dirname(outRoot);
  await mkdir(parent, { recursive: true });
  const tempRoot = path.join(parent, `.${path.basename(outRoot)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(path.join(tempRoot, 'tasks'), { recursive: true, mode: 0o700 });
    for(const result of results) await writeFile(path.join(tempRoot, 'tasks', `${result.taskId}.json`), jsonBytes(result), { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(tempRoot, 'summary.json'), jsonBytes(summary), { mode: 0o600, flag: 'wx' });
    const report = [
      '# SGX formal v2 deterministic evaluation', '',
      `- Planned/completed: ${summary.planned}/${summary.completed}`,
      `- Passed: ${summary.passed}`,
      `- Semantic mismatches: ${summary.semanticMismatches}`,
      '- Provider calls: 0', '',
      '|Task|Bundle|Mode|Status|', '|---|---|---|---|',
      ...results.map(item => `|${item.taskId}|${item.bundleId}|${item.inputMode}|${item.status}|`), '',
      '> This is a deterministic synthetic engineering check. It is not real-model accuracy or a product-effect claim.', '',
    ].join('\n');
    await writeFile(path.join(tempRoot, 'REPORT.md'), report, { mode: 0o600, flag: 'wx' });
    const files = [];
    for(const result of results) files.push({ path: `tasks/${result.taskId}.json`, sha256: sha(await readFile(path.join(tempRoot, 'tasks', `${result.taskId}.json`))) });
    files.push({ path: 'summary.json', sha256: sha(await readFile(path.join(tempRoot, 'summary.json'))) });
    files.push({ path: 'REPORT.md', sha256: sha(await readFile(path.join(tempRoot, 'REPORT.md'))) });
    files.sort((a, b) => a.path.localeCompare(b.path));
    await writeFile(path.join(tempRoot, 'MANIFEST.sha256.json'), jsonBytes({ version: 'sgx-formal-v2-deterministic-files.1', files }), { mode: 0o600, flag: 'wx' });
    await rename(tempRoot, outRoot);
  } catch(error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  return { out: outRoot, summary, results };
}

function parseArgs(argv) {
  const option = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  return { planPath: option('--plan'), out: option('--out'), now: option('--now'), help: argv.includes('--help') };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if(args.help || !args.planPath || !args.out) {
    console.log('node scripts/classification-formal-deterministic.mjs --plan /absolute/deterministic-plan.json --out /absolute/persistent-output-dir [--now ISO-8601]');
    return args.help ? 0 : 2;
  }
  const result = await runDeterministicPlan({ planPath: args.planPath, out: args.out, now: args.now ? new Date(args.now) : new Date() });
  console.log(JSON.stringify(result.summary, null, 2));
  return result.summary.semanticMismatches === 0 ? 0 : 3;
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if(invokedAsScript) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
