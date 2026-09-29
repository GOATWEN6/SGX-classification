import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const schema = JSON.parse(await readFile(new URL('../../contracts/classification-artifact-registry-v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  format: 'full',
  jsonPointers: true,
  ownProperties: true,
  removeAdditional: false,
  strictKeywords: true,
  strictNumbers: true,
  useDefaults: false,
});
const validateRegistrySchema = ajv.compile(schema);

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REGISTRY_FILENAME = 'artifact-registry.json';
const REQUIRED_ARTIFACT_KINDS = {
  synthetic_fixture: ['dataset_manifest', 'truth', 'scoring_policy', 'checksum_manifest'],
  real_model_on_synthetic: [
    'dataset_manifest', 'truth', 'scoring_policy', 'preflight', 'approval_reference',
    'provider_response', 'request_ledger', 'metrics', 'report',
  ],
  real_user_authorized: [
    'dataset_manifest', 'truth', 'scoring_policy', 'preflight', 'approval_reference',
    'provider_response', 'request_ledger', 'metrics', 'report',
  ],
  mock_transport: ['dataset_manifest', 'truth', 'scoring_policy', 'request_ledger', 'metrics', 'report'],
  offline_replay: [
    'truth', 'scoring_policy', 'source_response_reference', 'replay_result',
    'request_ledger', 'metrics', 'report',
  ],
  summary_only_missing: ['missing_evidence_ledger', 'report'],
};
const TOP_LEVEL_INPUT_KEYS = new Set([
  'version', 'registryId', 'revision', 'claimBoundary', 'outputRoot', 'createdAt',
  'identity', 'authorization', 'sourceRegistryRefs', 'artifacts',
]);
const IDENTITY_KEYS = new Set([
  'pipeline', 'datasetId', 'batchId', 'runId', 'provider', 'model', 'promptVersion',
  'guardVersion', 'taxonomyVersion', 'truthVersion', 'scoringPolicyVersion',
]);
const AUTHORIZATION_KEYS = new Set(['approvalHash', 'evidenceRefHash', 'expiresAt', 'caps']);
const CAPS_KEYS = new Set([
  'maxRequests', 'maxInputTokens', 'maxOutputTokens', 'maxCostCny',
  'maxDurationSeconds', 'maxRetries',
]);
const ARTIFACT_INPUT_KEYS = new Set([
  'artifactId', 'kind', 'relativePath', 'sensitivity', 'provenanceArtifactIds', 'createdAt',
]);
const SOURCE_REGISTRY_REF_KEYS = new Set(['registryId', 'registryHash', 'artifactIds']);

export class ArtifactRegistryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ArtifactRegistryError';
    this.code = code;
  }
}

function fail(code) {
  throw new ArtifactRegistryError(code);
}

function ensure(condition, code) {
  if(!condition) fail(code);
}

