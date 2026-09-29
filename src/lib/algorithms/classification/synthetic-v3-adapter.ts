import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseIngestionEnvelope, type IngestionEnvelope } from './ingestion-contract';
import { decodeUtf8Payload, inspectImagePayload, type SupportedImageMime } from './media-inspection';
import { BudgetSchema, EVENT_LABELS, FacetSchema, PhotoSchema, RequestSchema, SCENE_LABELS, type Budget, type Photo, type Request } from './stage-a-contract';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relativeFile = z.string().min(1).max(1024);
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;
const SYNTHETIC_CLAIM_BOUNDARY = 'synthetic_fixture_and_current_offline_integration_only';
const ALLOWED_ORIGINS = ['synthetic_ai_generated', 'synthetic_tts', 'synthetic_existing_v2'] as const;
const SyntheticSpecVersionSchema = z.enum(['3.0.0', '3.1.0']);
const StructuredFacetSchema = z.enum(['person', 'time', 'place', 'event', 'scene', 'theme', 'quality']);
const StructuredAssertionSchema = z.object({
  assertionId: id, facet: StructuredFacetSchema, value: z.string().min(1), role: z.enum(['event', 'capture', 'scan', 'upload']).optional(),
  sourceRefs: z.array(id).min(1).refine(unique, 'DUPLICATE_ASSERTION_SOURCE'),
  targetAssetIds: z.array(id).min(1).refine(unique, 'DUPLICATE_ASSERTION_TARGET').optional(),
  reason: z.string().min(1).optional()
}).strict();
const StructuredExpectedSchema = z.object({
  requiredAssertions: z.array(StructuredAssertionSchema),
  forbiddenAssertions: z.array(StructuredAssertionSchema),
  conflicts: z.array(z.object({
    facet: StructuredFacetSchema,
    candidates: z.array(z.object({ value: z.string().min(1), role: z.enum(['event', 'capture', 'scan', 'upload']).optional(), sourceRefs: z.array(id).min(1), status: z.enum(['asserted', 'retracted', 'tentative']) }).strict()).min(2),
    resolution: z.enum(['unresolved', 'user_corrected', 'negated'])
  }).strict()),
  relationships: z.array(z.object({ label: z.string().min(1), relation: z.string().min(1), sourceRefs: z.array(id).min(1), authority: z.literal('user_explicit') }).strict()),
  unknownFacets: z.array(StructuredFacetSchema).refine(unique, 'DUPLICATE_UNKNOWN_FACET'),
  resultStatus: z.enum(['complete', 'partial', 'no_assertion', 'withdrawn']),
  workflowStatus: z.enum(['succeeded', 'needs_review', 'not_run']),
  qualityFlags: z.array(z.string().min(1)).refine(unique, 'DUPLICATE_QUALITY_FLAG')
}).strict();

const SourceSchema: z.ZodType<any> = z.object({
  assetId: id, type: z.enum(['photo', 'user_text', 'final_asr', 'audio_original']), path: relativeFile,
  mimeType: z.string().min(1), bytes: z.number().int().positive(), sha256: sha,
  status: z.enum(['active', 'withdrawn']), assetOrigin: z.string().min(1), synthetic: z.boolean(),
  upstreamBundleId: z.string().min(1), personMatchingAllowed: z.boolean(), referenceOnly: z.boolean().optional(),
  image: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).passthrough().optional()
}).passthrough();

const BindingSchema: z.ZodType<any> = z.object({
  bindingId: id, sourceAssetId: id,
  target: z.object({ kind: z.enum(['batch', 'contents']), targetAssetIds: z.array(id).refine(unique, 'DUPLICATE_TARGET') }).strict(),
  authority: z.literal('synthetic_fixture_explicit'), mapsToIngestionAuthority: z.literal('user_explicit'),
  state: z.enum(['active', 'withdrawn']), synthetic: z.literal(true)
}).strict();

const InputSchema: z.ZodType<any> = z.object({
  schemaVersion: z.literal('sgx-t0-photorealistic-synthetic-input.1'), datasetId: id, specVersion: SyntheticSpecVersionSchema,
  groupId: id, partition: z.enum(['exploration', 't1_validation']), comboCategory: id,
  context: z.object({
    kind: z.enum(['album_upload', 'family_transfer', 'content_organization']), albumId: id.optional(), scopeId: id.optional(),
    senderId: id.optional(), recipientIds: z.array(id).optional(), reviewPolicy: z.string().optional(), syntheticRelationship: z.boolean().optional()
  }).passthrough(),
  syntheticIdentity: z.object({ actorId: id, subjectId: id, ownerId: id, contributorId: id, fictitious: z.literal(true) }).strict(),
  lifecycle: z.enum(['active', 'withdrawn']), authorizationRevision: id, contextRevision: id,
  personMatching: z.literal('disabled'), sources: z.array(SourceSchema).min(1).refine(values => unique(values.map(value => value.assetId)), 'DUPLICATE_ASSET'),
  bindings: z.array(BindingSchema).refine(values => unique(values.map(value => value.bindingId)), 'DUPLICATE_BINDING'),
  scenarioTags: z.array(id).min(1).refine(unique, 'DUPLICATE_SCENARIO_TAG'), contextClusterId: z.string().nullable(),
  syntheticNotice: z.string().min(10)
}).passthrough();

