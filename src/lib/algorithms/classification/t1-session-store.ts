import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const CLASSIFICATION_T1_SESSION_VERSION = 'classification-t1-session.1' as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const dateTime = z.string().datetime({ offset: true });
const scope = z.object({ householdId: id, subjectId: id }).strict();

export const ClassificationT1SessionSchema = z.object({
  version: z.literal(CLASSIFICATION_T1_SESSION_VERSION),
  revision: z.number().int().nonnegative(),
  sessionId: id,
  scope,
  actorId: id,
  authorizationRevision: id,
  contextRevision: id,
  consentRef: id,
  state: z.enum(['active', 'revoked']),
  roundCount: z.number().int().nonnegative(),
  createdAt: dateTime,
  updatedAt: dateTime,
  revokedAt: dateTime.optional(),
}).strict().superRefine((value, ctx) => {
  if(value.state === 'active' && value.revokedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ACTIVE_T1_SESSION_HAS_REVOKED_AT' });
  }
  if(value.state === 'revoked' && !value.revokedAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'REVOKED_T1_SESSION_REQUIRES_REVOKED_AT' });
  }
  if(Date.parse(value.updatedAt) < Date.parse(value.createdAt)
    || (value.revokedAt && Date.parse(value.updatedAt) < Date.parse(value.revokedAt))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'T1_SESSION_TIME_INVARIANT' });
  }
});

export type ClassificationT1Session = z.infer<typeof ClassificationT1SessionSchema>;

export class ClassificationT1SessionError extends Error {
  constructor(readonly code: string) { super(code); }
}

function fail(code: string): never { throw new ClassificationT1SessionError(code); }
function nowIso(nowMs: () => number): string { return new Date(nowMs()).toISOString(); }
function token(prefix: string): string { return `${prefix}_${randomUUID().replaceAll('-', '')}`; }
function sameScope(left: ClassificationT1Session['scope'], right: ClassificationT1Session['scope']): boolean {
  return left.householdId === right.householdId && left.subjectId === right.subjectId;
}

export class FileClassificationT1SessionStore {
  readonly root: string;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    baseRoot = process.env.CLASSIFICATION_LAB_DATA_DIR || path.join(tmpdir(), 'sgx-classification-lab'),
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.root = path.resolve(baseRoot, 'v2-sessions');
  }

  private filename(sessionId: string): string {
    return path.join(this.root, `${id.parse(sessionId)}.json`);
  }

  private async exclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.pending.set(sessionId, current);
    try { return await current; }
    finally { if(this.pending.get(sessionId) === current) this.pending.delete(sessionId); }
  }

  private async write(value: ClassificationT1Session): Promise<void> {
    const session = ClassificationT1SessionSchema.parse(value);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.filename(session.sessionId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  }

  async get(sessionId: string): Promise<ClassificationT1Session | undefined> {
    try {
      return ClassificationT1SessionSchema.parse(JSON.parse(await readFile(this.filename(sessionId), 'utf8')));
    } catch(error) {
      if((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if(error instanceof z.ZodError) fail('T1_SESSION_STORE_CORRUPT');
      throw error;
    }
  }

  async create(input: {
    scope: ClassificationT1Session['scope'];
    actorId: string;
  }): Promise<ClassificationT1Session> {
    const parsed = z.object({ scope, actorId: id }).strict().parse(input);
    const at = nowIso(this.nowMs);
    const session = ClassificationT1SessionSchema.parse({
      version: CLASSIFICATION_T1_SESSION_VERSION,
      revision: 0,
      sessionId: token('t1_session'),
      scope: parsed.scope,
      actorId: parsed.actorId,
      authorizationRevision: token('t1_auth'),
      contextRevision: token('t1_context'),
      consentRef: token('t1_consent'),
      state: 'active',
      roundCount: 0,
      createdAt: at,
      updatedAt: at,
    });
    await this.exclusive(session.sessionId, async () => {
      if(await this.get(session.sessionId)) fail('T1_SESSION_ID_CONFLICT');
      await this.write(session);
    });
    return session;
  }

  async requireActive(input: {
    sessionId: string;
    scope: ClassificationT1Session['scope'];
    actorId: string;
  }): Promise<ClassificationT1Session> {
    const parsed = z.object({ sessionId: id, scope, actorId: id }).strict().parse(input);
    const session = await this.get(parsed.sessionId);
    if(!session) fail('T1_SESSION_NOT_FOUND');
    if(!sameScope(session.scope, parsed.scope) || session.actorId !== parsed.actorId) fail('T1_SESSION_SCOPE_MISMATCH');
    if(session.state !== 'active') fail('T1_SESSION_REVOKED');
    return session;
  }

  async reserveRound(input: {
    sessionId: string;
    scope: ClassificationT1Session['scope'];
    actorId: string;
  }): Promise<{ session: ClassificationT1Session; round: number }> {
    return this.exclusive(input.sessionId, async () => {
      const current = await this.requireActive(input);
      const at = nowIso(this.nowMs);
      const next = ClassificationT1SessionSchema.parse({
        ...current,
        revision: current.revision + 1,
        roundCount: current.roundCount + 1,
        updatedAt: Date.parse(at) < Date.parse(current.updatedAt) ? current.updatedAt : at,
      });
      await this.write(next);
      return { session: next, round: next.roundCount };
    });
  }

  async revoke(sessionId: string): Promise<ClassificationT1Session> {
    return this.exclusive(sessionId, async () => {
      const current = await this.get(sessionId);
      if(!current) fail('T1_SESSION_NOT_FOUND');
      if(current.state === 'revoked') return current;
      const observed = nowIso(this.nowMs);
      const at = Date.parse(observed) < Date.parse(current.updatedAt) ? current.updatedAt : observed;
      const next = ClassificationT1SessionSchema.parse({
        ...current,
        revision: current.revision + 1,
        state: 'revoked',
        revokedAt: at,
        updatedAt: at,
      });
      await this.write(next);
      return next;
    });
  }
}
