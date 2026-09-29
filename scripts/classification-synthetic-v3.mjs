import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const takesValue = new Set([
  '--manifest', '--out', '--provider', '--model', '--provider-use-review-ref', '--input-price', '--output-price',
  '--pricing-source', '--pricing-checked-at', '--max-requests', '--max-input-tokens', '--max-output-tokens',
  '--max-cost-cny', '--max-duration-seconds'
]);
const allowed = new Set([...takesValue, '--ready', '--help']);
for(let index = 0; index < args.length; index += 1) {
  if(!allowed.has(args[index])) { console.error('UNKNOWN_OPTION'); process.exit(2); }
  if(takesValue.has(args[index])) { if(!args[index + 1]) { console.error('MISSING_OPTION_VALUE'); process.exit(2); } index += 1; }
}
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const manifestPath = option('--manifest'); const outputPath = option('--out');
if(args.includes('--help') || !manifestPath || !outputPath) {
  console.log([
    '离线适配（默认生成 draft，不读密钥、不调用模型）：',
    'npm run classification:adapt-synthetic-v3 -- --manifest /absolute/dataset/manifest.json --out /private/tmp/new-output-dir',
    '',
    '只有在批次、模型、价格和费用上限已单独确认后，才使用 --ready 并提供 provider/model/pricing/caps。输出目录必须不存在。'
  ].join('\n'));
  process.exit(args.includes('--help') ? 0 : 2);
}

function numberOption(name) {
  const value = option(name); if(value === undefined) return undefined;
  const parsed = Number(value); if(!Number.isFinite(parsed) || parsed < 0) { console.error('INVALID_NUMERIC_OPTION'); process.exit(2); }
  return parsed;
}
const ready = args.includes('--ready');
const requiredReady = ['--provider', '--model', '--provider-use-review-ref', '--input-price', '--output-price', '--pricing-source', '--pricing-checked-at', '--max-requests', '--max-input-tokens', '--max-output-tokens', '--max-cost-cny', '--max-duration-seconds'];
if(ready && requiredReady.some(name => option(name) === undefined)) { console.error('READY_STAGE_A_CONFIGURATION_REQUIRED'); process.exit(2); }

const build = await mkdtemp(path.join(tmpdir(), 'sgx-synthetic-v3-'));
try {
  await symlink(path.join(root, 'node_modules'), path.join(build, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = (await readdir(path.join(root, 'src/lib/algorithms/classification')))
    .filter(file => file.endsWith('.ts')).map(file => `src/lib/algorithms/classification/${file}`);
  const compile = spawnSync(process.execPath, [
    'node_modules/typescript/bin/tsc', '--outDir', build, '--rootDir', '.', '--module', 'commonjs', '--moduleResolution', 'node',
    '--target', 'es2022', '--lib', 'es2022,dom', '--esModuleInterop', '--resolveJsonModule', '--strict', '--skipLibCheck',
    '--noEmit', 'false', '--incremental', 'false', ...files
  ], { cwd: root, stdio: 'inherit' });
  if(compile.error) throw compile.error;
  if(compile.status !== 0) throw new Error('SYNTHETIC_V3_ADAPTER_COMPILE_FAILED');
  const require = createRequire(import.meta.url);
  const { writeSyntheticV3Artifacts } = require(path.join(build, 'src/lib/algorithms/classification/synthetic-v3-adapter.js'));
  const stageA = ready ? {
    status: 'ready', provider: option('--provider'), model: option('--model'), providerUseReviewRef: option('--provider-use-review-ref'),
    inputCnyPerMillion: numberOption('--input-price'), outputCnyPerMillion: numberOption('--output-price'),
    pricingSource: option('--pricing-source'), pricingCheckedAt: option('--pricing-checked-at'),
    caps: {
      maxRequests: numberOption('--max-requests'), maxInputTokens: numberOption('--max-input-tokens'),
      maxOutputTokens: numberOption('--max-output-tokens'), maxCostCny: numberOption('--max-cost-cny'),
      maxDurationSeconds: numberOption('--max-duration-seconds'), maxRetries: 0
    }
  } : { status: 'draft' };
  const result = await writeSyntheticV3Artifacts(manifestPath, outputPath, { stageA });
  console.log(JSON.stringify({ out: path.resolve(outputPath), ...result.report }, null, 2));
} catch(error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : 'SYNTHETIC_V3_ADAPTER_FAILED';
  console.error(String(code)); process.exitCode = 2;
} finally { await rm(build, { recursive: true, force: true }); }
