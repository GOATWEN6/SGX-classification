import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = await mkdtemp(path.join(tmpdir(), 'sgx-formal-deterministic-'));

function run(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Object.assign(new Error(`FORMAL_DETERMINISTIC_EXIT_${code}`), { exitCode: code })));
  });
}

try {
  const source = 'src/lib/algorithms/classification';
  const files = (await readdir(path.join(root, source))).filter(file => file.endsWith('.ts')).map(file => `${source}/${file}`);
  await run([
    'node_modules/typescript/bin/tsc', '--outDir', build, '--rootDir', '.', '--module', 'commonjs', '--moduleResolution', 'node',
    '--target', 'es2022', '--lib', 'es2022,dom', '--esModuleInterop', '--resolveJsonModule', '--strict', '--skipLibCheck',
    '--noEmit', 'false', '--incremental', 'false', ...files,
  ]);
  await run(['harness/classification/run-formal-v2-deterministic.mjs', ...process.argv.slice(2)], {
    ...process.env,
    CLASSIFICATION_BUILD_DIR: build,
    NODE_PATH: path.join(root, 'node_modules'),
  });
} catch(error) {
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  if(!Number.isInteger(error?.exitCode)) console.error(error instanceof Error ? error.message : String(error));
} finally {
  await rm(build, { recursive: true, force: true });
}