function assertExactKeys(value, allowed) {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_ARTIFACT_REGISTRY');
  ensure(Object.keys(value).every(key => allowed.has(key)), 'INVALID_ARTIFACT_REGISTRY');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalTempRoots() {
  const candidates = new Set([tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']);
  const roots = [];
  for(const candidate of candidates) {
    try {
      roots.push(await realpath(candidate));
    } catch {
      // A platform may not have every conventional temporary path.
    }
  }
  return [...new Set(roots)];
}

async function hasGitAncestor(canonicalRoot) {
  let current = canonicalRoot;
  while(true) {
    try {
      await lstat(path.join(current, '.git'));
      return true;
    } catch(error) {
      if(error?.code !== 'ENOENT') fail('OUTPUT_ROOT_GIT_BOUNDARY_UNVERIFIABLE');
    }
    const parent = path.dirname(current);
    if(parent === current) return false;
    current = parent;
  }
}

async function inspectOutputRoot(outputRoot, allowEphemeralForTest) {
  ensure(typeof outputRoot === 'string' && path.isAbsolute(outputRoot), 'ABSOLUTE_OUTPUT_ROOT_REQUIRED');
  const resolvedRoot = path.resolve(outputRoot);
  let info;
  try {
    info = await lstat(resolvedRoot);
  } catch {
    fail('OUTPUT_ROOT_NOT_FOUND');
  }
  ensure(!info.isSymbolicLink(), 'OUTPUT_ROOT_SYMLINK_ESCAPE');
  ensure(info.isDirectory(), 'OUTPUT_ROOT_NOT_DIRECTORY');
  const canonicalRoot = await realpath(resolvedRoot);
  ensure(!(await hasGitAncestor(canonicalRoot)), 'OUTPUT_ROOT_INSIDE_GIT');
  if(!allowEphemeralForTest) {
    const ephemeral = (await canonicalTempRoots()).some(root => isWithin(root, canonicalRoot));
    ensure(!ephemeral, 'EPHEMERAL_OUTPUT_ROOT');
  }
  ensure((info.mode & 0o077) === 0, 'OUTPUT_ROOT_PERMISSIONS');
  return { canonicalRoot, resolvedRoot };
}

function validateRelativePath(relativePath) {
  ensure(typeof relativePath === 'string' && relativePath.length > 0, 'INVALID_ARTIFACT_PATH');
  ensure(!path.isAbsolute(relativePath), 'ABSOLUTE_ARTIFACT_PATH_REQUIRED');
  ensure(!/[\\\0\r\n]/.test(relativePath), 'INVALID_ARTIFACT_PATH');
  const segments = relativePath.split('/');
  ensure(segments.every(segment => segment.length > 0 && segment !== '.'), 'INVALID_ARTIFACT_PATH');
  ensure(!segments.includes('..'), 'ARTIFACT_PATH_ESCAPE');
  return segments;
}

async function inspectArtifactFile(root, relativePath) {
  const segments = validateRelativePath(relativePath);
  const candidate = path.resolve(root.resolvedRoot, ...segments);
  ensure(isWithin(root.resolvedRoot, candidate), 'ARTIFACT_PATH_ESCAPE');

  let current = root.resolvedRoot;
  let info;
  for(const segment of segments) {
    current = path.join(current, segment);
    try {
      info = await lstat(current);
    } catch {
      fail('ARTIFACT_NOT_FOUND');
    }
    ensure(!info.isSymbolicLink(), 'ARTIFACT_SYMLINK_ESCAPE');
  }
  ensure(info?.isFile(), 'ARTIFACT_NOT_REGULAR_FILE');
  ensure(info.nlink === 1, 'ARTIFACT_HARDLINK_REJECTED');
  const canonical = await realpath(candidate);
  ensure(isWithin(root.canonicalRoot, canonical), 'ARTIFACT_PATH_ESCAPE');
  return { bytes: await readFile(canonical), canonical };
}

async function listOutputFiles(root, registryRelativePath) {
  const files = [];
  async function visit(directory, prefix = '') {
    for(const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const info = await lstat(absolutePath);
      ensure(!info.isSymbolicLink(), 'ARTIFACT_SYMLINK_ESCAPE');
      if(info.isDirectory()) await visit(absolutePath, relativePath);
      else {
        ensure(info.isFile(), 'ARTIFACT_NOT_REGULAR_FILE');
        ensure(info.nlink === 1, 'ARTIFACT_HARDLINK_REJECTED');
        if(path.posix.normalize(relativePath) !== path.posix.normalize(registryRelativePath)) files.push(path.posix.normalize(relativePath));
      }
    }
  }
  await visit(root.resolvedRoot);
  return files.sort();
}

async function ensureCompleteInventory(root, artifactPaths, registryRelativePath) {
  const actual = await listOutputFiles(root, registryRelativePath);
  const expected = [...new Set(artifactPaths.map(value => path.posix.normalize(value)))].sort();
  ensure(actual.length === expected.length && actual.every((value, index) => value === expected[index]), 'UNREGISTERED_ARTIFACT');
}

function checkUniqueAndProvenance(artifacts) {
  const ids = new Set();
  const paths = new Set();
  for(const artifact of artifacts) {
    ensure(!ids.has(artifact.artifactId), 'DUPLICATE_ARTIFACT_ID');
    ids.add(artifact.artifactId);
    const normalizedPath = path.posix.normalize(artifact.relativePath);
    ensure(!paths.has(normalizedPath), 'DUPLICATE_ARTIFACT_PATH');
    paths.add(normalizedPath);
    ensure(
      new Set(artifact.provenanceArtifactIds).size === artifact.provenanceArtifactIds.length,
      'DUPLICATE_PROVENANCE_REF',
    );
  }
  for(const artifact of artifacts) {
    ensure(artifact.provenanceArtifactIds.every(id => ids.has(id)), 'INVALID_PROVENANCE_REF');
  }

  const byId = new Map(artifacts.map(artifact => [artifact.artifactId, artifact]));
  const state = new Map();
  function visit(id) {
    if(state.get(id) === 'visiting') fail('CYCLIC_PROVENANCE');
    if(state.get(id) === 'visited') return;
    state.set(id, 'visiting');
    for(const dependency of byId.get(id).provenanceArtifactIds) visit(dependency);
    state.set(id, 'visited');
  }
  for(const id of ids) visit(id);
}

function checkSourceRegistryRefs(registryId, refs) {
  const ids = new Set();
  for(const ref of refs) {
    ensure(ref.registryId !== registryId, 'SOURCE_REGISTRY_SELF_REFERENCE');
    ensure(!ids.has(ref.registryId), 'DUPLICATE_SOURCE_REGISTRY');
    ids.add(ref.registryId);
  }
}

function checkRequiredArtifactKinds(claimBoundary, artifacts) {
  const required = REQUIRED_ARTIFACT_KINDS[claimBoundary];
  ensure(required, 'INVALID_CLAIM_BOUNDARY');
  const actual = new Set(artifacts.map(artifact => artifact.kind));
  for(const kind of required) {
    ensure(actual.has(kind), `MISSING_REQUIRED_ARTIFACT_KIND_${kind.toUpperCase()}`);
  }
}

function checkArtifactSensitivity(claimBoundary, artifacts) {
  for(const artifact of artifacts) {
    if(artifact.kind === 'provider_response') {
      ensure(artifact.sensitivity === 'restricted', 'PROVIDER_RESPONSE_MUST_BE_RESTRICTED');
    }
    if(
      claimBoundary === 'real_user_authorized'
      && !['scoring_policy', 'checksum_manifest'].includes(artifact.kind)
    ) {
      ensure(
        artifact.sensitivity === 'private' || artifact.sensitivity === 'restricted',
        'REAL_USER_ARTIFACT_MUST_BE_PRIVATE',
      );
    }
  }
}

function validateSchema(value) {
  ensure(validateRegistrySchema(value), 'INVALID_ARTIFACT_REGISTRY');
}

function validateWriterInput(input) {
  assertExactKeys(input, TOP_LEVEL_INPUT_KEYS);
  assertExactKeys(input.identity, IDENTITY_KEYS);
  if(input.authorization !== null) {
    assertExactKeys(input.authorization, AUTHORIZATION_KEYS);
    assertExactKeys(input.authorization.caps, CAPS_KEYS);
  }
  ensure(Array.isArray(input.artifacts), 'INVALID_ARTIFACT_REGISTRY');
  ensure(Array.isArray(input.sourceRegistryRefs), 'INVALID_ARTIFACT_REGISTRY');
  for(const ref of input.sourceRegistryRefs) {
    assertExactKeys(ref, SOURCE_REGISTRY_REF_KEYS);
    ensure(Array.isArray(ref.artifactIds), 'INVALID_ARTIFACT_REGISTRY');
  }
  for(const artifact of input.artifacts) {
    assertExactKeys(artifact, ARTIFACT_INPUT_KEYS);
    ensure(typeof artifact.artifactId === 'string', 'INVALID_ARTIFACT_REGISTRY');
    ensure(typeof artifact.relativePath === 'string', 'INVALID_ARTIFACT_REGISTRY');
    ensure(Array.isArray(artifact.provenanceArtifactIds), 'INVALID_ARTIFACT_REGISTRY');
  }
}

function normalizeSourceRegistryRefs(value) {
  return [...value]
    .map(ref => ({
      registryId: ref.registryId,
      registryHash: ref.registryHash,
      artifactIds: [...ref.artifactIds].sort(),
    }))
    .sort((left, right) => left.registryId.localeCompare(right.registryId));
}

function normalizeIdentity(value) {
  return Object.fromEntries([...IDENTITY_KEYS].map(key => [key, value[key]]));
}

function normalizeAuthorization(value) {
  if(value === null) return null;
  return {
    approvalHash: value.approvalHash,
    evidenceRefHash: value.evidenceRefHash,
    expiresAt: value.expiresAt,
    caps: Object.fromEntries([...CAPS_KEYS].map(key => [key, value.caps[key]])),
  };
}

export function registryHash(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Freeze a metadata-only registry inside a new persistent run directory.
 * Artifact payload bytes are hashed in place and are never copied into the registry.
 */
export async function createArtifactRegistry(input, options = {}) {
  validateWriterInput(input);
  const root = await inspectOutputRoot(input.outputRoot, options.allowEphemeralForTest === true);
  checkRequiredArtifactKinds(input.claimBoundary, input.artifacts);
  checkArtifactSensitivity(input.claimBoundary, input.artifacts);
  checkUniqueAndProvenance(input.artifacts);
  checkSourceRegistryRefs(input.registryId, input.sourceRegistryRefs);
  for(const artifact of input.artifacts) validateRelativePath(artifact.relativePath);

  const registryRelativePath = REGISTRY_FILENAME;
  validateRelativePath(registryRelativePath);
  ensure(
    !input.artifacts.some(artifact => path.posix.normalize(artifact.relativePath) === path.posix.normalize(registryRelativePath)),
    'REGISTRY_SELF_REFERENCE',
  );
  await ensureCompleteInventory(root, input.artifacts.map(artifact => artifact.relativePath), registryRelativePath);

  const artifacts = [];
  const canonicalPaths = new Set();
  for(const descriptor of [...input.artifacts].sort((left, right) => left.artifactId.localeCompare(right.artifactId))) {
    const inspected = await inspectArtifactFile(root, descriptor.relativePath);
    ensure(!canonicalPaths.has(inspected.canonical), 'DUPLICATE_ARTIFACT_PATH');
    canonicalPaths.add(inspected.canonical);
    artifacts.push({
      artifactId: descriptor.artifactId,
      kind: descriptor.kind,
      relativePath: descriptor.relativePath,
      sha256: registryHash(inspected.bytes),
      byteLength: inspected.bytes.length,
      sensitivity: descriptor.sensitivity,
      provenanceArtifactIds: [...descriptor.provenanceArtifactIds].sort(),
      createdAt: descriptor.createdAt,
    });
  }

  const registry = {
    version: input.version,
    registryId: input.registryId,
    revision: input.revision,
    claimBoundary: input.claimBoundary,
    outputRoot: root.canonicalRoot,
    createdAt: input.createdAt,
    identity: normalizeIdentity(input.identity),
    authorization: normalizeAuthorization(input.authorization),
    sourceRegistryRefs: normalizeSourceRegistryRefs(input.sourceRegistryRefs),
    artifacts,
  };
  validateSchema(registry);
  checkUniqueAndProvenance(registry.artifacts);
  checkSourceRegistryRefs(registry.registryId, registry.sourceRegistryRefs);
  checkRequiredArtifactKinds(registry.claimBoundary, registry.artifacts);
  checkArtifactSensitivity(registry.claimBoundary, registry.artifacts);

  const registryPath = path.resolve(root.resolvedRoot, ...registryRelativePath.split('/'));
  ensure(isWithin(root.resolvedRoot, registryPath), 'ARTIFACT_PATH_ESCAPE');
  const bytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`);
  try {
    await writeFile(registryPath, bytes, { flag: 'wx', mode: 0o600 });
  } catch(error) {
    if(error?.code === 'EEXIST') fail('REGISTRY_ALREADY_EXISTS');
    throw error;
  }
  return { registry, registryHash: registryHash(bytes), registryPath };
}

/** Offline-only verification: no credentials, provider calls, or payload copying. */
export async function preflightArtifactRegistry(registryPath, options = {}) {
  ensure(typeof registryPath === 'string' && path.isAbsolute(registryPath), 'ABSOLUTE_REGISTRY_PATH_REQUIRED');
  let registryInfo;
  try {
    registryInfo = await lstat(registryPath);
  } catch {
    fail('REGISTRY_NOT_FOUND');
  }
  ensure(!registryInfo.isSymbolicLink(), 'REGISTRY_SYMLINK_ESCAPE');
  ensure(registryInfo.isFile(), 'REGISTRY_NOT_REGULAR_FILE');
  ensure(registryInfo.nlink === 1, 'REGISTRY_HARDLINK_REJECTED');
  ensure((registryInfo.mode & 0o077) === 0, 'REGISTRY_PERMISSIONS');
  const bytes = await readFile(registryPath);
  const actualRegistryHash = registryHash(bytes);
  if(options.expectedRegistryHash !== undefined) {
    ensure(HASH_PATTERN.test(options.expectedRegistryHash), 'INVALID_EXPECTED_REGISTRY_HASH');
    ensure(actualRegistryHash === options.expectedRegistryHash, 'REGISTRY_HASH_MISMATCH');
  }

  let registry;
  try {
    registry = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('INVALID_ARTIFACT_REGISTRY');
  }
  validateSchema(registry);
  checkUniqueAndProvenance(registry.artifacts);
  checkSourceRegistryRefs(registry.registryId, registry.sourceRegistryRefs);
  checkRequiredArtifactKinds(registry.claimBoundary, registry.artifacts);
  checkArtifactSensitivity(registry.claimBoundary, registry.artifacts);
  const root = await inspectOutputRoot(registry.outputRoot, options.allowEphemeralForTest === true);
  const canonicalRegistryPath = await realpath(registryPath);
  ensure(path.dirname(canonicalRegistryPath) === root.canonicalRoot, 'REGISTRY_PATH_ESCAPE');
  await ensureCompleteInventory(root, registry.artifacts.map(artifact => artifact.relativePath), path.basename(canonicalRegistryPath));

  const canonicalPaths = new Set();
  let totalBytes = 0;
  for(const artifact of registry.artifacts) {
    const inspected = await inspectArtifactFile(root, artifact.relativePath);
    ensure(!canonicalPaths.has(inspected.canonical), 'DUPLICATE_ARTIFACT_PATH');
    canonicalPaths.add(inspected.canonical);
    ensure(inspected.bytes.length === artifact.byteLength, 'ARTIFACT_LENGTH_MISMATCH');
    ensure(registryHash(inspected.bytes) === artifact.sha256, 'ARTIFACT_HASH_MISMATCH');
    totalBytes += inspected.bytes.length;
  }

  return {
    ready: true,
    blockers: [],
    credentialsRead: false,
    externalCalls: 0,
    registry,
    registryHash: actualRegistryHash,
    outputRoot: root.canonicalRoot,
    summary: { artifacts: registry.artifacts.length, totalBytes },
  };
}
