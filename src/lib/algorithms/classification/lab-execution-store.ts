import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LabAsset } from './lab-contract';
import {
  TrustedPrivacyControlEventSchema,
  parseLabJobV2,
  type LabJobRecordV2,
  type TrustedPrivacyControlEvent
} from './lab-execution-contract';
import { digest, stable } from './stage-a-contract';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const pendingNamePattern = /^\.pending-([A-Za-z0-9][A-Za-z0-9._:-]{0,127})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const privacyLedgerName = '.privacy-events';
const terminalStatuses = new Set([
  'succeeded',
  'needs_review',
  'failed_retryable',
  'failed_terminal',
  'cancelled'
]);
const allowedTransitions = new Set([
  'pending>processing',
  'pending>cancelled',
  'pending>failed_retryable',
  'pending>failed_terminal',
  'processing>succeeded',
  'processing>needs_review',
  'processing>failed_retryable',
  'processing>failed_terminal',
  'processing>cancelled'
]);

type AssetRefV2 = LabJobRecordV2['assetRefs'][number];

export type LabV2ScanEntry =
  | { kind: 'record'; record: LabJobRecordV2 }
  | { kind: 'corrupt'; jobId: string; code: 'LAB_STORE_CORRUPT' };

export type LabV2OrphanCleanupResult = Readonly<{ removed: number; corrupt: number }>;

export const CLASSIFICATION_LAB_V2_STORE_CAPABILITIES = Object.freeze({
  coordinationScope: 'single_process',
  crossProcessCas: false
} as const);

class LabV2StoreError extends Error {
  constructor(readonly code: string) { super(code); }
}

function fail(code: string): never { throw new LabV2StoreError(code); }
function clone<T>(value: T): T { return structuredClone(value); }
function equal(left: unknown, right: unknown): boolean { return stable(left) === stable(right); }
function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function validateId(value: string, code: string): void { if(!idPattern.test(value)) fail(code); }
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

const mutexes = new Map<string, Promise<void>>();
type MutexLease = { active: boolean };
const heldMutexes = new AsyncLocalStorage<ReadonlyMap<string, MutexLease>>();

async function withMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const held = heldMutexes.getStore();
  if(held?.get(key)?.active) return operation();
  const previous = mutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => turn);
  mutexes.set(key, tail);
  await previous;
  const lease: MutexLease = { active: true };
  const nextHeld = new Map(held ?? []);
  nextHeld.set(key, lease);
  try { return await heldMutexes.run(nextHeld, operation); }
  finally {
    lease.active = false;
    release();
    if(mutexes.get(key) === tail) mutexes.delete(key);
  }
}

function assertOwnerOnly(mode: number): void {
  if((mode & 0o077) !== 0) fail('LAB_STORE_CORRUPT');
}

function assertOwned(uid: number): void {
  if(typeof process.getuid === 'function' && uid !== process.getuid()) fail('LAB_STORE_CORRUPT');
}

async function assertDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if(!info.isDirectory() || info.isSymbolicLink()) fail('LAB_STORE_CORRUPT');
  assertOwnerOnly(info.mode);
  assertOwned(info.uid);
}

async function openRegularNoFollow(filename: string): Promise<FileHandle> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let handle: FileHandle;
  try { handle = await open(filename, fsConstants.O_RDONLY | noFollow); }
  catch(error) {
    if(errorCode(error) === 'ELOOP') fail('LAB_STORE_CORRUPT');
    throw error;
  }
  try {
    const info = await handle.stat();
    if(!info.isFile() || info.nlink !== 1) fail('LAB_STORE_CORRUPT');
    assertOwnerOnly(info.mode);
    assertOwned(info.uid);
    return handle;
  } catch(error) {
    await handle.close();
    throw error;
  }
}