const TruthSchema: z.ZodType<any> = z.object({
  schemaVersion: z.literal('sgx-t0-photorealistic-synthetic-truth.1'), datasetId: id, specVersion: SyntheticSpecVersionSchema, groupId: id,
  truthType: z.literal('synthetic_expected_behavior_fixture'),
  expected: z.object({
    action: z.enum(['auto_organize', 'needs_review', 'abstain', 'do_not_process']), riskLevel: z.enum(['low', 'medium', 'high']),
    storyKey: z.string().min(1), facets: z.object({
      event: z.array(z.string()), scene: z.array(z.string()), time: z.array(z.string()), place: z.array(z.string()), theme: z.array(z.string()),
      peopleLabels: z.array(z.string()), conflicts: z.array(z.string())
    }).strict(), lifecycle: z.enum(['active', 'withdrawn']), personMatching: z.literal('disabled'), evidenceAssetIds: z.array(id).refine(unique, 'DUPLICATE_TRUTH_EVIDENCE'),
    structured: StructuredExpectedSchema.optional()
  }).strict(),
  truthSourceBundleIds: z.array(z.string().min(1)).min(1).refine(unique, 'DUPLICATE_TRUTH_SOURCE'), reviewedBy: z.string().min(1),
  claimBoundary: z.literal(SYNTHETIC_CLAIM_BOUNDARY), syntheticNotice: z.string().min(10), notes: z.unknown().optional()
}).passthrough();

const ManifestGroupSchema: z.ZodType<any> = z.object({
  groupId: id, partition: z.enum(['exploration', 't1_validation']), comboCategory: id, contextKind: id,
  lifecycle: z.enum(['active', 'withdrawn']), inputPath: relativeFile, truthPath: relativeFile,
  upstreamBundleIds: z.array(z.string().min(1)).min(1).refine(unique, 'DUPLICATE_UPSTREAM_BUNDLE'),
  scenarioTags: z.array(id).min(1).refine(unique, 'DUPLICATE_SCENARIO_TAG'), contextClusterId: z.string().nullable(),
  assetIds: z.array(id).min(1).refine(unique, 'DUPLICATE_ASSET'), modalityCounts: z.record(z.number().int().nonnegative()),
  expectedAction: z.enum(['auto_organize', 'needs_review', 'abstain', 'do_not_process']), riskLevel: z.enum(['low', 'medium', 'high'])
}).strict();

const ManifestSchema: z.ZodType<any> = z.object({
  schemaVersion: z.literal('sgx-t0-photorealistic-synthetic-manifest.1'), datasetId: id, specVersion: SyntheticSpecVersionSchema,
  status: z.literal('complete_synthetic_fixture'), claimBoundary: z.literal(SYNTHETIC_CLAIM_BOUNDARY), realDataCount: z.literal(0),
  plannedGroups: z.number().int().positive(), completedGroups: z.number().int().positive(),
  partitionTargets: z.object({ exploration: z.number().int().nonnegative(), t1_validation: z.number().int().nonnegative() }).strict(),
  partitionCompleted: z.object({ exploration: z.number().int().nonnegative(), t1_validation: z.number().int().nonnegative() }).strict(),
  combinationTargets: z.record(z.number().int().nonnegative()), combinationCompleted: z.record(z.number().int().nonnegative()),
  requiredScenarioDimensions: z.array(id).min(1).refine(unique, 'DUPLICATE_REQUIRED_SCENARIO'),
  scenarioCoverage: z.record(z.array(id)), assetCounts: z.record(z.number().int().nonnegative()),
  assetOriginVocabulary: z.array(z.enum(ALLOWED_ORIGINS)).min(1).refine(unique, 'DUPLICATE_ORIGIN'),
  currentRunGeneration: z.object({ externalModelCalls: z.literal(0) }).passthrough(), groups: z.array(ManifestGroupSchema).min(1),
  createdAt: z.string().datetime({ offset: true }), syntheticNotice: z.string().min(10)
}).passthrough();

