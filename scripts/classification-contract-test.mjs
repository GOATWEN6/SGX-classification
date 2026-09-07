import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = await mkdtemp(path.join(tmpdir(), 'sgx-classification-'));
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Classification check exited ${result.status}`);
}
try {
  run(['scripts/classification-types.mjs', '--check']);
  const source = 'src/lib/algorithms/classification';
  const files = (await readdir(path.join(root, source))).filter(f => f.endsWith('.ts')).map(f => `${source}/${f}`);
  run(['node_modules/typescript/bin/tsc', '--outDir', build, '--rootDir', '.', '--module', 'commonjs',
    '--moduleResolution', 'node', '--target', 'es2022', '--lib', 'es2022,dom', '--esModuleInterop',
    '--resolveJsonModule', '--strict', '--skipLibCheck', '--noEmit', 'false', '--incremental', 'false', ...files]);
  const tests = (await readdir(path.join(root, 'harness/classification')))
    .filter(f => f.endsWith('.test.mjs')).map(f => `harness/classification/${f}`);
  if (!tests.length) throw new Error('No classification tests found');
  const demoIndex = process.argv.indexOf('--demo');
  run(demoIndex >= 0 ? ['harness/classification/demo.mjs', process.argv[demoIndex + 1] ?? 'success'] : ['--test', ...tests],
    { ...process.env, CLASSIFICATION_BUILD_DIR: build,
    NODE_PATH: path.join(root, 'node_modules') });
} finally {
  await rm(build, { recursive: true, force: true });
}