async function readRegularFile(filename: string): Promise<Buffer> {
  const handle = await openRegularNoFollow(filename);
  try { return await handle.readFile(); }
  finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function writeExclusiveSynced(filename: string, bytes: Uint8Array): Promise<void> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    filename,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

async function assertRegularPath(filename: string): Promise<void> {
  const handle = await openRegularNoFollow(filename);
  await handle.close();
}

async function assertJobPendingDirectory(directory: string): Promise<void> {
  await assertDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  for(const entry of entries) {
    if(entry.name === 'job.json') {
      if(!entry.isFile() || entry.isSymbolicLink()) fail('LAB_STORE_CORRUPT');
      await assertRegularPath(path.join(directory, entry.name));
      continue;
    }
    if(entry.name !== 'assets' || !entry.isDirectory() || entry.isSymbolicLink()) fail('LAB_STORE_CORRUPT');
    const assetsDirectory = path.join(directory, 'assets');
    await assertDirectory(assetsDirectory);
    const assets = await readdir(assetsDirectory, { withFileTypes: true });
    for(const asset of assets) {
      if(!idPattern.test(asset.name) || !asset.isFile() || asset.isSymbolicLink()) fail('LAB_STORE_CORRUPT');
      await assertRegularPath(path.join(assetsDirectory, asset.name));
    }
  }
}

async function assertPrivacyPendingDirectory(directory: string): Promise<void> {
  await assertDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if(entries.length > 1) fail('LAB_PRIVACY_LEDGER_CORRUPT');
  if(entries.length === 1) {
    const [entry] = entries;
    if(entry.name !== 'event.json' || !entry.isFile() || entry.isSymbolicLink()) {
      fail('LAB_PRIVACY_LEDGER_CORRUPT');
    }
    await assertRegularPath(path.join(directory, entry.name));
  }
}

function recordJson(record: LabJobRecordV2): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function privacyEventJson(event: TrustedPrivacyControlEvent): Buffer {
  return Buffer.from(`${JSON.stringify(event, null, 2)}\n`, 'utf8');
}

function parseDiskRecord(raw: Buffer): LabJobRecordV2 {
  try {
    const record = parseLabJobV2(JSON.parse(raw.toString('utf8')));
    if(record.result !== undefined && digest(record.result) !== record.resultDigest) fail('LAB_STORE_CORRUPT');
    return record;
  }
  catch { fail('LAB_STORE_CORRUPT'); }
}

function parseDiskPrivacyEvent(raw: Buffer): TrustedPrivacyControlEvent {
  try { return TrustedPrivacyControlEventSchema.parse(JSON.parse(raw.toString('utf8'))); }
  catch { fail('LAB_PRIVACY_LEDGER_CORRUPT'); }
}

function assetManifest(record: LabJobRecordV2): unknown[] {
  return [...record.assetRefs]
    .map(ref => ({
      evidenceId: ref.evidenceId,
      filename: ref.filename,
      mimeType: ref.mimeType,
      byteLength: ref.byteLength,
      sourceHash: ref.sourceHash
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function assertCreateRecord(record: LabJobRecordV2): void {
  if(record.revision !== 0 || record.status !== 'pending') fail('LAB_STORE_CORRUPT');
  if(record.transitions.length !== 1) fail('LAB_STORE_CORRUPT');
  const transition = record.transitions[0];
  if(transition.from !== 'none' || transition.to !== 'pending' || transition.revision !== 0) fail('LAB_STORE_CORRUPT');
  if(record.actions.length || record.privacyEvents.length) fail('LAB_STORE_CORRUPT');
}

function assertAssetSet(record: LabJobRecordV2, assets: readonly LabAsset[]): void {
  const refs = new Map<string, AssetRefV2>();
  for(const ref of record.assetRefs) {
    validateId(ref.evidenceId, 'LAB_STORE_CORRUPT');
    if(refs.has(ref.evidenceId)) fail('LAB_STORE_CORRUPT');
    refs.set(ref.evidenceId, ref);
  }
  const seen = new Set<string>();
  for(const asset of assets) {
    validateId(asset.evidenceId, 'LAB_STORE_CORRUPT');
    if(seen.has(asset.evidenceId)) fail('LAB_STORE_CORRUPT');
    seen.add(asset.evidenceId);
    const ref = refs.get(asset.evidenceId);
    if(!ref
      || ref.mimeType !== asset.mimeType
      || ref.byteLength !== asset.bytes.byteLength
      || ref.sourceHash !== hashBytes(asset.bytes)) fail('LAB_ASSET_MANIFEST_MISMATCH');
  }
  if(seen.size !== refs.size) fail('LAB_ASSET_MANIFEST_MISMATCH');
}

function assertSameCreate(existing: LabJobRecordV2, incoming: LabJobRecordV2): void {
  const immutableAuthorization = (record: LabJobRecordV2) => {
    const { state: _state, revokedAt: _revokedAt, ...immutable } = record.authorization;
    return immutable;
  };
  if(existing.idempotencyKey !== incoming.idempotencyKey
    || existing.runIdentityDigest !== incoming.runIdentityDigest
    || existing.contentDigest !== incoming.contentDigest
    || existing.runId !== incoming.runId
    || existing.attemptRevision !== incoming.attemptRevision
    || !equal(existing.executionProfile, incoming.executionProfile)
    || !equal(existing.semanticContext, incoming.semanticContext)
    || !equal(existing.budgetPolicy, incoming.budgetPolicy)
    || !equal(immutableAuthorization(existing), immutableAuthorization(incoming))
    || !equal(existing.envelope, incoming.envelope)
    || !equal(existing.originalTextByEvidenceId, incoming.originalTextByEvidenceId)
    || !equal(assetManifest(existing), assetManifest(incoming))) fail('IDEMPOTENCY_CONFLICT');
}

function assertPrefix<T>(current: readonly T[], next: readonly T[], code: string): void {
  if(next.length < current.length || !equal(current, next.slice(0, current.length))) fail(code);
}

function assertUniqueEventIds(record: LabJobRecordV2): void {
  const ids = new Set<string>();
  for(const event of record.privacyEvents) {
    if(ids.has(event.eventId)) fail('LAB_PRIVACY_EVENT_ID_CONFLICT');
    ids.add(event.eventId);
  }
}

function assertUniqueActionIds(record: LabJobRecordV2): void {
  const ids = new Set<string>();
  for(const action of record.actions) {
    if(ids.has(action.actionId)) fail('LAB_ACTION_ID_CONFLICT');
    ids.add(action.actionId);
  }
}

function assertAuthorizationTransition(current: LabJobRecordV2, next: LabJobRecordV2): void {
  const { state: _currentState, revokedAt: _currentRevokedAt, ...immutableCurrent } = current.authorization;
  const { state: _nextState, revokedAt: _nextRevokedAt, ...immutableNext } = next.authorization;
  if(!equal(immutableCurrent, immutableNext)) fail('LAB_JOB_IDENTITY_CHANGED');
  if(current.authorization.state === 'revoked' && next.authorization.state !== 'revoked') fail('LAB_INVALID_STATE_TRANSITION');
  if(current.authorization.state === next.authorization.state
    && current.authorization.revokedAt !== next.authorization.revokedAt) fail('LAB_INVALID_STATE_TRANSITION');
  if(current.authorization.state === 'active' && next.authorization.state === 'revoked' && !next.authorization.revokedAt) {
    fail('LAB_INVALID_STATE_TRANSITION');
  }
}

function assertPrivacyEventTransition(current: LabJobRecordV2, next: LabJobRecordV2): void {
  const appended = next.privacyEvents.slice(current.privacyEvents.length);
  const authorizationChanged = current.authorization.state !== next.authorization.state;
  const hasRevocation = appended.some(event => event.kind === 'authorization_revoked');
  if(authorizationChanged !== hasRevocation) fail('LAB_INVALID_PRIVACY_TRANSITION');

  const evidenceIds = new Set(next.envelope.evidence.map(evidence => evidence.evidenceId));
  for(const event of appended) {
    if(event.authorityRef !== next.authorization.authorityRef
      || event.authorizationRevision !== next.authorization.authorizationRevision
      || !equal(event.scope, next.envelope.scope)) fail('LAB_INVALID_PRIVACY_TRANSITION');
    if(event.kind === 'evidence_deleted' && !event.evidenceIds.some(evidenceId => evidenceIds.has(evidenceId))) {
      fail('LAB_INVALID_PRIVACY_TRANSITION');
    }
  }

  if(appended.length && !terminalStatuses.has(current.status)) {
    if(next.status !== 'cancelled') fail('LAB_INVALID_PRIVACY_TRANSITION');
    const expectedReason = hasRevocation ? 'authorization_revoked' : 'evidence_changed';
    if(next.termination?.reason !== expectedReason) fail('LAB_INVALID_PRIVACY_TRANSITION');
  }
}

function assertOutcomeTransition(current: LabJobRecordV2, next: LabJobRecordV2): void {
  const hadOutcome = current.result !== undefined || current.resultDigest !== undefined || current.metrics !== undefined;
  const hasOutcome = next.result !== undefined || next.resultDigest !== undefined || next.metrics !== undefined;
  if(hadOutcome) {
    if(!equal(current.result, next.result)
      || current.resultDigest !== next.resultDigest
      || !equal(current.metrics, next.metrics)) fail('LAB_JOB_OUTCOME_CHANGED');
  } else if(hasOutcome) {
    if(current.status !== 'processing' || !['succeeded', 'needs_review'].includes(next.status)) fail('LAB_JOB_OUTCOME_CHANGED');
    if(next.result === undefined || next.resultDigest === undefined || next.metrics === undefined) fail('LAB_JOB_OUTCOME_CHANGED');
  }
  if(next.result !== undefined && digest(next.result) !== next.resultDigest) fail('LAB_RESULT_DIGEST_MISMATCH');
}

function assertStatusTransition(current: LabJobRecordV2, next: LabJobRecordV2): void {
  const changed = current.status !== next.status;
  if(changed && !allowedTransitions.has(`${current.status}>${next.status}`)) fail('LAB_INVALID_STATE_TRANSITION');
  if(!changed && !terminalStatuses.has(current.status)) fail('LAB_INVALID_STATE_TRANSITION');
  if(changed) {
    if(next.transitions.length !== current.transitions.length + 1) fail('LAB_INVALID_TRANSITION_LEDGER');
    const transition = next.transitions.at(-1)!;
    if(transition.from !== current.status
      || transition.to !== next.status
      || transition.revision !== current.revision + 1) fail('LAB_INVALID_TRANSITION_LEDGER');
  } else if(!equal(current.transitions, next.transitions)) fail('LAB_INVALID_TRANSITION_LEDGER');
}

function assertImmutableFields(current: LabJobRecordV2, next: LabJobRecordV2): void {
  const keys: Array<keyof LabJobRecordV2> = [
    'version', 'jobId', 'runId', 'idempotencyKey', 'contentDigest', 'runIdentityDigest',
    'attemptRevision', 'executionProfile', 'semanticContext', 'budgetPolicy', 'createdAt', 'deadlineAt', 'envelope',
    'originalTextByEvidenceId', 'assetRefs'
  ];
  for(const key of keys) if(!equal(current[key], next[key])) fail('LAB_JOB_IDENTITY_CHANGED');
}

function assertMonotonicTime(current: LabJobRecordV2, next: LabJobRecordV2): void {
  if(Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) fail('LAB_INVALID_TIME_ORDER');
  if(current.startedAt !== undefined && next.startedAt !== current.startedAt) fail('LAB_INVALID_TIME_ORDER');
  if(current.finishedAt !== undefined && next.finishedAt !== current.finishedAt) fail('LAB_INVALID_TIME_ORDER');
}

function assertLifecycleFields(current: LabJobRecordV2, next: LabJobRecordV2): void {
  const statusChanged = current.status !== next.status;
  if(!statusChanged) {
    if(next.startedAt !== current.startedAt
      || next.finishedAt !== current.finishedAt
      || !equal(next.processingOwner, current.processingOwner)
      || !equal(next.termination, current.termination)
      || !equal(next.error, current.error)) fail('LAB_JOB_LIFECYCLE_CHANGED');
    return;
  }

  if(current.status === 'pending' && next.status === 'processing') {
    if(current.startedAt !== undefined
      || current.processingOwner !== undefined
      || next.startedAt === undefined
      || next.processingOwner === undefined
      || next.finishedAt !== undefined
      || next.termination !== undefined
      || next.error !== undefined) fail('LAB_JOB_LIFECYCLE_CHANGED');
    return;
  }

  if(!terminalStatuses.has(next.status) || next.finishedAt === undefined || next.updatedAt !== next.finishedAt) {
    fail('LAB_JOB_LIFECYCLE_CHANGED');
  }
  if(current.status === 'pending' && (next.startedAt !== undefined || next.processingOwner !== undefined)) {
    fail('LAB_JOB_LIFECYCLE_CHANGED');
  }
  if(current.status === 'processing'
    && (next.startedAt !== current.startedAt || !equal(next.processingOwner, current.processingOwner))) {
    fail('LAB_JOB_LIFECYCLE_CHANGED');
  }
}

function assertCasMutation(current: LabJobRecordV2, next: LabJobRecordV2): void {
  assertImmutableFields(current, next);
  assertPrefix(current.actions, next.actions, 'LAB_ACTION_LEDGER_CHANGED');
  assertPrefix(current.privacyEvents, next.privacyEvents, 'LAB_PRIVACY_EVENT_LEDGER_CHANGED');
  assertUniqueActionIds(next);
  assertUniqueEventIds(next);
  assertAuthorizationTransition(current, next);
  assertPrivacyEventTransition(current, next);
  assertOutcomeTransition(current, next);
  assertStatusTransition(current, next);
  assertLifecycleFields(current, next);
  assertMonotonicTime(current, next);
}

export class FileClassificationLabV2Store {
  readonly root: string;
  readonly capabilities = CLASSIFICATION_LAB_V2_STORE_CAPABILITIES;
  private canonicalRoot?: string;

  constructor(baseRoot = process.env.CLASSIFICATION_LAB_DATA_DIR || path.join(tmpdir(), 'sgx-classification-lab')) {
    this.root = path.resolve(baseRoot, 'v2');
  }

  private async ensureRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertDirectory(this.root);
    const canonical = await realpath(this.root);
    if(this.canonicalRoot !== undefined && this.canonicalRoot !== canonical) fail('LAB_STORE_CORRUPT');
    this.canonicalRoot ??= canonical;
    return this.canonicalRoot;
  }

  async canonicalRootPath(): Promise<string> {
    return this.ensureRoot();
  }

  async coordinationKey(jobId?: string): Promise<string> {
    if(jobId !== undefined) validateId(jobId, 'INVALID_JOB_ID');
    return `${await this.ensureRoot()}\0${jobId ?? '$root'}`;
  }

  async withRootExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return withMutex(await this.coordinationKey(), operation);
  }

  /**
   * Trusted service-layer coordination primitive. It is intentionally not an
   * authorization boundary and must never be exposed as an HTTP/Provider API.
   */
  async withJobExclusive<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    return withMutex(await this.lockKey(jobId), operation);
  }

  private jobDirectory(jobId: string): string {
    validateId(jobId, 'INVALID_JOB_ID');
    return path.join(this.root, jobId);
  }

  private async lockKey(jobId: string): Promise<string> {
    return this.coordinationKey(jobId);
  }

  private privacyLedgerDirectory(): string {
    return path.join(this.root, privacyLedgerName);
  }

  private async ensurePrivacyLedger(): Promise<string> {
    const directory = this.privacyLedgerDirectory();
    try {
      await this.ensureRoot();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await assertDirectory(directory);
    }
    catch(error) {
      if(errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') throw error;
      fail('LAB_PRIVACY_LEDGER_CORRUPT');
    }
    return directory;
  }

  private privacyEventDirectory(eventId: string): string {
    validateId(eventId, 'INVALID_PRIVACY_EVENT_ID');
    return path.join(this.privacyLedgerDirectory(), eventId);
  }

  private async getPrivacyEventUnlocked(eventId: string): Promise<TrustedPrivacyControlEvent | undefined> {
    const directory = this.privacyEventDirectory(eventId);
    try { await assertDirectory(directory); }
    catch(error) {
      if(errorCode(error) === 'ENOENT') return undefined;
      if(error instanceof LabV2StoreError) fail('LAB_PRIVACY_LEDGER_CORRUPT');
      throw error;
    }
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      if(entries.length !== 1
        || entries[0].name !== 'event.json'
        || !entries[0].isFile()
        || entries[0].isSymbolicLink()) fail('LAB_PRIVACY_LEDGER_CORRUPT');
      const event = parseDiskPrivacyEvent(await readRegularFile(path.join(directory, 'event.json')));
      if(event.eventId !== eventId) fail('LAB_PRIVACY_LEDGER_CORRUPT');
      return event;
    } catch(error) {
      if(error instanceof LabV2StoreError) throw error;
      fail('LAB_PRIVACY_LEDGER_CORRUPT');
    }
  }

  private async listPrivacyEventsUnlocked(): Promise<TrustedPrivacyControlEvent[]> {
    const ledger = await this.ensurePrivacyLedger();
    const entries = await readdir(ledger, { withFileTypes: true });
    const events: TrustedPrivacyControlEvent[] = [];
    for(const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if(!idPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        fail('LAB_PRIVACY_LEDGER_CORRUPT');
      }
      const event = await this.getPrivacyEventUnlocked(entry.name);
      if(!event) fail('LAB_PRIVACY_LEDGER_CORRUPT');
      events.push(event);
    }
    return events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
      || left.eventId.localeCompare(right.eventId));
  }

  private async getUnlocked(jobId: string): Promise<LabJobRecordV2 | undefined> {
    const directory = this.jobDirectory(jobId);
    try { await assertDirectory(directory); }
    catch(error) {
      if(errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const raw = await readRegularFile(path.join(directory, 'job.json'));
      return parseDiskRecord(raw);
    } catch(error) {
      if(error instanceof LabV2StoreError) throw error;
      fail('LAB_STORE_CORRUPT');
    }
  }

  async get(jobId: string): Promise<LabJobRecordV2 | undefined> {
    return withMutex(await this.lockKey(jobId), () => this.getUnlocked(jobId));
  }

  /**
   * Persists an event that the service layer has already verified against the
   * trusted guard provider. Recovery/tests may replay it, but untrusted callers
   * must enter through applyTrustedPrivacyEvent.
   */
  async recordVerifiedPrivacyEvent(
    eventInput: TrustedPrivacyControlEvent
  ): Promise<{ event: TrustedPrivacyControlEvent; created: boolean }> {
    const event = TrustedPrivacyControlEventSchema.parse(clone(eventInput));
    return this.withRootExclusive(async () => {
      const ledger = await this.ensurePrivacyLedger();
      const existing = await this.getPrivacyEventUnlocked(event.eventId);
      if(existing) {
        if(!equal(existing, event)) fail('LAB_PRIVACY_EVENT_ID_CONFLICT');
        return { event: existing, created: false };
      }

      const temporary = path.join(ledger, `.pending-${event.eventId}-${randomUUID()}`);
      await mkdir(temporary, { mode: 0o700 });
      try {
        await assertDirectory(temporary);
        await writeExclusiveSynced(path.join(temporary, 'event.json'), privacyEventJson(event));
        await syncDirectory(temporary);
        try { await rename(temporary, this.privacyEventDirectory(event.eventId)); }
        catch(error) {
          if(!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error;
          await rm(temporary, { recursive: true, force: true });
          const raced = await this.getPrivacyEventUnlocked(event.eventId);
          if(!raced) throw error;
          if(!equal(raced, event)) fail('LAB_PRIVACY_EVENT_ID_CONFLICT');
          return { event: raced, created: false };
        }
        await syncDirectory(ledger);
        return { event, created: true };
      } catch(error) {
        await rm(temporary, { recursive: true, force: true });
        if(error instanceof LabV2StoreError) throw error;
        fail('LAB_PRIVACY_LEDGER_WRITE_FAILED');
      }
    });
  }

  async listPrivacyEvents(): Promise<TrustedPrivacyControlEvent[]> {
    return this.withRootExclusive(() => this.listPrivacyEventsUnlocked());
  }

  async create(recordInput: LabJobRecordV2, assets: readonly LabAsset[]): Promise<{ record: LabJobRecordV2; created: boolean }> {
    validateId(recordInput.jobId, 'INVALID_JOB_ID');
    return this.withRootExclusive(async () => {
      const lockKey = await this.lockKey(recordInput.jobId);
      return withMutex(lockKey, async () => {
        const existing = await this.getUnlocked(recordInput.jobId);
        if(existing) {
          if(existing.idempotencyKey !== recordInput.idempotencyKey
            || existing.runIdentityDigest !== recordInput.runIdentityDigest
            || existing.contentDigest !== recordInput.contentDigest) fail('IDEMPOTENCY_CONFLICT');
          const record = parseLabJobV2(clone(recordInput));
          assertCreateRecord(record);
          assertSameCreate(existing, record);
          assertAssetSet(record, assets);
          return { record: existing, created: false };
        }
        const record = parseLabJobV2(clone(recordInput));
        assertCreateRecord(record);
        assertAssetSet(record, assets);
        const temporary = path.join(this.root, `.pending-${record.jobId}-${randomUUID()}`);
        const assetsDirectory = path.join(temporary, 'assets');
        await mkdir(assetsDirectory, { recursive: true, mode: 0o700 });
        try {
          await assertDirectory(temporary);
          await assertDirectory(assetsDirectory);
          for(const asset of assets) await writeExclusiveSynced(path.join(assetsDirectory, asset.evidenceId), asset.bytes);
          await syncDirectory(assetsDirectory);
          await writeExclusiveSynced(path.join(temporary, 'job.json'), recordJson(record));
          await syncDirectory(temporary);
          try { await rename(temporary, this.jobDirectory(record.jobId)); }
          catch(error) {
            if(!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error;
            await rm(temporary, { recursive: true, force: true });
            const raced = await this.getUnlocked(record.jobId);
            if(!raced) throw error;
            assertSameCreate(raced, record);
            return { record: raced, created: false };
          }
          await syncDirectory(this.root);
          return { record, created: true };
        } catch(error) {
          await rm(temporary, { recursive: true, force: true });
          if(error instanceof LabV2StoreError) throw error;
          fail('LAB_STORE_WRITE_FAILED');
        }
      });
    });
  }

  /**
   * Trusted internal durability primitive. Schema/lifecycle invariants are
   * enforced here; actor, guard, and purpose authorization belong to the
   * service operation that invokes it.
   */
  async compareAndSetTrusted(
    jobId: string,
    expectedRevision: number,
    transform: (current: LabJobRecordV2) => LabJobRecordV2
  ): Promise<{ ok: boolean; record: LabJobRecordV2 }> {
    const lockKey = await this.lockKey(jobId);
    return withMutex(lockKey, async () => {
      const current = await this.getUnlocked(jobId);
      if(!current) fail('LAB_JOB_NOT_FOUND');
      if(current.revision !== expectedRevision) return { ok: false, record: current };
      const transformed = transform(clone(current));
      if(transformed.revision !== current.revision) fail('LAB_JOB_REVISION_CONFLICT');
      const next = parseLabJobV2({ ...transformed, revision: current.revision + 1 });
      assertCasMutation(current, next);
      const directory = this.jobDirectory(jobId);
      await assertDirectory(directory);
      const currentFile = path.join(directory, 'job.json');
      const currentHandle = await openRegularNoFollow(currentFile);
      await currentHandle.close();
      const temporary = path.join(directory, `job-${randomUUID()}.tmp`);
      try {
        await writeExclusiveSynced(temporary, recordJson(next));
        await rename(temporary, currentFile);
        await syncDirectory(directory);
      } catch(error) {
        await rm(temporary, { force: true });
        if(error instanceof LabV2StoreError) throw error;
        fail('LAB_STORE_WRITE_FAILED');
      }
      return { ok: true, record: next };
    });
  }

  async list(limit = 20): Promise<LabJobRecordV2[]> {
    const records: LabJobRecordV2[] = [];
    for await (const entry of this.scanAll()) if(entry.kind === 'record') records.push(entry.record);
    return records
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }

  async cleanupOrphanPending(): Promise<LabV2OrphanCleanupResult> {
    return this.withRootExclusive(async () => {
      await this.ensureRoot();
      let removed = 0;
      let corrupt = 0;
      let rootChanged = false;
      const rootEntries = await readdir(this.root, { withFileTypes: true });
      for(const entry of rootEntries) {
        if(!entry.name.startsWith('.pending-')) continue;
        const pending = path.join(this.root, entry.name);
        if(!pendingNamePattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          corrupt += 1;
          continue;
        }
        try {
          await assertJobPendingDirectory(pending);
          await rm(pending, { recursive: true });
          removed += 1;
          rootChanged = true;
        } catch {
          corrupt += 1;
        }
      }
      if(rootChanged) await syncDirectory(this.root);

      const ledger = this.privacyLedgerDirectory();
      try { await assertDirectory(ledger); }
      catch(error) {
        if(errorCode(error) === 'ENOENT') return { removed, corrupt };
        if(error instanceof LabV2StoreError) fail('LAB_PRIVACY_LEDGER_CORRUPT');
        throw error;
      }
      let ledgerChanged = false;
      const ledgerEntries = await readdir(ledger, { withFileTypes: true });
      for(const entry of ledgerEntries) {
        if(!entry.name.startsWith('.pending-')) continue;
        const pending = path.join(ledger, entry.name);
        if(!pendingNamePattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          corrupt += 1;
          continue;
        }
        try {
          await assertPrivacyPendingDirectory(pending);
          await rm(pending, { recursive: true });
          removed += 1;
          ledgerChanged = true;
        } catch {
          corrupt += 1;
        }
      }
      if(ledgerChanged) await syncDirectory(ledger);
      return { removed, corrupt };
    });
  }

  async *scanAll(): AsyncIterable<LabV2ScanEntry> {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    for(const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if(entry.name === privacyLedgerName) {
        try { await assertDirectory(path.join(this.root, privacyLedgerName)); }
        catch {
          yield { kind: 'corrupt', jobId: entry.name, code: 'LAB_STORE_CORRUPT' };
        }
        continue;
      }
      if(entry.name.startsWith('.pending-')) continue;
      if(!idPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        yield { kind: 'corrupt', jobId: entry.name, code: 'LAB_STORE_CORRUPT' };
        continue;
      }
      try {
        const record = await this.get(entry.name);
        if(!record || record.jobId !== entry.name) throw new Error('LAB_STORE_CORRUPT');
        yield { kind: 'record', record };
      } catch {
        yield { kind: 'corrupt', jobId: entry.name, code: 'LAB_STORE_CORRUPT' };
      }
    }
  }

  async readAsset(jobId: string, evidenceId: string): Promise<{ bytes: Buffer; ref: AssetRefV2 }> {
    validateId(evidenceId, 'INVALID_EVIDENCE_ID');
    const lockKey = await this.lockKey(jobId);
    return withMutex(lockKey, async () => {
      const record = await this.getUnlocked(jobId);
      if(!record) fail('LAB_JOB_NOT_FOUND');
      const ref = record.assetRefs.find(value => value.evidenceId === evidenceId);
      if(!ref) fail('LAB_ASSET_NOT_FOUND');
      const assetsDirectory = path.join(this.jobDirectory(jobId), 'assets');
      let bytes: Buffer;
      try {
        await assertDirectory(assetsDirectory);
        bytes = await readRegularFile(path.join(assetsDirectory, evidenceId));
      } catch(error) {
        if(error instanceof LabV2StoreError) throw error;
        fail('LAB_STORE_CORRUPT');
      }
      if(bytes.byteLength !== ref.byteLength) fail('LAB_ASSET_LENGTH_MISMATCH');
      if(hashBytes(bytes) !== ref.sourceHash) fail('LAB_ASSET_HASH_MISMATCH');
      return { bytes, ref };
    });
  }
}