export interface SyntheticV3StageOptions {
  status?: 'draft' | 'ready'; provider?: 'qwen' | 'glm'; model?: string; providerUseReviewRef?: string;
  inputCnyPerMillion?: number; outputCnyPerMillion?: number; pricingSource?: string; pricingCheckedAt?: string;
  caps?: { maxRequests: number; maxInputTokens: number; maxOutputTokens: number; maxCostCny: number; maxDurationSeconds: number; maxRetries: 0 };
  taskBudget?: Partial<Budget>;
}
export interface SyntheticV3AdapterOptions { now?: string; stageA?: SyntheticV3StageOptions; }
export class SyntheticV3AdapterError extends Error { constructor(public readonly code: string) { super(code); } }
function fail(code: string): never { throw new SyntheticV3AdapterError(code); }
function ensure(ok: unknown, code: string): asserts ok { if(!ok) fail(code); }
function bytesHash(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function bareHash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function safeId(value: string): string { const safe = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128); ensure(/^[A-Za-z0-9]/.test(safe), 'INVALID_STAGE_A_ID'); return safe; }
function stableLeakageKey(group: any): string {
  const basis = group.contextClusterId ? `cluster:${group.contextClusterId}` : `upstream:${[...group.upstreamBundleIds].sort().join('|')}`;
  return `leakage_${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

async function safeFile(root: string, relativePath: string): Promise<string> {
  ensure(!path.isAbsolute(relativePath), 'ABSOLUTE_SOURCE_PATH');
  const resolved = path.resolve(root, relativePath);
  ensure(resolved.startsWith(`${root}${path.sep}`), 'SOURCE_PATH_ESCAPE');
  let info; try { info = await lstat(resolved); } catch { return fail('SOURCE_NOT_REGULAR_FILE'); }
  ensure(info.isFile() && !info.isSymbolicLink(), 'SOURCE_NOT_REGULAR_FILE');
  const canonical = await realpath(resolved);
  ensure(canonical.startsWith(`${root}${path.sep}`), 'SOURCE_SYMLINK_ESCAPE');
  return canonical;
}

function parseChecksums(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for(const line of text.trimEnd().split('\n')) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/); ensure(match, 'INVALID_CHECKSUM_MANIFEST');
    ensure(!result.has(match[2]), 'DUPLICATE_CHECKSUM_ENTRY'); result.set(match[2], match[1]);
  }
  return result;
}

async function verifiedFile(root: string, relativePath: string, checksums: Map<string, string>, mismatchCode = 'CHECKSUM_MISMATCH'): Promise<Buffer> {
  const bytes = await readFile(await safeFile(root, relativePath));
  ensure(checksums.has(relativePath), 'CHECKSUM_ENTRY_MISSING');
  ensure(bareHash(bytes) === checksums.get(relativePath), mismatchCode);
  return bytes;
}

function assertFixedDenominator(manifest: any): void {
  ensure(manifest.groups.length === manifest.plannedGroups && manifest.completedGroups === manifest.plannedGroups, 'FIXED_DENOMINATOR_MISMATCH');
  ensure(unique(manifest.groups.map((group: any) => group.groupId)), 'DUPLICATE_GROUP');
  const partitions = { exploration: 0, t1_validation: 0 };
  const combinations: Record<string, number> = {};
  const covered = new Set<string>();
  for(const group of manifest.groups) {
    partitions[group.partition as keyof typeof partitions] += 1; combinations[group.comboCategory] = (combinations[group.comboCategory] ?? 0) + 1;
    group.scenarioTags.forEach((tag: string) => covered.add(tag));
  }
  ensure(JSON.stringify(partitions) === JSON.stringify(manifest.partitionTargets) && JSON.stringify(partitions) === JSON.stringify(manifest.partitionCompleted), 'PARTITION_DENOMINATOR_MISMATCH');
  for(const [key, count] of Object.entries(manifest.combinationTargets)) ensure(combinations[key] === count && manifest.combinationCompleted[key] === count, 'COMBINATION_DENOMINATOR_MISMATCH');
  ensure(Object.keys(combinations).every(key => manifest.combinationTargets[key] === combinations[key]), 'COMBINATION_DENOMINATOR_MISMATCH');
  for(const scenario of manifest.requiredScenarioDimensions) {
    ensure(covered.has(scenario), 'SCENARIO_COVERAGE_MISMATCH');
    const listed = manifest.scenarioCoverage[scenario]; ensure(listed && listed.length > 0, 'SCENARIO_COVERAGE_MISMATCH');
    ensure(listed.every((groupId: string) => manifest.groups.some((group: any) => group.groupId === groupId && group.scenarioTags.includes(scenario))), 'SCENARIO_COVERAGE_MISMATCH');
  }
}

type ParsedSource = Record<string, any> & { assetId: string; type: 'photo' | 'user_text' | 'final_asr' | 'audio_original'; path: string; mimeType: string; bytes: number; sha256: string; status: 'active' | 'withdrawn'; referenceOnly?: boolean; bytesValue: Buffer; text?: string; dimensions?: { width: number; height: number } };
type ParsedGroup = { manifest: any; input: any; truth: any; sources: ParsedSource[]; leakageGroup: string };

function buildEnvelope(datasetId: string, createdAt: string, parsed: ParsedGroup): IngestionEnvelope {
  const { input } = parsed;
  const householdId = safeId(input.context.scopeId ?? `syn-household-${input.syntheticIdentity.subjectId}`);
  const sourceById = new Map(parsed.sources.map(source => [source.assetId, source]));
  const included = parsed.sources.filter(source => source.type !== 'audio_original' && !source.referenceOnly);
  const lifecycleState = input.lifecycle === 'active' ? 'active' as const : 'trashed' as const;
  const evidence = included.map(source => {
    const common = {
      evidenceId: source.assetId, subjectId: input.syntheticIdentity.subjectId, householdId, schemaVersion: '1.0' as const,
      ownerId: input.syntheticIdentity.ownerId, contributorId: input.syntheticIdentity.contributorId,
      consentRef: safeId(`synthetic-fixture-${datasetId}`), visibility: input.context.kind === 'family_transfer' ? 'household' as const : 'private' as const,
      ingestedAt: createdAt, lifecycleState, sourceRef: { kind: source.type === 'user_text' ? 'message' as const : 'object' as const, id: source.assetId },
      sourceHash: source.sha256, revision: 1, byteLength: source.bytes
    };
    if(source.type === 'photo') return { ...common, modality: 'image' as const, mimeType: source.mimeType as SupportedImageMime, dimensions: source.dimensions! };
    if(source.type === 'user_text') return { ...common, modality: 'text' as const, mimeType: 'text/plain' as const };
    return { ...common, modality: 'transcript' as const, mimeType: 'text/plain' as const, asr: { final: true as const, producerVersion: 'synthetic-final-asr-fixture.1' } };
  });
  const contents = included.map(source => ({
    contentId: safeId(`content-${source.assetId}`), evidenceId: source.assetId,
    modality: source.type === 'photo' ? 'image' as const : source.type === 'user_text' ? 'user_text' as const : 'final_asr' as const,
    lifecycleState: input.lifecycle === 'active' ? 'active' as const : 'withdrawn' as const
  }));
  const contentByAsset = new Map(contents.map(content => [content.evidenceId, content]));
  const bindings = input.lifecycle === 'active' ? input.bindings.filter((binding: any) => binding.state === 'active').map((binding: any) => {
    const sourceContent = contentByAsset.get(binding.sourceAssetId); ensure(sourceContent && sourceContent.modality !== 'image', 'INVALID_BINDING_SOURCE');
    const targetIds = binding.target.targetAssetIds.map((assetId: string) => { const target = contentByAsset.get(assetId); ensure(target, 'FOREIGN_BINDING_TARGET'); return target.contentId; });
    const evidenceRefs = [binding.sourceAssetId, ...binding.target.targetAssetIds.filter((assetId: string) => sourceById.has(assetId))];
    return {
      bindingId: binding.bindingId, sourceContentId: sourceContent.contentId,
      target: binding.target.kind === 'batch' ? { kind: 'batch' as const } : { kind: 'contents' as const, contentIds: targetIds },
      authority: 'user_explicit' as const, state: 'active' as const, method: 'synthetic-fixture-explicit.1', evidenceRefs: [...new Set(evidenceRefs)], createdAt
    };
  }) : [];
  const context = input.context.kind === 'family_transfer'
    ? { kind: 'family_transfer' as const, senderId: input.context.senderId!, recipientIds: input.context.recipientIds! }
    : { kind: 'album_upload' as const };
  const raw = {
    specVersion: '2.0.0' as const, contractVersion: 'classification-ingestion.2' as const,
    ingestionId: safeId(`ingestion-${input.groupId}`), batchId: input.groupId,
    scope: { householdId, subjectId: input.syntheticIdentity.subjectId }, actorId: input.syntheticIdentity.actorId, context,
    authorizationRevision: input.authorizationRevision, taxonomyVersion: 'classification-taxonomy.synthetic-v3.1',
    purposes: ['classification' as const, 'album_organization' as const, 'search_candidate' as const, 'interview_candidate' as const],
    evidence, contents, bindings,
    ...(context.kind === 'family_transfer' ? { reviewPolicy: { policyVersion: 'family-inbox.1' as const, remindAfterDays: 3 as const, hideFromHomeAfterDays: 7 as const, highRiskRetention: 'until_resolved' as const } } : {}),
    createdAt
  };
  return parseIngestionEnvelope(raw);
}

function timeTruth(value: string): string {
  if(/^\d{4}$/.test(value)) return `event:year:${value}`;
  if(/^\d{4}-\d{2}-\d{2}$/.test(value)) return `event:date:${value}`;
  if(/^\d{3}0s$/.test(value)) return `event:decade:${value}`;
  return `event:relative:${value}`;
}
function structuredTimeTruth(value: string, role = 'event'): string {
  const suffix = timeTruth(value).replace(/^event:/, '');
  return `${role}:${suffix}`;
}
function expected(values: string[], map = (value: string) => value): Array<{ value: string; aliases: string[] }> { return values.map(value => ({ value: map(value), aliases: [] })); }

function buildStageGroup(parsed: ParsedGroup, envelope: IngestionEnvelope, options: RequiredAdapterOptions): { request?: Request; photos: Array<{ photo: Photo; source: ParsedSource; leakageGroup: string }>; truth: unknown[]; contentOrganizationEvidenceIds: string[]; exclusion?: string } {
  const activeImages = parsed.sources.filter(source => source.type === 'photo' && source.status === 'active' && parsed.input.lifecycle === 'active' && !source.referenceOnly);
  const contentOrganizationEvidenceIds = new Set<string>();
  if(!activeImages.length) return {
    photos: [], truth: [],
    contentOrganizationEvidenceIds: parsed.sources.filter(source => (source.type === 'user_text' || source.type === 'final_asr') && source.status === 'active' && !source.referenceOnly).map(source => source.assetId),
    exclusion: parsed.input.lifecycle !== 'active' ? 'WITHDRAWN_GROUP' : 'NO_ACTIVE_IMAGES'
  };
  const activeText = new Map(parsed.sources.filter(source => (source.type === 'user_text' || source.type === 'final_asr') && source.status === 'active' && !source.referenceOnly).map(source => [source.assetId, source]));
  const textTargets = new Map<string, Set<string>>();
  for(const binding of parsed.input.bindings.filter((binding: any) => binding.state === 'active')) {
    if(!activeText.has(binding.sourceAssetId)) continue;
    if(binding.target.kind === 'contents' && binding.target.targetAssetIds.length === 1) {
      textTargets.set(binding.sourceAssetId, new Set(binding.target.targetAssetIds));
    } else {
      contentOrganizationEvidenceIds.add(binding.sourceAssetId);
    }
  }
  for(const sourceId of activeText.keys()) if(!textTargets.has(sourceId)) contentOrganizationEvidenceIds.add(sourceId);
  const scope = envelope.scope;
  const photos = activeImages.map(source => PhotoSchema.parse({
    photoId: safeId(source.assetId), scope, revision: 1, sourceRef: safeId(source.assetId), sourceHash: source.sha256,
    mimeType: source.mimeType, caption: '',
    textEvidence: [...activeText.values()].filter(text => textTargets.get(text.assetId)?.has(source.assetId)).map(text => ({
      evidenceId: safeId(text.assetId), revision: 1, sourceHash: text.sha256,
      source: text.type === 'user_text' ? 'user_text' as const : 'final_asr' as const, text: text.text!
    })), active: true
  }));
  const budget = BudgetSchema.parse({
    maxRequests: 100, maxInputTokens: 10_000_000, maxOutputTokens: 1_000_000, maxCostCny: 30,
    deadlineAt: options.deadlineAt, candidatesPerPhoto: 4, maxOutputPerRequest: 2048,
    stageOutputTokens: { extract: 2048, relate: 2048 }, maxCallDurationMs: 60_000,
    ...options.stageA.taskBudget
  });
  const request = RequestSchema.parse({
    contractVersion: 'classification-stage-a.1', runId: safeId(`run-${parsed.input.groupId}`), scope,
    authorizationRevision: parsed.input.authorizationRevision, trigger: 'upload', photos, references: [], corrections: [], budget
  });
  const conflicts = parsed.truth.expected.facets.conflicts.filter((facet: string): facet is typeof FacetSchema._type => FacetSchema.safeParse(facet).success);
  const truth = photos.map(photo => {
    const assertions = parsed.truth.expected.structured?.requiredAssertions?.filter((assertion: any) =>
      !assertion.targetAssetIds || assertion.targetAssetIds.some((assetId: string) => safeId(assetId) === photo.photoId)
    );
    const facetValues = (facet: string) => {
      const conflict = parsed.truth.expected.structured?.conflicts?.find((item: any) => item.facet === facet);
      const candidates = conflict?.candidates?.filter((candidate: any) => candidate.status !== 'retracted') ?? [];
      if(candidates.length && (facet === 'time' || facet === 'place' ||
        (facet === 'event' && candidates.every((candidate: any) => (EVENT_LABELS as readonly string[]).includes(candidate.value))) ||
        (facet === 'scene' && candidates.every((candidate: any) => (SCENE_LABELS as readonly string[]).includes(candidate.value))))) return candidates;
      return assertions
        ? assertions.filter((assertion: any) => assertion.facet === facet)
        : parsed.truth.expected.facets[facet].map((value: string) => ({ value }));
    };
    const times = facetValues('time').map((assertion: any) => ({ value: structuredTimeTruth(assertion.value, assertion.role), aliases: [] }));
    const places = facetValues('place').map((assertion: any) => ({ value: assertion.value, aliases: [] }));
    const events = facetValues('event').map((assertion: any) => ({ value: assertion.value, aliases: [] }));
    const scenes = facetValues('scene').map((assertion: any) => ({ value: assertion.value, aliases: [] }));
    const unknown = ['person', ...([['time', times], ['place', places], ['event', events], ['scene', scenes]] as const).filter(([, values]) => values.length === 0).map(([facet]) => facet)];
    return {
      photoId: photo.photoId, sourceHash: photo.sourceHash,
      facets: { time: times, place: places, event: events, scene: scenes },
      faces: [], eventInstance: safeId(parsed.truth.expected.storyKey), expectedUnknownFacets: unknown, expectedConflicts: conflicts
    };
  });
  return {
    request,
    photos: photos.map((photo, index) => ({ photo, source: activeImages[index], leakageGroup: parsed.leakageGroup })),
    truth,
    contentOrganizationEvidenceIds: [...contentOrganizationEvidenceIds].sort()
  };
}

interface RequiredAdapterOptions { now: string; deadlineAt: string; stageA: Required<SyntheticV3StageOptions>; }
function normalizeOptions(options: SyntheticV3AdapterOptions = {}): RequiredAdapterOptions {
  const now = options.now ?? new Date().toISOString();
  const stage = options.stageA ?? {};
  const status = stage.status ?? 'draft';
  if(status === 'ready') {
    ensure(Boolean(stage.model && stage.providerUseReviewRef && stage.pricingSource && stage.pricingCheckedAt), 'READY_STAGE_A_CONFIGURATION_REQUIRED');
    ensure(Number.isFinite(stage.inputCnyPerMillion) && Number.isFinite(stage.outputCnyPerMillion), 'READY_STAGE_A_CONFIGURATION_REQUIRED');
  }
  const deadlineAt = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString();
  return { now, deadlineAt, stageA: {
    status, provider: stage.provider ?? 'qwen', model: stage.model ?? 'UNCONFIGURED', providerUseReviewRef: stage.providerUseReviewRef ?? 'not-authorized-offline-adapter',
    inputCnyPerMillion: stage.inputCnyPerMillion ?? 0, outputCnyPerMillion: stage.outputCnyPerMillion ?? 0,
    pricingSource: stage.pricingSource ?? 'https://example.invalid/not-authorized', pricingCheckedAt: stage.pricingCheckedAt ?? now,
    caps: stage.caps ?? { maxRequests: 1000, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000, maxCostCny: 30, maxDurationSeconds: 3600, maxRetries: 0 },
    taskBudget: stage.taskBudget ?? {}
  } };
}

export async function adaptSyntheticV3Dataset(manifestPath: string, rawOptions: SyntheticV3AdapterOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const absoluteManifest = path.resolve(manifestPath); const root = await realpath(path.dirname(absoluteManifest));
  const checksumBytes = await readFile(await safeFile(root, 'checksums/SHA256SUMS')); const checksums = parseChecksums(checksumBytes.toString('utf8'));
  const manifestRelative = path.basename(absoluteManifest);
  const manifestBytes = await verifiedFile(root, manifestRelative, checksums); const manifest = ManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  assertFixedDenominator(manifest);
  const bundlePartitions = new Map<string, string>(); const clusterPartitions = new Map<string, string>(); const hashPartitions = new Map<string, string>(); const storyPartitions = new Map<string, string>();
  const parsedGroups: ParsedGroup[] = [];
  for(const group of manifest.groups) {
    const inputBytes = await verifiedFile(root, group.inputPath, checksums); const input = InputSchema.parse(JSON.parse(inputBytes.toString('utf8')));
    const truthBytes = await verifiedFile(root, group.truthPath, checksums); const truth = TruthSchema.parse(JSON.parse(truthBytes.toString('utf8')));
    ensure(truth.expected.facets.event.every((value: string) => (EVENT_LABELS as readonly string[]).includes(value)), 'TRUTH_EVENT_ONTOLOGY_MISMATCH');
    ensure(truth.expected.facets.scene.every((value: string) => (SCENE_LABELS as readonly string[]).includes(value)), 'TRUTH_SCENE_ONTOLOGY_MISMATCH');
    for(const assertion of [...(truth.expected.structured?.requiredAssertions ?? []), ...(truth.expected.structured?.forbiddenAssertions ?? [])]) {
      if(assertion.facet === 'event') ensure((EVENT_LABELS as readonly string[]).includes(assertion.value), 'TRUTH_EVENT_ONTOLOGY_MISMATCH');
      if(assertion.facet === 'scene') ensure((SCENE_LABELS as readonly string[]).includes(assertion.value), 'TRUTH_SCENE_ONTOLOGY_MISMATCH');
    }
    ensure(input.datasetId === manifest.datasetId && truth.datasetId === manifest.datasetId, 'DATASET_ID_MISMATCH');
    ensure(input.specVersion === manifest.specVersion && truth.specVersion === manifest.specVersion, 'SPEC_VERSION_MISMATCH');
    ensure(input.groupId === group.groupId && truth.groupId === group.groupId, 'GROUP_ID_MISMATCH');
    ensure(input.partition === group.partition && input.comboCategory === group.comboCategory, 'GROUP_METADATA_MISMATCH');
    ensure(input.lifecycle === group.lifecycle && truth.expected.lifecycle === group.lifecycle, 'LIFECYCLE_MISMATCH');
    ensure(input.contextClusterId === group.contextClusterId, 'CONTEXT_CLUSTER_MISMATCH');
    ensure(JSON.stringify([...input.scenarioTags].sort()) === JSON.stringify([...group.scenarioTags].sort()), 'SCENARIO_TAG_MISMATCH');
    ensure(JSON.stringify([...input.sources.map((source: any) => source.assetId)].sort()) === JSON.stringify([...group.assetIds].sort()), 'ASSET_SET_MISMATCH');
    ensure(JSON.stringify([...truth.truthSourceBundleIds].sort()) === JSON.stringify([...group.upstreamBundleIds].sort()), 'TRUTH_PROVENANCE_MISMATCH');
    ensure(group.expectedAction === truth.expected.action && group.riskLevel === truth.expected.riskLevel, 'TRUTH_SUMMARY_MISMATCH');
    const truthAssets = input.sources.filter((source: any) => source.type !== 'audio_original' && !source.referenceOnly).map((source: any) => source.assetId).sort();
    ensure(JSON.stringify([...truth.expected.evidenceAssetIds].sort()) === JSON.stringify(truthAssets), 'TRUTH_EVIDENCE_SET_MISMATCH');
    const sources: ParsedSource[] = [];
    for(const source of input.sources) {
      ensure(group.upstreamBundleIds.includes(source.upstreamBundleId), 'FOREIGN_UPSTREAM_BUNDLE');
      ensure((ALLOWED_ORIGINS as readonly string[]).includes(source.assetOrigin) && manifest.assetOriginVocabulary.includes(source.assetOrigin as typeof ALLOWED_ORIGINS[number]), 'UNDECLARED_SYNTHETIC_ORIGIN');
      ensure(source.synthetic === true && source.personMatchingAllowed === false, 'NON_SYNTHETIC_SOURCE');
      const sourcePath = await safeFile(root, source.path); const bytesValue = await readFile(sourcePath);
      ensure(bytesHash(bytesValue) === source.sha256, 'SOURCE_HASH_MISMATCH'); ensure(bytesValue.length === source.bytes, 'SOURCE_LENGTH_MISMATCH');
      ensure(checksums.get(source.path) === bareHash(bytesValue), 'CHECKSUM_MISMATCH');
      let text: string | undefined; let dimensions: { width: number; height: number } | undefined;
      if(source.type === 'photo') {
        ensure(['image/jpeg', 'image/png', 'image/webp'].includes(source.mimeType), 'UNSUPPORTED_IMAGE_MIME');
        dimensions = inspectImagePayload(bytesValue, source.mimeType as SupportedImageMime);
        ensure(source.image?.width === dimensions.width && source.image?.height === dimensions.height, 'IMAGE_DIMENSION_MISMATCH');
      } else if(source.type === 'user_text' || source.type === 'final_asr') {
        ensure(source.mimeType.startsWith('text/plain'), 'UNSUPPORTED_TEXT_MIME'); text = decodeUtf8Payload(bytesValue); ensure(text.length > 0, 'EMPTY_TEXT_SOURCE');
      } else ensure(source.mimeType === 'audio/mp4', 'UNSUPPORTED_AUDIO_MIME');
      sources.push({ ...source, bytesValue, text, dimensions });
      const oldHashPartition = hashPartitions.get(source.sha256); ensure(!oldHashPartition || oldHashPartition === group.partition, 'DUPLICATE_SOURCE_CROSSES_PARTITION'); hashPartitions.set(source.sha256, group.partition);
    }
    for(const bundle of group.upstreamBundleIds) { const old = bundlePartitions.get(bundle); ensure(!old || old === group.partition, 'UPSTREAM_BUNDLE_CROSSES_PARTITION'); bundlePartitions.set(bundle, group.partition); }
    if(group.contextClusterId) { const old = clusterPartitions.get(group.contextClusterId); ensure(!old || old === group.partition, 'CONTEXT_CLUSTER_CROSSES_PARTITION'); clusterPartitions.set(group.contextClusterId, group.partition); }
    const oldStory = storyPartitions.get(truth.expected.storyKey); ensure(!oldStory || oldStory === group.partition, 'STORY_TRUTH_CROSSES_PARTITION'); storyPartitions.set(truth.expected.storyKey, group.partition);
    parsedGroups.push({ manifest: group, input, truth, sources, leakageGroup: stableLeakageKey(group) });
  }

  const groups = parsedGroups.map(parsed => {
    const envelope = buildEnvelope(manifest.datasetId, manifest.createdAt, parsed);
    const stage = buildStageGroup(parsed, envelope, options);
    const route = stage.request ? 'stage_a_photo_anchored' as const : parsed.input.lifecycle !== 'active' ? 'withdrawn' as const : 'content_organization_only' as const;
    return { groupId: parsed.input.groupId, partition: parsed.input.partition, leakageGroup: parsed.leakageGroup, route, envelope, stage, sourcePaths: Object.fromEntries(parsed.sources.map(source => [source.assetId, source.path])) };
  });
  const stageA = Object.fromEntries((['exploration', 't1_validation'] as const).map(partition => {
    const selected = groups.filter(group => group.partition === partition && group.stage.request);
    const photos = selected.flatMap(group => group.stage.photos.map(item => ({ photo: item.photo, path: `media/${item.photo.photoId}${path.extname(item.source.path).toLowerCase()}`, split: partition === 'exploration' ? 'exploration' as const : 'holdout' as const, leakageGroup: item.leakageGroup, externalConsentRef: 'synthetic-fixture-only' })));
    const truth = { version: 'sgx-truth.1', reviewedBy: 'synthetic-v3-source-review; adapter-does-not-independently-accept-truth', photos: selected.flatMap(group => group.stage.truth), taskOverrides: [] };
    const truthBytes = Buffer.from(JSON.stringify(truth, null, 2) + '\n');
    const stageManifest = {
      version: 'sgx-eval.1', batchId: safeId(`${manifest.datasetId}-${partition}`), status: options.stageA.status,
      partition: partition === 'exploration' ? 'exploration' as const : 'holdout' as const,
      provider: options.stageA.provider, model: options.stageA.model, providerUseReviewRef: options.stageA.providerUseReviewRef,
      prices: { inputCnyPerMillion: options.stageA.inputCnyPerMillion, outputCnyPerMillion: options.stageA.outputCnyPerMillion, source: options.stageA.pricingSource, checkedAt: options.stageA.pricingCheckedAt },
      caps: options.stageA.caps, truth: { path: 'truth.json', sha256: bytesHash(truthBytes) }, photos,
      tasks: selected.map(group => ({ taskId: safeId(`task-${group.groupId}`), request: group.stage.request!, evaluatePhotoIds: group.stage.request!.photos.map(photo => photo.photoId), expectedUnchangedPhotoIds: [], evaluation: { facets: ['time', 'place', 'event', 'scene'], personPairs: false, eventPairs: true, identityCandidates: false } }))
    };
    const media = new Map(selected.flatMap(group => group.stage.photos.map(item => [item.photo.photoId, item.source.bytesValue] as const)));
    return [partition, { manifest: stageManifest, truth, truthBytes, media }];
  })) as unknown as Record<'exploration' | 't1_validation', { manifest: Record<string, unknown>; truth: Record<string, unknown>; truthBytes: Buffer; media: Map<string, Buffer> }>;
  const routing = groups.map(group => ({
    groupId: group.groupId,
    partition: group.partition,
    route: group.route,
    contentOrganizationEvidenceIds: group.stage.contentOrganizationEvidenceIds,
    ...(group.stage.exclusion ? { reason: group.stage.exclusion } : {})
  }));
  const exclusions = routing.filter(group => group.route !== 'stage_a_photo_anchored');
  const routeCounts = {
    stage_a_photo_anchored: routing.filter(group => group.route === 'stage_a_photo_anchored').length,
    content_organization_only: routing.filter(group => group.route === 'content_organization_only').length,
    withdrawn: routing.filter(group => group.route === 'withdrawn').length
  };
  const report = {
    version: 'synthetic-v3-adapter-report.1', datasetId: manifest.datasetId, sourceManifestHash: bytesHash(manifestBytes), checksumManifestHash: bytesHash(checksumBytes),
    claimBoundary: SYNTHETIC_CLAIM_BOUNDARY, provenance: 'synthetic_fixture', artifactStatus: 'offline_adapter_output', credentialsRead: false, externalCalls: 0,
    fixedDenominator: { plannedGroups: manifest.plannedGroups, ingestionGroups: groups.length, stageAEligibleGroups: groups.length - exclusions.length, stageAExcludedGroups: exclusions.length },
    partitions: { exploration: groups.filter(group => group.partition === 'exploration').length, t1_validation: groups.filter(group => group.partition === 't1_validation').length },
    routes: routeCounts, routing, exclusions, generatedAt: options.now,
    warning: 'Synthetic fixture output only. It is not real-user data, real-world accuracy evidence, or independent truth acceptance.'
  };
  return { root, manifest, groups, stageA, report };
}

export async function writeSyntheticV3Artifacts(manifestPath: string, outputDirectory: string, options: SyntheticV3AdapterOptions = {}) {
  const output = path.resolve(outputDirectory);
  try { await lstat(output); fail('OUTPUT_DIRECTORY_EXISTS'); } catch(error) { if(error instanceof SyntheticV3AdapterError) throw error; if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const result = await adaptSyntheticV3Dataset(manifestPath, options);
  await mkdir(path.dirname(output), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.tmp-`));
  try {
    await mkdir(path.join(staging, 'ingestion'), { recursive: true });
    for(const group of result.groups) await writeFile(path.join(staging, 'ingestion', `${group.groupId}.json`), JSON.stringify(group.envelope, null, 2) + '\n', { mode: 0o600 });
    for(const partition of ['exploration', 't1_validation'] as const) {
      const stage = result.stageA[partition]; const directory = path.join(staging, 'stage-a', partition === 'exploration' ? 'exploration' : 't1-validation');
      await mkdir(path.join(directory, 'media'), { recursive: true });
      await writeFile(path.join(directory, 'truth.json'), stage.truthBytes, { mode: 0o600 });
      await writeFile(path.join(directory, 'batch.json'), JSON.stringify(stage.manifest, null, 2) + '\n', { mode: 0o600 });
      for(const item of (stage.manifest.photos as Array<{ photo: Photo; path: string }>)) {
        const bytes = stage.media.get(item.photo.photoId); ensure(bytes && bytesHash(bytes) === item.photo.sourceHash, 'SOURCE_HASH_MISMATCH');
        await writeFile(path.join(directory, item.path), bytes, { mode: 0o600 });
      }
    }
    await writeFile(path.join(staging, 'adapter-report.json'), JSON.stringify(result.report, null, 2) + '\n', { mode: 0o600 });
    await rename(staging, output);
  } catch(error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return result;
}
