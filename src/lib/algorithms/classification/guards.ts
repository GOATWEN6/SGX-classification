import { createHash } from 'node:crypto';
import { ContractError, parseContract } from './validation';
import type { ClassificationProviderRequest, ClassificationProviderResult, ContentBundle,
  EvidenceRecord, MinimalAuthorizedEvidenceRef, JobStatus, VersionStamp, ProviderConfig,
  ClassificationFacet } from './types';

/** Obtained from a trusted backend authorization service, NEVER from the client body. */
export interface AuthorizationContext {
  actorId: string;
  subjectId: string;
  householdId: string;
  authorityRef: string;
  allowedEvidenceIds: readonly string[];
  allowedConsentRefs: readonly string[];
  biometricConsentRefs: readonly string[];
}

function requireCondition(ok: boolean, code: ConstructorParameters<typeof ContractError>[0]): asserts ok {
  if (!ok) throw new ContractError(code);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export function minimalEvidence(evidence: EvidenceRecord): MinimalAuthorizedEvidenceRef {
  requireCondition(evidence.lifecycleState !== 'deleted', 'INACTIVE_EVIDENCE');
  const base = { evidenceId: evidence.evidenceId, sourceRef: evidence.sourceRef,
    sourceHash: evidence.sourceHash, revision: evidence.revision, byteLength: evidence.byteLength };
  if (evidence.modality === 'image') return { ...base, modality: 'image', mimeType: evidence.mimeType, dimensions: evidence.dimensions };
  if (evidence.modality === 'transcript') return { ...base, modality: 'transcript', mimeType: evidence.mimeType, asr: evidence.asr };
  return { ...base, modality: 'text', mimeType: evidence.mimeType };
}

function authorize(subjectId: string, householdId: string, evidence: EvidenceRecord[], context: AuthorizationContext) {
  requireCondition(context.subjectId === subjectId && context.householdId === householdId, 'SCOPE_MISMATCH');
  requireCondition(Boolean(context.authorityRef && context.actorId), 'NOT_AUTHORIZED');
  requireCondition(new Set(evidence.map(e => e.evidenceId)).size === evidence.length, 'INVALID_CONTRACT');
  for (const input of evidence) {
    const e = parseContract('EvidenceRecord', input);
    requireCondition(e.subjectId === subjectId && e.householdId === householdId, 'SCOPE_MISMATCH');
    requireCondition(e.lifecycleState !== 'deleted' && e.lifecycleState === 'active', 'INACTIVE_EVIDENCE');
    requireCondition(context.allowedEvidenceIds.includes(e.evidenceId) && context.allowedConsentRefs.includes(e.consentRef), 'NOT_AUTHORIZED');
    // This reference must also have been checked by the product authorization service.
    requireCondition(e.visibility === 'private' || Boolean(e.visibilityAuthorityRef), 'NOT_AUTHORIZED');
    requireCondition(e.visibility !== 'circle' || Boolean(e.circleId), 'INVALID_CONTRACT');
    if (e.modality === 'image') {
      requireCondition(e.sourceRef.kind === 'object' && e.dimensions.width * e.dimensions.height <= 40000000, 'INVALID_CONTRACT');
    } else {
      requireCondition(e.byteLength <= 65536, 'INVALID_CONTRACT');
    }
  }
}

function checkConfig(config: ProviderConfig, context: AuthorizationContext) {
  requireCondition(!config.anonymousClustersEnabled || Boolean(config.biometricConsentRef &&
    context.biometricConsentRefs.includes(config.biometricConsentRef)), 'NOT_AUTHORIZED');
}

export function computeInputHash(request: Pick<ClassificationProviderRequest, 'subjectId' | 'householdId' | 'evidence'>): string {
  return hash({ subjectId: request.subjectId, householdId: request.householdId, evidence: request.evidence });
}

export function computeIdempotencyKey(request: Pick<ClassificationProviderRequest,
  'schemaVersion' | 'subjectId' | 'householdId' | 'bundleId' | 'evidence' | 'requestedFacets' | 'versions' | 'config'>): string {
  // Ordered evidence snapshots; facets are a set. Permission must be rechecked even on a cache hit.
  return hash({ schemaVersion: request.schemaVersion, subjectId: request.subjectId, householdId: request.householdId,
    bundleId: request.bundleId, evidence: request.evidence, requestedFacets: [...request.requestedFacets].sort(),
    versions: request.versions, config: request.config });
}

export function prepareProviderRequest(bundleInput: ContentBundle, options: {
  jobId: string; runId: string; versions: VersionStamp; config: ProviderConfig;
  requestedFacets: ClassificationFacet[]; deadlineAt: string;
}, context: AuthorizationContext): ClassificationProviderRequest {
  const bundle = parseContract('ContentBundle', bundleInput);
  requireCondition(bundle.actorId === context.actorId, 'NOT_AUTHORIZED');
  authorize(bundle.subjectId, bundle.householdId, bundle.evidence, context);
  parseContract('ProviderConfig', options.config);
  checkConfig(options.config, context);
  const base = { schemaVersion: '1.0' as const, bundleId: bundle.bundleId, jobId: options.jobId,
    runId: options.runId, subjectId: bundle.subjectId, householdId: bundle.householdId,
    evidence: bundle.evidence.map(minimalEvidence), requestedFacets: options.requestedFacets,
    versions: options.versions, config: options.config, deadlineAt: options.deadlineAt };
  return parseContract('ClassificationProviderRequest', { ...base,
    inputHash: computeInputHash(base), idempotencyKey: computeIdempotencyKey(base) });
}

export function validateProviderRequest(input: unknown): ClassificationProviderRequest {
  const request = parseContract('ClassificationProviderRequest', input);
  requireCondition(new Set(request.evidence.map(e => e.evidenceId)).size === request.evidence.length, 'INVALID_CONTRACT');
  requireCondition(request.inputHash === computeInputHash(request) &&
    request.idempotencyKey === computeIdempotencyKey(request), 'INVALID_CONTRACT');
  return request;
}

/** Provider output is untrusted even if it is already statically typed. */
export function validateProviderResult(request: ClassificationProviderRequest, output: unknown): ClassificationProviderResult {
  let result: ClassificationProviderResult;
  try { result = parseContract('ClassificationProviderResult', output); }
  catch { throw new ContractError('INVALID_OUTPUT'); }
  const ensure = (ok: boolean) => requireCondition(ok, 'INVALID_OUTPUT');
  ensure(result.runId === request.runId && result.jobId === request.jobId &&
    result.subjectId === request.subjectId && result.householdId === request.householdId &&
    result.inputHash === request.inputHash && same(result.versions, request.versions));
  const evidence = new Map(request.evidence.map(e => [e.evidenceId, e]));
  ensure(new Set(result.assertions.map(a => a.assertionId)).size === result.assertions.length);
  const outcomes = new Map<ClassificationFacet, string>();
  const faces = result.assertions.filter(a => a.facet === 'person' && a.normalizedValue.kind === 'face_region');
  const faceRegions = new Map(faces.map(a => {
    if (a.facet !== 'person' || a.normalizedValue.kind !== 'face_region') throw new ContractError('INVALID_OUTPUT');
    return [a.normalizedValue.faceRegionId, a.normalizedValue.evidenceId];
  }));
  ensure(faceRegions.size === faces.length);
  const regionValid = (r: { x: number; y: number; width: number; height: number }) => r.x + r.width <= 1 && r.y + r.height <= 1;
  for (const a of result.assertions) {
    ensure(a.jobId === request.jobId && a.subjectId === request.subjectId && a.householdId === request.householdId &&
      same(a.versions, request.versions) && a.inputHash === request.inputHash && a.revision === 1);
    ensure(request.requestedFacets.includes(a.facet) && ['proposed', 'conflicted'].includes(a.state));
    ensure(a.evidenceRefs.every(id => evidence.has(id)) &&
      a.evidenceRefs.every(id => a.supports.some(s => s.evidenceId === id)));
    for (const support of a.supports) {
      const e = evidence.get(support.evidenceId);
      ensure(Boolean(e) && a.evidenceRefs.includes(support.evidenceId));
      if (!e) throw new ContractError('INVALID_OUTPUT');
      ensure(e.modality === 'image' ? ['visual', 'exif', 'ocr'].includes(support.sourceType) :
        support.sourceType === (e.modality === 'text' ? 'user_text' : 'final_asr'));
      ensure(!support.span || (e.modality !== 'image' || support.sourceType === 'ocr') && support.span.start < support.span.end);
      ensure(!support.region || e.modality === 'image' && regionValid(support.region));
    }
    if (a.facet === 'person') {
      const value = a.normalizedValue;
      if (value.kind === 'text_mention') ensure(a.supports.every(s => ['user_text', 'final_asr'].includes(s.sourceType)));
      if (value.kind === 'face_region') ensure(evidence.get(value.evidenceId)?.modality === 'image' &&
        a.evidenceRefs.includes(value.evidenceId) && regionValid(value.region));
      if (value.kind === 'person_cluster') ensure(request.config.anonymousClustersEnabled &&
        Boolean(request.config.biometricConsentRef) && a.supports.every(s => s.sourceType === 'visual') &&
        value.faceRegionIds.every(id => faceRegions.has(id) && a.evidenceRefs.includes(faceRegions.get(id)!)));
    }
    if (a.facet === 'duplicate') ensure(a.evidenceRefs.includes(a.normalizedValue.targetEvidenceId) &&
      a.evidenceRefs.length >= 2 && a.evidenceRefs.every(id => evidence.get(id)?.modality === 'image'));
    ensure(a.state === 'conflicted' ? Boolean(a.conflictGroupId) : !a.conflictGroupId);
    outcomes.set(a.facet, 'assertion');
  }
  for (const a of result.assertions.filter(a => a.state === 'conflicted')) {
    const group = result.assertions.filter(b => b.conflictGroupId === a.conflictGroupId);
    ensure(group.length >= 2 && group.every(b => b.state === 'conflicted' && b.facet === a.facet) &&
      new Set(group.map(b => canonical(b.normalizedValue))).size >= 2);
  }
  for (const [kind, entries] of [['error', result.facetErrors], ['abstention', result.abstentions]] as const) {
    for (const entry of entries) {
      ensure(request.requestedFacets.includes(entry.facet) && !outcomes.has(entry.facet));
      outcomes.set(entry.facet, kind);
    }
  }
  if (result.status === 'succeeded' || result.status === 'needs_review') {
    ensure(!result.error && request.requestedFacets.every(f => outcomes.has(f)));
    if (result.status === 'succeeded') ensure(result.assertions.length > 0 && !result.facetErrors.length &&
      !result.abstentions.length && result.assertions.every(a => a.state === 'proposed'));
  } else {
    ensure(Boolean(result.error) && !result.assertions.length && !result.abstentions.length && !result.facetErrors.length);
    if (result.status === 'cancelled') ensure(result.error?.code === 'CANCELLED');
    if (result.status === 'failed_retryable') ensure(['TIMEOUT', 'PROVIDER_UNAVAILABLE'].includes(result.error!.code));
    if (result.status === 'failed_terminal') ensure(['INVALID_OUTPUT', 'UNSUPPORTED_INPUT', 'INTERNAL_ERROR'].includes(result.error!.code));
  }
  return result;
}

export interface AcceptanceSnapshot {
  runId: string;
  jobStatus: JobStatus;
  evidence: EvidenceRecord[];
  authorization: AuthorizationContext;
}

/** Call with fresh repository state inside the same transaction that persists the result. */
export function acceptProviderResult(request: ClassificationProviderRequest, output: unknown,
  snapshot: AcceptanceSnapshot, now = Date.now()): ClassificationProviderResult {
  validateProviderRequest(request);
  requireCondition(snapshot.jobStatus === 'processing' && snapshot.runId === request.runId, 'STALE_RESULT');
  requireCondition(now < Date.parse(request.deadlineAt), 'STALE_RESULT');
  authorize(request.subjectId, request.householdId, snapshot.evidence, snapshot.authorization);
  checkConfig(request.config, snapshot.authorization);
  const byId = new Map(snapshot.evidence.map(e => [e.evidenceId, e]));
  requireCondition(byId.size === request.evidence.length && request.evidence.every(e => {
    const current = byId.get(e.evidenceId);
    return current && same(minimalEvidence(current), e);
  }), 'STALE_RESULT');
  const result = validateProviderResult(request, output);
  return result;
}
