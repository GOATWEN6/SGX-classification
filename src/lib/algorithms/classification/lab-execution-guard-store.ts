import { link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  parseTrustedLabGuardSnapshot,
  type TrustedLabGuardSnapshot
} from './lab-execution-contract';
import type { TrustedLabGuardProvider } from './lab-execution';
import { stable } from './stage-a-contract';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class LabGuardStoreError extends Error {
  constructor(readonly code: string) { super(code); }
}

function fail(code: string): never { throw new LabGuardStoreError(code); }
function validateId(value: string): string {
  if(!idPattern.test(value)) fail('INVALID_JOB_ID');
  return value;
}

export class FileTrustedLabGuardStore implements TrustedLabGuardProvider {
  readonly root: string;

  constructor(baseRoot = process.env.CLASSIFICATION_LAB_DATA_DIR || path.join(tmpdir(), 'sgx-classification-lab')) {
    this.root = path.resolve(baseRoot, 'v2-guards');
  }

  private filename(jobId: string): string {
    return path.join(this.root, `${validateId(jobId)}.json`);
  }

  async get(jobId: string): Promise<TrustedLabGuardSnapshot> {
    try {
      const filename = this.filename(jobId);
      const metadata = await stat(filename);
      if(!metadata.isFile()) fail('LAB_GUARD_UNAVAILABLE');
      return parseTrustedLabGuardSnapshot(JSON.parse(await readFile(filename, 'utf8')));
    } catch(error) {
      if(error instanceof LabGuardStoreError) throw error;
      fail('LAB_GUARD_UNAVAILABLE');
    }
  }

  async put(jobId: string, raw: TrustedLabGuardSnapshot): Promise<TrustedLabGuardSnapshot> {
    const guard = parseTrustedLabGuardSnapshot(raw);
    const filename = this.filename(jobId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const existing = await this.get(jobId);
      if(stable(existing) !== stable(guard)) fail('LAB_GUARD_CONFLICT');
      return existing;
    } catch(error) {
      if(error instanceof LabGuardStoreError && error.code !== 'LAB_GUARD_UNAVAILABLE') throw error;
    }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(guard, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await link(temporary, filename);
      await unlink(temporary);
    }
    catch(error) {
      await unlink(temporary).catch(() => undefined);
      try {
        const existing = await this.get(jobId);
        if(stable(existing) !== stable(guard)) fail('LAB_GUARD_CONFLICT');
        return existing;
      } catch { throw error; }
    }
    return guard;
  }
}
