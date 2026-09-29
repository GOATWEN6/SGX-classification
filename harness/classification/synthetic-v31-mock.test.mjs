import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOracleObservation, evaluateDiagnosticPlan } from './synthetic-v31-mock.mjs';

test('oracle observation only emits supported Stage A vocabulary and text-grounded time', () => {
  const photo = {
    photoId: 'p1',
    textEvidence: [{ evidenceId: 'e1', source: 'user_text', text: '这是2021年毕业时拍的。' }]
  };
  const truth = {
    facets: {
      time: [{ value: 'event:year:2021' }], place: [],
      event: [{ value: '毕业' }, { value: '普通日常' }], scene: [{ value: '校园' }, { value: '翻拍' }]
    },
    expectedConflicts: []
  };
  const observation = buildOracleObservation(photo, truth);
  assert.deepEqual(observation.times.map(item => item.value), ['2021']);
  assert.deepEqual(observation.events.map(item => item.type), ['毕业']);
  assert.deepEqual(observation.scenes.map(item => item.label), ['校园']);
  assert.equal(observation.times[0].supports[0].evidenceId, 'e1');
});

test('diagnostics reject cross-scope batches and accept a bounded same-scope batch', () => {
  const group = (id, scope) => ({ groupId: id, partition: 'exploration', envelope: { scope: { householdId: scope }, evidence: [{ modality: 'image', lifecycleState: 'active' }] } });
  const groups = new Map(['a','b','c','d','e'].map(id => [id, group(id, 'h1')]));
  const plan = { runs: [{ runId: 'ok', partition: 'exploration', kind: 'large_batch', groupIds: ['a','b','c','d','e'] }] };
  assert.equal(evaluateDiagnosticPlan(plan, groups)[0].status, 'passed');
  groups.set('e', group('e', 'h2'));
  assert.deepEqual(evaluateDiagnosticPlan(plan, groups)[0].errors, ['CROSS_SCOPE_BATCH']);
});
