import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestIndex = process.argv.indexOf('--manifest');
const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
if(!manifestPath) {
  console.error('USAGE: npm run classification:t0-preflight -- --manifest /absolute/path/manifest.json');
  process.exit(2);
}

const build = await mkdtemp(path.join(tmpdir(), 'sgx-classification-t0-'));
try {
  // The emitted CommonJS files live outside the repository, so their normal
  // ancestor lookup cannot reach this project's dependencies. Keep the build
  // isolated while making the repository dependency tree visible to it.
  await symlink(path.join(root, 'node_modules'), path.join(build, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = (await readdir(path.join(root, 'src/lib/algorithms/classification')))
    .filter(file => file.endsWith('.ts'))
    .map(file => `src/lib/algorithms/classification/${file}`);
  const compile = spawnSync(process.execPath, [
    'node_modules/typescript/bin/tsc', '--outDir', build, '--rootDir', '.', '--module', 'commonjs',
    '--moduleResolution', 'node', '--target', 'es2022', '--lib', 'es2022,dom', '--esModuleInterop',
    '--resolveJsonModule', '--strict', '--skipLibCheck', '--noEmit', 'false', '--incremental', 'false', ...files
  ], { cwd: root, stdio: 'inherit' });
  if(compile.error) throw compile.error;
  if(compile.status !== 0) throw new Error('T0_PREFLIGHT_COMPILE_FAILED');
  const require = createRequire(import.meta.url);
  const { preflightT0RealMedia } = require(path.join(build, 'src/lib/algorithms/classification/t0-real-media.js'));
  const result = await preflightT0RealMedia(manifestPath);
  console.log(JSON.stringify({
    ready: result.ready,
    blockers: result.blockers,
    manifestHash: result.manifestHash,
    truthHash: result.truthHash,
    root: result.root,
    ...result.summary
  }, null, 2));
  if(!result.ready) process.exitCode = 2;
} catch(error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : 'T0_PREFLIGHT_FAILED';
  console.error(String(code));
  process.exitCode = 2;
} finally {
  await rm(build, { recursive: true, force: true });
}
