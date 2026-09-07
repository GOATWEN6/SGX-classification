import Ajv from 'ajv';
import schema from '../../../../contracts/classification.schema.json';
import type { ContractMap } from './types';

export type ContractErrorCode = 'INVALID_CONTRACT' | 'SCOPE_MISMATCH' | 'NOT_AUTHORIZED'
  | 'INACTIVE_EVIDENCE' | 'STALE_RESULT' | 'INVALID_OUTPUT';

/** Error codes only: do not leak evidence text, object references or provider diagnostics. */
export class ContractError extends Error {
  constructor(public readonly code: ContractErrorCode) {
    super(code);
    this.name = 'ContractError';
  }
}

// Schemas are trusted, checked-in code. Never compile provider/user-supplied schemas.
const ajv = new Ajv({ allErrors: false, coerceTypes: false, useDefaults: false,
  removeAdditional: false, strictKeywords: true, strictNumbers: true,
  format: 'full', jsonPointers: true, ownProperties: true });
ajv.addSchema(schema);

export function parseContract<K extends keyof ContractMap>(name: K, value: unknown): ContractMap[K] {
  const validate = ajv.getSchema(`${schema.$id}#/definitions/${name}`);
  if (!validate || !validate(value)) throw new ContractError('INVALID_CONTRACT');
  return value as ContractMap[K];
}
