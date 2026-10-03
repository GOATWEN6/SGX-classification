#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageName = 'sgx-classification-fullstack-integration-candidate-v0.2.1-20261003';
const outIndex = process.argv.indexOf('--out');
const outArgument = outIndex >= 0 ? process.argv[outIndex + 1] : 'dist';
if (!outArgument) throw new Error('--out requires a path');
const outRoot = path.resolve(root, outArgument);
const packageRoot = path.join(outRoot, packageName);
const zipPath = path.join(outRoot, `${packageName}.zip`);

async function mustNotExist(target) {
  try {
    await access(target);
    throw new Error(`Refusing to overwrite existing output: ${target}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function allowed(source) {
  const parts = source.split(path.sep);
  const name = path.basename(source);
  if (parts.some((part) => ['.git', '.next', 'node_modules', 'dist', 'build', 'coverage', '__pycache__', '.pytest_cache'].includes(part))) return false;
  if (name.startsWith('.env') || name.endsWith('.pyc') || name.endsWith('.pem')) return false;
  if (['id_rsa', 'id_ed25519'].includes(name)) return false;
  if (/\.(?:onnx|safetensors|ckpt|pt|pth)$/i.test(name)) return false;
  return true;
}

async function copy(relative) {
  const source = path.join(root, relative);
  const destination = path.join(packageRoot, relative);
  await cp(source, destination, { recursive: true, filter: allowed });
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

await mustNotExist(packageRoot);
await mustNotExist(zipPath);
await mkdir(packageRoot, { recursive: true, mode: 0o755 });

for (const relative of [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'contracts',
  'deploy/classification-worker',
  'services/classification-feature-service',
  'src/lib/algorithms/classification',
  'src/app/api/classification-lab',
  'src/app/classification-lab',
  'harness/classification',
  'docs/algorithms',
  'docs/superpowers/specs',
  'docs/superpowers/plans',
  'figures',
  'scripts/classification-types.mjs',
  'scripts/classification-contract-test.mjs',
  'scripts/classification-delivery-check.mjs',
  'scripts/classification-handoff-package.mjs',
  'scripts/classification-fake-http.mjs',
  'scripts/classification-stage-a.mjs',
  'scripts/voice-secret-scan.mjs',
]) await copy(relative);

const rootDocuments = [
  ['docs/algorithms/CLASSIFICATION_FULLSTACK_DELIVERY_README_V1.md', 'README.md'],
  ['docs/algorithms/CLASSIFICATION_ALGORITHM_ARCHITECTURE_AND_FUNCTIONS_V1.md', 'ALGORITHM_ARCHITECTURE_AND_FUNCTIONS.md'],
  ['docs/algorithms/CLASSIFICATION_ALGORITHM_COMPLETE_GUIDE.md', 'ALGORITHM_COMPLETE_GUIDE.md'],
  ['docs/algorithms/CLASSIFICATION_FULLSTACK_INTEGRATION_GUIDE_V2.md', 'FULLSTACK_INTEGRATION_GUIDE.md'],
  ['docs/algorithms/CLASSIFICATION_MODEL_PROVENANCE_FREEZE_DRAFT_2026-10-02.md', 'MODEL_PROVENANCE_AND_RELEASE_GATES.md'],
  ['docs/algorithms/CLASSIFICATION_FULLSTACK_DELIVERY_VALIDATION_2026-10-03.md', 'VALIDATION_REPORT.md'],
];
for (const [source, destination] of rootDocuments) {
  await copyFile(path.join(root, source), path.join(packageRoot, destination));
}

const metadata = {
  packageName,
  packageVersion: '0.2.1',
  status: 'internal_release_candidate',
  createdAt: new Date().toISOString(),
  source: {
    branch: git('branch', '--show-current'),
    headCommit: git('rev-parse', 'HEAD'),
    containsUncommittedIntegrationWork: Boolean(git('status', '--porcelain')),
  },
  versions: {
    stageA: 'classification-stage-a.1',
    prompt: 'sgx-five-facets.16',
    validation: 'stage-a-validation.2',
    hybridContract: 'classification-hybrid.2',
    organizer: 'content-organization.3',
    workerProtocol: 'classification-worker-control-plane.v1',
    persistencePolicy: 'classification-download-persistence.1',
  },
  releaseBoundary: {
    productControlPlaneIncluded: false,
    productionRelease: false,
    modelWeightsIncluded: false,
    secretsIncluded: false,
    realUserMediaIncluded: false,
  },
};
await writeFile(path.join(packageRoot, 'PACKAGE_METADATA.json'), `${JSON.stringify(metadata, null, 2)}\n`);

const files = (await walk(packageRoot))
  .filter((file) => path.basename(file) !== 'MANIFEST.sha256')
  .sort();
const manifest = [];
for (const file of files) {
  const bytes = await readFile(file);
  const hash = createHash('sha256').update(bytes).digest('hex');
  manifest.push(`${hash}  ${path.relative(packageRoot, file)}`);
}
await writeFile(path.join(packageRoot, 'MANIFEST.sha256'), `${manifest.join('\n')}\n`);

const scan = spawnSync(process.execPath, [path.join(root, 'scripts/voice-secret-scan.mjs'), packageRoot], {
  cwd: root,
  stdio: 'inherit',
});
if (scan.status !== 0) throw new Error(`Package secret scan exited ${scan.status}`);

const zip = spawnSync('python3', ['-m', 'zipfile', '-c', path.basename(zipPath), packageName], {
  cwd: outRoot,
  stdio: 'inherit',
});
if (zip.status !== 0) throw new Error(`ZIP creation exited ${zip.status}`);
const check = spawnSync('python3', ['-m', 'zipfile', '-t', path.basename(zipPath)], {
  cwd: outRoot,
  encoding: 'utf8',
});
if (check.status !== 0) throw new Error(check.stderr || `ZIP validation exited ${check.status}`);

const zipBytes = await readFile(zipPath);
const zipHash = createHash('sha256').update(zipBytes).digest('hex');
await writeFile(`${zipPath}.sha256`, `${zipHash}  ${path.basename(zipPath)}\n`);
const zipStats = await stat(zipPath);
await rm(packageRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ zipPath, zipSha256: zipHash, zipBytes: zipStats.size, files: manifest.length, expandedStagingRemoved: true })}\n`);
