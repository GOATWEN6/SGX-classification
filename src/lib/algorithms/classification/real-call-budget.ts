import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { stable } from './stage-a-contract';

export const REAL_CALL_AUTHORIZATION_VERSION = 'classification-real-call-authorization.1' as const;
export const REAL_CALL_LEDGER_VERSION = 'classification-real-call-ledger.1' as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });

const UsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  costMicroCny: z.number().int().nonnegative(),
}).strict();

export const RealCallAuthorizationSchema = z.object({
  version: z.literal(REAL_CALL_AUTHORIZATION_VERSION),
  authorizationId: id,
  providerVersion: id,
  modelVersion: id,
  caps: z.object({
    maxRequests: z.number().int().min(1).max(200),
    maxCostCny: z.number().positive().max(50),
    maxRetries: z.literal(0),
  }).strict(),
  openingUsage: z.object({
    requests: z.number().int().nonnegative().max(200),
    costCny: z.number().nonnegative().max(50),
    sourceRefs: z.array(z.string().min(1)).min(1),
  }).strict(),
  allowPersonMatching: z.boolean(),
  expiresAt: dateTime,
  authorizationEvidenceRef: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if(value.openingUsage.requests > value.caps.maxRequests) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'REAL_CALL_OPENING_USAGE_EXCEEDS_CAP', path: ['openingUsage', 'requests'] });
  }
  if(value.openingUsage.costCny > value.caps.maxCostCny) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'REAL_CALL_OPENING_USAGE_EXCEEDS_CAP', path: ['openingUsage', 'costCny'] });
  }
});

export type RealCallAuthorization = z.infer<typeof RealCallAuthorizationSchema>;

export const RealCallReservationSchema = z.object({
  authorizationId: id,
  reservationId: id,
  configDigest: sha256,
  jobId: id,
  runId: id,
  attemptRevision: z.number().int().positive(),
}).strict();

export type RealCallReservation = z.infer<typeof RealCallReservationSchema>;

const LedgerEntrySchema = z.object({
  ...RealCallReservationSchema.shape,
  executionProfileDigest: sha256,
  providerVersion: id,
  modelVersion: id,
  promptVersion: id,
  allowPersonMatching: z.boolean(),
  status: z.enum(['reserved', 'settled', 'uncertain']),
  reserved: UsageSchema,
  actual: UsageSchema.optional(),
  createdAt: dateTime,
  settledAt: dateTime.optional(),
  stopReason: id.optional(),
}).strict();

const RealCallLedgerSchema = z.object({
  version: z.literal(REAL_CALL_LEDGER_VERSION),
  authorizationId: id,
  configDigest: sha256,
  caps: z.object({
    maxRequests: z.number().int().min(1).max(200),
    maxCostMicroCny: z.number().int().positive().max(50_000_000),
    maxRetries: z.literal(0),
  }).strict(),
  openingUsage: UsageSchema,
  state: z.enum(['active', 'halted']),
  entries: z.array(LedgerEntrySchema),
  updatedAt: dateTime,
}).strict();

export type RealCallLedger = z.infer<typeof RealCallLedgerSchema>;

export type RealCallBudgetStatus = {
  authorizationId: string;
  state: 'active' | 'halted' | 'expired';
  used: { requests: number; costCny: number };
  remaining: { requests: number; costCny: number };
};

function ensure(ok: unknown, code: string): asserts ok {
  if(!ok) throw new Error(code);
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
}

function toMicroCny(value: number): number {
  ensure(Number.isFinite(value) && value >= 0, 'INVALID_REAL_CALL_USAGE');
  const result = Math.ceil(value * 1_000_000 - Number.EPSILON);
  ensure(Number.isSafeInteger(result), 'INVALID_REAL_CALL_USAGE');
  return result;
}

function fromMicroCny(value: number): number {
  return value / 1_000_000;
}

function accounted(ledger: RealCallLedger): { requests: number; costMicroCny: number } {
  return ledger.entries.reduce((total, entry) => {
    const value = entry.status === 'settled'
      ? entry.actual ?? entry.reserved
      : {
          requests: Math.max(entry.reserved.requests, entry.actual?.requests ?? 0),
          costMicroCny: Math.max(entry.reserved.costMicroCny, entry.actual?.costMicroCny ?? 0),
        };
    total.requests += value.requests;
    total.costMicroCny += value.costMicroCny;
    return total;
  }, { ...ledger.openingUsage });
}

function status(ledger: RealCallLedger, expired = false): RealCallBudgetStatus {
  const used = accounted(ledger);
  return {
    authorizationId: ledger.authorizationId,
    state: expired ? 'expired' : ledger.state,
    used: { requests: used.requests, costCny: fromMicroCny(used.costMicroCny) },
    remaining: {
      requests: Math.max(0, ledger.caps.maxRequests - used.requests),
      costCny: Math.max(0, fromMicroCny(ledger.caps.maxCostMicroCny - used.costMicroCny)),
    },
  };
}

