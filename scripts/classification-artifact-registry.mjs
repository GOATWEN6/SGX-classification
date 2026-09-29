#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ArtifactRegistryError,
  createArtifactRegistry,
  preflightArtifactRegistry,
} from '../harness/classification/artifact-registry.mjs';

const args = process.argv.slice(2);
const command = args[0];
const allowedByCommand = {
  create: new Set(['--definition']),
  verify: new Set(['--registry', '--expected-hash']),
};

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  console.log([
    '离线创建：npm run classification:artifacts -- create --definition /absolute/registry-definition.json',
    '离线校验：npm run classification:artifacts -- verify --registry /absolute/artifact-registry.json [--expected-hash sha256:...]',
    '',
    'definition 中的 outputRoot 必须是 Git 外的持久绝对目录。命令不读取凭据、不联网、不复制 payload。',
  ].join('\n'));
}

function validateArgs(selectedCommand) {
  const allowed = allowedByCommand[selectedCommand];
  for(let index = 1; index < args.length; index += 1) {
    const item = args[index];
    if(!allowed.has(item)) throw new ArtifactRegistryError('UNKNOWN_OPTION');
    if(item !== '--help') {
      if(!args[index + 1] || args[index + 1].startsWith('--')) throw new ArtifactRegistryError('MISSING_OPTION_VALUE');
      index += 1;
    }
  }
}

try {
  if(args.includes('--help') || !command) {
    usage();
    process.exitCode = args.includes('--help') ? 0 : 2;
  } else {
    if(!allowedByCommand[command]) throw new ArtifactRegistryError('UNKNOWN_COMMAND');
    validateArgs(command);
    if(command === 'create') {
      const definitionPath = option('--definition');
      if(!definitionPath) throw new ArtifactRegistryError('DEFINITION_REQUIRED');
      if(!path.isAbsolute(definitionPath)) throw new ArtifactRegistryError('ABSOLUTE_DEFINITION_PATH_REQUIRED');
      const definition = JSON.parse(await readFile(definitionPath, 'utf8'));
      const result = await createArtifactRegistry(definition);
      console.log(JSON.stringify({
        mode: 'offline_create',
        ready: true,
        registryPath: result.registryPath,
        registryHash: result.registryHash,
        artifacts: result.registry.artifacts.length,
        credentialsRead: false,
        externalCalls: 0,
      }, null, 2));
    } else if(command === 'verify') {
      const registryPath = option('--registry');
      if(!registryPath) throw new ArtifactRegistryError('REGISTRY_REQUIRED');
      const result = await preflightArtifactRegistry(registryPath, { expectedRegistryHash: option('--expected-hash') });
      console.log(JSON.stringify({
        mode: 'offline_verify',
        ready: result.ready,
        registryPath,
        registryHash: result.registryHash,
        ...result.summary,
        credentialsRead: result.credentialsRead,
        externalCalls: result.externalCalls,
      }, null, 2));
    }
  }
} catch(error) {
  const code = error instanceof ArtifactRegistryError
    ? error.code
    : error?.name === 'SyntaxError'
      ? 'INVALID_REGISTRY_DEFINITION_JSON'
      : 'ARTIFACT_REGISTRY_ERROR';
  console.error(code);
  process.exitCode = 2;
}
