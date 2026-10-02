import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runDeterministicPlan } from './run-formal-v2-deterministic.mjs';

const hash = text => `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
const text = '我记得第一次搬进城里是八八年春天，窗外能听见火车。';

function plan(overrides = {}) {
  return {
    version: 'sgx-formal-v2-deterministic-plan.2',
    campaignId: 'sgx_formal_v2_test',
    status: 'ready_offline',
    providerCalls: 0,
    tasks: [{
      taskId: 'deterministic_e09', submissionId: 'E09', phase: 'exploration', context: 'album_upload', bundleId: 'SGX-V2-T001',
      scope: { householdId: 'scope-bamboo', subjectId: 'BAM-V2-T01' }, inputMode: 'text_only', providerCalls: 0,
      fixture: { contentOrganizationFixture: true, stageAEligibility: false, evidence: [{ type: 'user_text', sourceRef: 'src:SGX-V2-T001:text', sourcePath: 'sealed.txt', sourceHash: hash(`${text}\n`), textHash: hash(text), text }] },
      assertions: ['stage_a_provider_not_called'],
      expected: {
        resultStatus: 'candidate', workflowStatus: 'awaiting_confirmation', boundaryTags: ['content_organization_only'],
        semantic: {
          candidate: { person: [], time: ['1988'], place: [], event: ['搬家'], scene: [] },
          conflicted: { person: [], time: [], place: [], event: [], scene: [] },
          unknownFacets: ['place', 'person'], conflictFacets: [], forbiddenValues: {},
        },
      },
    }],
    ...overrides,
  };
}

test('deterministic formal runner executes text organization with zero provider calls', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-deterministic-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planPath = path.join(root, 'plan.json');
  await writeFile(planPath, `${JSON.stringify(plan())}\n`);
  const out = path.join(root, 'result');
  const result = await runDeterministicPlan({ planPath, out, now: new Date('2026-10-03T00:00:00Z'), allowEphemeralOutputForTest: true });
  assert.equal(result.summary.providerCalls, 0);
  assert.equal(result.summary.planned, 1);
  assert.equal(result.summary.passed, 1);
  assert.equal(result.summary.semanticMismatches, 0);
  const saved = JSON.parse(await readFile(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(saved.providerCalls, 0);
  assert.equal(saved.passed, 1);
  assert.match(await readFile(path.join(out, 'REPORT.md'), 'utf8'), /Provider calls: 0/);
});

test('deterministic formal runner rejects tampered evidence and temporary formal outputs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sgx-deterministic-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bad = plan();
  bad.tasks[0].fixture.evidence[0].text = '被篡改';
  const badPath = path.join(root, 'bad.json');
  await writeFile(badPath, `${JSON.stringify(bad)}\n`);
  await assert.rejects(() => runDeterministicPlan({ planPath: badPath, out: path.join(root, 'bad-out'), allowEphemeralOutputForTest: true }), /DETERMINISTIC_TEXT_HASH_MISMATCH/);

  const goodPath = path.join(root, 'good.json');
  await writeFile(goodPath, `${JSON.stringify(plan())}\n`);
  await assert.rejects(() => runDeterministicPlan({ planPath: goodPath, out: path.join(root, 'forbidden') }), /PERSISTENT_OUTPUT_REQUIRED/);
});