export async function loadRealCallAuthorization(filePath: string): Promise<RealCallAuthorization> {
  return RealCallAuthorizationSchema.parse(JSON.parse(await readFile(path.resolve(filePath), 'utf8')));
}

export function loadRealCallAuthorizationSync(filePath: string): RealCallAuthorization {
  return RealCallAuthorizationSchema.parse(JSON.parse(readFileSync(path.resolve(filePath), 'utf8')));
}

export interface RealCallBudgetGate {
  reserve(input: {
    jobId: string;
    runId: string;
    attemptRevision: number;
    executionProfileDigest: string;
    providerVersion: string;
    modelVersion: string;
    promptVersion: string;
    allowPersonMatching: boolean;
    maxRequests: number;
    maxCostCny: number;
  }): Promise<RealCallReservation>;
  finalize(input: {
    reservation: RealCallReservation;
    disposition: 'settled' | 'uncertain';
    actualRequests: number;
    actualCostCny: number;
    stopReason?: string;
  }): Promise<RealCallBudgetStatus>;
  readStatus(): Promise<RealCallBudgetStatus>;
}

export class FileRealCallBudgetGate implements RealCallBudgetGate {
  readonly authorization: RealCallAuthorization;
  readonly configDigest: `sha256:${string}`;
  readonly root: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: {
    dataRoot: string;
    authorization: unknown;
    nowMs?: () => number;
  }) {
    this.authorization = RealCallAuthorizationSchema.parse(options.authorization);
    this.configDigest = hash(this.authorization);
    this.root = path.resolve(options.dataRoot, 'real-call-authorizations', this.authorization.authorizationId);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  private readonly nowMs: () => number;
  private ledgerFile(): string { return path.join(this.root, 'ledger.json'); }
  private lockFile(): string { return path.join(this.root, 'ledger.lock'); }

  private async readLedger(): Promise<RealCallLedger | undefined> {
    try { return RealCallLedgerSchema.parse(JSON.parse(await readFile(this.ledgerFile(), 'utf8'))); }
    catch(error) {
      if((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private initialLedger(): RealCallLedger {
    return RealCallLedgerSchema.parse({
      version: REAL_CALL_LEDGER_VERSION,
      authorizationId: this.authorization.authorizationId,
      configDigest: this.configDigest,
      caps: {
        maxRequests: this.authorization.caps.maxRequests,
        maxCostMicroCny: toMicroCny(this.authorization.caps.maxCostCny),
        maxRetries: 0,
      },
      openingUsage: {
        requests: this.authorization.openingUsage.requests,
        costMicroCny: toMicroCny(this.authorization.openingUsage.costCny),
      },
      state: 'active',
      entries: [],
      updatedAt: new Date(this.nowMs()).toISOString(),
    });
  }

  private verifyLedger(ledger: RealCallLedger): void {
    ensure(ledger.authorizationId === this.authorization.authorizationId, 'REAL_CALL_AUTHORIZATION_MISMATCH');
    ensure(ledger.configDigest === this.configDigest, 'REAL_CALL_AUTHORIZATION_CHANGED');
    ensure(ledger.caps.maxRequests === this.authorization.caps.maxRequests
      && ledger.caps.maxCostMicroCny === toMicroCny(this.authorization.caps.maxCostCny)
      && ledger.caps.maxRetries === 0, 'REAL_CALL_CAP_MISMATCH');
  }

  private async writeLedger(ledger: RealCallLedger): Promise<void> {
    const target = this.ledgerFile();
    const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(RealCallLedgerSchema.parse(ledger), null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, target);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.pending.catch(() => undefined).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      let lock;
      try { lock = await open(this.lockFile(), 'wx', 0o600); }
      catch(error) {
        if((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('REAL_CALL_LEDGER_LOCKED_OR_UNCERTAIN');
        throw error;
      }
      try {
        await lock.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date(this.nowMs()).toISOString() })}\n`);
        await lock.close();
        return await operation();
      } finally {
        await lock?.close().catch(() => undefined);
        await unlink(this.lockFile()).catch(() => undefined);
      }
    });
    this.pending = current;
    return current;
  }

  async reserve(input: {
    jobId: string;
    runId: string;
    attemptRevision: number;
    executionProfileDigest: string;
    providerVersion: string;
    modelVersion: string;
    promptVersion: string;
    allowPersonMatching: boolean;
    maxRequests: number;
    maxCostCny: number;
  }): Promise<RealCallReservation> {
    id.parse(input.jobId);
    id.parse(input.runId);
    id.parse(input.providerVersion);
    id.parse(input.modelVersion);
    id.parse(input.promptVersion);
    sha256.parse(input.executionProfileDigest);
    ensure(Number.isInteger(input.attemptRevision) && input.attemptRevision > 0, 'INVALID_REAL_CALL_RESERVATION');
    ensure(Number.isInteger(input.maxRequests) && input.maxRequests > 0, 'INVALID_REAL_CALL_RESERVATION');
    ensure(this.nowMs() < Date.parse(this.authorization.expiresAt), 'REAL_CALL_AUTHORIZATION_EXPIRED');
    ensure(input.providerVersion === this.authorization.providerVersion
      && input.modelVersion === this.authorization.modelVersion, 'REAL_CALL_MODEL_MISMATCH');
    ensure(!input.allowPersonMatching || this.authorization.allowPersonMatching, 'REAL_CALL_PERSON_MATCHING_NOT_AUTHORIZED');
    const reservationId = `real_${createHash('sha256')
      .update(stable([input.jobId, input.runId, input.attemptRevision]))
      .digest('hex').slice(0, 32)}`;
    const reservation = RealCallReservationSchema.parse({
      authorizationId: this.authorization.authorizationId,
      reservationId,
      configDigest: this.configDigest,
      jobId: input.jobId,
      runId: input.runId,
      attemptRevision: input.attemptRevision,
    });
    return this.exclusive(async () => {
      const ledger = await this.readLedger() ?? this.initialLedger();
      this.verifyLedger(ledger);
      ensure(ledger.state === 'active', 'REAL_CALL_AUTHORIZATION_HALTED');
      const existing = ledger.entries.find(entry => entry.reservationId === reservationId);
      if(existing) {
        ensure(existing.status === 'reserved'
          && existing.jobId === input.jobId
          && existing.runId === input.runId
          && existing.executionProfileDigest === input.executionProfileDigest, 'DUPLICATE_REAL_CALL_RESERVATION');
        return reservation;
      }
      const reserved = { requests: input.maxRequests, costMicroCny: toMicroCny(input.maxCostCny) };
      const used = accounted(ledger);
      ensure(used.requests + reserved.requests <= ledger.caps.maxRequests
        && used.costMicroCny + reserved.costMicroCny <= ledger.caps.maxCostMicroCny, 'REAL_CALL_BUDGET_EXHAUSTED');
      const at = new Date(this.nowMs()).toISOString();
      ledger.entries.push({
        ...reservation,
        executionProfileDigest: input.executionProfileDigest as `sha256:${string}`,
        providerVersion: input.providerVersion,
        modelVersion: input.modelVersion,
        promptVersion: input.promptVersion,
        allowPersonMatching: input.allowPersonMatching,
        status: 'reserved',
        reserved,
        createdAt: at,
      });
      ledger.updatedAt = at;
      await this.writeLedger(ledger);
      return reservation;
    });
  }

  async finalize(input: {
    reservation: RealCallReservation;
    disposition: 'settled' | 'uncertain';
    actualRequests: number;
    actualCostCny: number;
    stopReason?: string;
  }): Promise<RealCallBudgetStatus> {
    const reservation = RealCallReservationSchema.parse(input.reservation);
    ensure(Number.isInteger(input.actualRequests) && input.actualRequests >= 0, 'INVALID_REAL_CALL_USAGE');
    if(input.stopReason !== undefined) id.parse(input.stopReason);
    return this.exclusive(async () => {
      const ledger = await this.readLedger();
      ensure(ledger, 'REAL_CALL_LEDGER_MISSING');
      this.verifyLedger(ledger);
      const entry = ledger.entries.find(candidate => candidate.reservationId === reservation.reservationId);
      ensure(entry
        && entry.authorizationId === reservation.authorizationId
        && entry.configDigest === reservation.configDigest
        && entry.jobId === reservation.jobId
        && entry.runId === reservation.runId
        && entry.attemptRevision === reservation.attemptRevision, 'REAL_CALL_RESERVATION_MISSING');
      const actual = { requests: input.actualRequests, costMicroCny: toMicroCny(input.actualCostCny) };
      if(entry.status !== 'reserved') {
        ensure(entry.status === input.disposition && stable(entry.actual) === stable(actual), 'REAL_CALL_SETTLEMENT_CONFLICT');
        return status(ledger, this.nowMs() >= Date.parse(this.authorization.expiresAt));
      }
      const overrun = actual.requests > entry.reserved.requests || actual.costMicroCny > entry.reserved.costMicroCny;
      entry.status = overrun ? 'uncertain' : input.disposition;
      entry.actual = actual;
      entry.settledAt = new Date(this.nowMs()).toISOString();
      if(input.stopReason) entry.stopReason = input.stopReason;
      if(overrun) {
        entry.stopReason = 'REAL_CALL_RESERVATION_OVERRUN';
        ledger.state = 'halted';
      }
      ledger.updatedAt = entry.settledAt;
      await this.writeLedger(ledger);
      return status(ledger, this.nowMs() >= Date.parse(this.authorization.expiresAt));
    });
  }

  async readStatus(): Promise<RealCallBudgetStatus> {
    const ledger = await this.readLedger() ?? this.initialLedger();
    this.verifyLedger(ledger);
    return status(ledger, this.nowMs() >= Date.parse(this.authorization.expiresAt));
  }
}
