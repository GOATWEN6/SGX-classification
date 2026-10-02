#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.SGX_PYTHON
  ?? (existsSync(`${root}/.venv/bin/python`) ? `${root}/.venv/bin/python` : 'python3');

function run(label, command, args, options = {}) {
  process.stdout.write(`\n== ${label} ==\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} exited ${result.status}`);
  }
}

run('TypeScript and Node contract/worker tests', process.execPath, [
  'scripts/classification-contract-test.mjs',
]);
run('Repository typecheck', 'npm', ['run', 'typecheck']);
run('Deployment and rollback fixtures', 'bash', [
  'deploy/classification-worker/tests/deployment-scripts.test.sh',
]);
run('Feature Service tests', python, [
  '-m',
  'pytest',
  '-q',
  'services/classification-feature-service/tests',
], {
  env: {
    PYTHONPATH: 'services/classification-feature-service/src',
  },
});
run('Classification secret scan', process.execPath, [
  'scripts/voice-secret-scan.mjs',
  'contracts',
  'harness/classification',
  'src/lib/algorithms/classification',
  'src/app/api/classification-lab',
  'src/app/classification-lab',
  'deploy/classification-worker',
  'services/classification-feature-service',
  'docs/algorithms/CLASSIFICATION_ALGORITHM_COMPLETE_GUIDE.md',
  'docs/algorithms/CLASSIFICATION_ALGORITHM_ARCHITECTURE_AND_FUNCTIONS_V1.md',
  'docs/algorithms/CLASSIFICATION_FULLSTACK_DELIVERY_README_V1.md',
  'docs/algorithms/CLASSIFICATION_FULLSTACK_INTEGRATION_GUIDE_V2.md',
  'docs/algorithms/CLASSIFICATION_MODEL_PROVENANCE_FREEZE_DRAFT_2026-10-02.md',
  'scripts/classification-contract-test.mjs',
  'scripts/classification-delivery-check.mjs',
  'scripts/classification-handoff-package.mjs',
]);
run('Whitespace and patch integrity', 'git', ['diff', '--check']);

process.stdout.write('\nPASS: SGX classification integration-candidate delivery gate\n');
