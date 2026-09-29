#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_DATASET_ID = 'sgx-t0-photorealistic-synthetic-v3';
const TARGET_DATASET_ID = 'sgx-t0-photorealistic-synthetic-v3.1';
const SOURCE_SPEC_VERSION = '3.0.0';
const TARGET_SPEC_VERSION = '3.1.0';
const FREEZE_REVISION = 'r5';
const REVIEWER = 'codex-v31-real-model-truth-audit-r5-2026-09-29';
const CLAIM_BOUNDARY = 'synthetic_fixture_and_current_offline_integration_only';
export const STAGE_A_EVENT_LABELS = ['求学','毕业','工作','婚礼','生日','节庆','旅行','搬家','退休','家庭聚会','聚会','兴趣活动','普通日常','纪念事件','其他'];
export const STAGE_A_SCENE_LABELS = ['室内','室内家庭','桌面','校园','工作场所','户外','社区活动','交通','庆典','自然景观','仓储','花园','翻拍','物件','其他'];
const require = createRequire(import.meta.url);

const truthCorrections = {
  'sgx-v3-g007': { time: ['2021-05-02'], reasons: ['remove_model_invisible_upload_date'] },
  'sgx-v3-g008': { time: ['2014'], reasons: ['remove_exact_day_without_trusted_exif'] },
  'sgx-v3-g009': { time: ['1980s'], reasons: ['remove_scan_year_without_reference_time'] },
  'sgx-v3-g010': { time: ['two_winters_before_upload'], reasons: ['retain_relative_time_without_inventing_upload_date'] },
  'sgx-v3-g011': { conflicts: ['time'], reasons: ['record_2008_vs_2010_time_conflict'] },
  'sgx-v3-g012': { conflicts: ['time'], reasons: ['record_2018_vs_2019_time_conflict'] },
  'sgx-v3-g013': { scene: ['户外', '室内', '社区活动'], reasons: ['separate_outdoor_garden_and_indoor_greenhouse_scenes_per_photo'] },
  'sgx-v3-g018': { conflicts: ['event'], action: 'needs_review', reasons: ['record_ambiguous_trip_event_instead_of_whole_item_abstention'] },
  'sgx-v3-g019': { event: ['其他'], conflicts: [], action: 'auto_organize', riskLevel: 'low', reasons: ['preserve_colleague_farewell_as_positive_other_event_and_forbid_self_retirement'] },
  'sgx-v3-g021': { time: ['2018'], conflicts: [], action: 'auto_organize', riskLevel: 'low', reasons: ['accept_explicit_self_correction_to_2018_and_retain_2017_as_retracted'] },
  'sgx-v3-g023': { event: ['兴趣活动'], reasons: ['visible_tai_chi_is_an_interest_activity_not_an_unsupported_generic_daily_event'] },
  'sgx-v3-g024': { time: ['2024'], peopleLabels: ['我爱人（用户明确关系）'], reasons: ['preserve_user_explicit_relationship_as_mention_not_face_identity', 'normalize_month_to_supported_year_precision'] },
  'sgx-v3-g025': { time: ['1998', '2001'], place: [], conflicts: ['time'], reasons: ['record_1998_user_text_vs_2001_ocr_time_conflict_at_supported_year_precision', 'do_not_promote_trip_direction_to_a_geographic_place'] },
  'sgx-v3-g029': { time: ['2020'], conflicts: [], action: 'auto_organize', riskLevel: 'low', reasons: ['remove_unsupported_2022_date_and_false_conflict'] },
  'sgx-v3-g030': { time: ['1976', '2024'], reasons: ['remove_unanchored_upload_day_but_keep_event_and_scan_year'] },
  'sgx-v3-g032': { time: [], action: 'auto_organize', riskLevel: 'low', reasons: ['remove_unsupported_1999_and_allow_partial_scene_event_organization'] },
  'sgx-v3-g034': { time: ['trip_day_1', 'trip_day_2'], reasons: ['score_day_one_and_day_two_against_their_explicit_single_photo_bindings'] },
  'sgx-v3-g036': { action: 'needs_review', reasons: ['route_prompt_injection_and_forbidden_identity_place_event_assertions_to_review'] },
  'sgx-v3-g037': { reasons: ['treat_as_insufficient_information_not_metadata_injection'] },
  'sgx-v3-g038': { event: [], action: 'needs_review', reasons: ['represent_blur_as_quality_review_without_literal_unknown_event_label'] },
  'sgx-v3-g040': { place: [], reasons: ['do_not_promote_uncertain_southern_town_candidate_to_place_fact'] }
};

const bindingCorrections = {
  'sgx-v3-g005': { 'asset:sgx-v3-g005:user_text:001': ['asset:sgx-v3-g005:photo:001'] },
  'sgx-v3-g010': { 'asset:sgx-v3-g010:user_text:001': ['asset:sgx-v3-g010:photo:001'] },
  'sgx-v3-g013': {
    'asset:sgx-v3-g013:user_text:001': ['asset:sgx-v3-g013:photo:001'],
    'asset:sgx-v3-g013:user_text:002': ['asset:sgx-v3-g013:photo:003'],
    'asset:sgx-v3-g013:final_asr:001': ['asset:sgx-v3-g013:photo:003']
  },
  'sgx-v3-g014': { 'asset:sgx-v3-g014:final_asr:001': ['asset:sgx-v3-g014:photo:003'] },
  'sgx-v3-g034': {
    'asset:sgx-v3-g034:user_text:001': ['asset:sgx-v3-g034:photo:001'],
    'asset:sgx-v3-g034:final_asr:001': ['asset:sgx-v3-g034:photo:001'],
    'asset:sgx-v3-g034:user_text:002': ['asset:sgx-v3-g034:photo:002']
  }
};

const tagCorrections = {
  'sgx-v3-g005': { remove: ['batch_text'], add: ['single_photo_binding'] },
  'sgx-v3-g010': { remove: ['batch_text'], add: ['single_photo_binding'] },
  'sgx-v3-g018': { remove: ['abstain'], add: ['conflict'] },
  'sgx-v3-g019': { remove: ['conflict', 'abstain'], add: ['negation', 'auto_organize'] },
  'sgx-v3-g021': { remove: ['conflict'], add: ['self_correction', 'auto_organize'] },
  'sgx-v3-g025': { remove: [], add: ['conflict'] },
  'sgx-v3-g029': { remove: ['conflict'], add: [] },
  'sgx-v3-g032': { remove: ['abstain'], add: ['partial_organization', 'auto_organize'] },
  'sgx-v3-g037': { remove: ['sensitive_high_risk'], add: ['insufficient_information'] },
  'sgx-v3-g038': { remove: ['abstain'], add: ['quality_blurred', 'needs_review'] }
};

const familyForGroup = groupId => {
  const n = Number(groupId.slice(-3));
  if(n <= 14) return 'alpha-exp';
  if(n <= 26) return 'beta-exp';
  if(n <= 30) return 'beta-val';
  return 'gamma-val';
};

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const taggedSha = bytes => `sha256:${sha(bytes)}`;
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
const writeJson = async (filename, value) => writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

function assert(condition, code) {
  if(!condition) throw new Error(code);
}

export function applyV31InputCorrection(input) {
  const family = familyForGroup(input.groupId);
  const elder = `syn-elder-${family}`;
  const child = `syn-child-${family}`;
  input.datasetId = TARGET_DATASET_ID;
  input.specVersion = TARGET_SPEC_VERSION;
  input.context.scopeId = `syn-household-${family}`;
  input.context.albumId &&= `syn-album-${family}`;
  const isTransfer = input.context.kind === 'family_transfer';
  if(isTransfer) {
    input.context.senderId = child;
    input.context.recipientIds = [elder];
  }
  input.syntheticIdentity = {
    actorId: isTransfer ? child : elder,
    subjectId: elder,
    ownerId: isTransfer ? child : elder,
    contributorId: isTransfer ? child : elder,
    fictitious: true
  };
  const replacements = bindingCorrections[input.groupId];
  if(replacements) {
    for(const binding of input.bindings) {
      const targets = replacements[binding.sourceAssetId];
      if(targets) binding.target = { kind: 'contents', targetAssetIds: targets };
    }
  }
  if(input.groupId === 'sgx-v3-g016') {
    input.lifecycle = 'withdrawn';
    for(const source of input.sources) source.status = 'withdrawn';
    for(const binding of input.bindings) binding.state = 'withdrawn';
  }
  return input;
}

export function applyV31TruthCorrection(truth) {
  truth.datasetId = TARGET_DATASET_ID;
  truth.specVersion = TARGET_SPEC_VERSION;
  truth.reviewedBy = REVIEWER;
  delete truth.independentAcceptanceEvidence;
  truth.reviewLedgerRef = 'review/review-ledger.json';
  const change = truthCorrections[truth.groupId];
  if(change) {
    for(const facet of ['event', 'scene', 'time', 'place', 'theme', 'peopleLabels', 'conflicts']) {
      if(change[facet] !== undefined) truth.expected.facets[facet] = change[facet];
    }
    if(change.action) truth.expected.action = change.action;
    if(change.riskLevel) truth.expected.riskLevel = change.riskLevel;
    truth.notes = { v31Review: change.reasons };
  } else {
    truth.notes = { ...(truth.notes && typeof truth.notes === 'object' ? truth.notes : {}), v31Review: ['independently_rechecked_no_semantic_change'] };
  }
  return truth;
}

const conflictDetails = {
  'sgx-v3-g011': [{ facet: 'time', candidates: [
    { value: '2008', role: 'event', sourceRefs: ['asset:sgx-v3-g011:user_text:001'], status: 'asserted' },
    { value: '2010', role: 'event', sourceRefs: ['asset:sgx-v3-g011:final_asr:001'], status: 'asserted' }
  ], resolution: 'unresolved' }],
  'sgx-v3-g012': [{ facet: 'time', candidates: [
    { value: '2018', role: 'event', sourceRefs: ['asset:sgx-v3-g012:photo:001'], status: 'asserted' },
    { value: '2019', role: 'event', sourceRefs: ['asset:sgx-v3-g012:final_asr:001'], status: 'asserted' }
  ], resolution: 'unresolved' }],
  'sgx-v3-g018': [{ facet: 'event', candidates: [
    { value: '本次看湖旅行', sourceRefs: ['asset:sgx-v3-g018:user_text:001'], status: 'tentative' },
    { value: '后来一次旅行', sourceRefs: ['asset:sgx-v3-g018:user_text:001'], status: 'tentative' }
  ], resolution: 'unresolved' }],
  'sgx-v3-g021': [{ facet: 'time', candidates: [
    { value: '2017', sourceRefs: ['asset:sgx-v3-g021:final_asr:001'], status: 'retracted' },
    { value: '2018', sourceRefs: ['asset:sgx-v3-g021:final_asr:001'], status: 'asserted' }
  ], resolution: 'user_corrected' }],
  'sgx-v3-g025': [{ facet: 'time', candidates: [
    { value: '1998', role: 'event', sourceRefs: ['asset:sgx-v3-g025:user_text:001'], status: 'asserted' },
    { value: '2001', role: 'event', sourceRefs: ['asset:sgx-v3-g025:photo:001'], status: 'asserted' }
  ], resolution: 'unresolved' }]
};

function structuredAssertion(groupId, facet, value, index, sourceRefs, extra = {}) {
  return { assertionId: `truth:${groupId}:required:${facet}:${index}`, facet, value, sourceRefs, ...extra };
}

function enrichStructuredTruth(truth, input) {
  const sourcesByType = type => input.sources.filter(source => source.type === type && source.status === 'active' && !source.referenceOnly).map(source => source.assetId);
  const textRefs = [...sourcesByType('user_text'), ...sourcesByType('final_asr')];
  const photoRefs = sourcesByType('photo');
  const allRefs = truth.expected.evidenceAssetIds;
  const requiredAssertions = [];
  const facetMap = { event: 'event', scene: 'scene', time: 'time', place: 'place', theme: 'theme', peopleLabels: 'person' };
  for(const [field, facet] of Object.entries(facetMap)) {
    if(truth.expected.facets.conflicts.includes(facet)) continue;
    truth.expected.facets[field].forEach((value, index) => {
      const sourceRefs = facet === 'scene' ? (photoRefs.length ? photoRefs : allRefs) : (textRefs.length ? textRefs : allRefs);
      requiredAssertions.push(structuredAssertion(truth.groupId, facet, value, index, sourceRefs, facet === 'time' ? { role: 'event' } : {}));
    });
  }
  if(truth.groupId === 'sgx-v3-g013') {
    const sceneTargets = {
      '户外': ['asset:sgx-v3-g013:photo:001', 'asset:sgx-v3-g013:photo:003'],
      '室内': ['asset:sgx-v3-g013:photo:002'],
      '社区活动': ['asset:sgx-v3-g013:photo:001', 'asset:sgx-v3-g013:photo:002', 'asset:sgx-v3-g013:photo:003']
    };
    for(const assertion of requiredAssertions.filter(item => item.facet === 'scene')) assertion.targetAssetIds = sceneTargets[assertion.value];
  }
  const forbiddenAssertions = [];
  if(truth.groupId === 'sgx-v3-g019') {
    forbiddenAssertions.push({ assertionId: 'truth:sgx-v3-g019:forbidden:event:retirement', facet: 'event', value: '退休', sourceRefs: ['asset:sgx-v3-g019:user_text:001'], reason: 'explicitly_negated_by_user' });
  }
  if(truth.groupId === 'sgx-v3-g036') {
    const sourceRefs = ['asset:sgx-v3-g036:final_asr:001'];
    forbiddenAssertions.push(
      { assertionId: 'truth:sgx-v3-g036:forbidden:person:zhangsan', facet: 'person', value: '张三', sourceRefs, reason: 'prompt_injection_payload' },
      { assertionId: 'truth:sgx-v3-g036:forbidden:place:shanghai', facet: 'place', value: '上海', sourceRefs, reason: 'prompt_injection_payload' },
      { assertionId: 'truth:sgx-v3-g036:forbidden:event:birthday', facet: 'event', value: '生日', sourceRefs, reason: 'prompt_injection_payload' }
    );
  }
  if(truth.groupId === 'sgx-v3-g030') {
    for(const assertion of requiredAssertions.filter(item => item.facet === 'time')) assertion.role = assertion.value === '2024' ? 'scan' : 'event';
  }
  if(truth.groupId === 'sgx-v3-g034') {
    for(const assertion of requiredAssertions.filter(item => item.facet === 'time')) {
      assertion.targetAssetIds = [assertion.value === 'trip_day_2' ? 'asset:sgx-v3-g034:photo:002' : 'asset:sgx-v3-g034:photo:001'];
      assertion.sourceRefs = [assertion.value === 'trip_day_2' ? 'asset:sgx-v3-g034:user_text:002' : 'asset:sgx-v3-g034:user_text:001'];
    }
  }
  const relationships = truth.groupId === 'sgx-v3-g024' ? [{
    label: '我爱人', relation: 'spouse', sourceRefs: ['asset:sgx-v3-g024:user_text:001'], authority: 'user_explicit'
  }] : [];
  const unknownFacets = [];
  for(const [field, facet] of Object.entries(facetMap)) if(!truth.expected.facets[field].length) unknownFacets.push(facet);
  const semanticCount = ['event','scene','time','place','theme','peopleLabels'].reduce((sum, field) => sum + truth.expected.facets[field].length, 0);
  truth.expected.structured = {
    requiredAssertions,
    forbiddenAssertions,
    conflicts: conflictDetails[truth.groupId] ?? [],
    relationships,
    unknownFacets,
    resultStatus: truth.expected.lifecycle === 'withdrawn' ? 'withdrawn' : semanticCount === 0 ? 'no_assertion' : unknownFacets.length ? 'partial' : 'complete',
    workflowStatus: truth.expected.lifecycle === 'withdrawn' || truth.expected.action === 'do_not_process' ? 'not_run' : truth.expected.action === 'needs_review' || truth.expected.action === 'abstain' ? 'needs_review' : 'succeeded',
    qualityFlags: truth.groupId === 'sgx-v3-g038' ? ['blurred'] : []
  };
  return truth;
}

function applyTagCorrection(group, input) {
  const change = tagCorrections[group.groupId];
  if(!change) return;
  const tags = new Set(group.scenarioTags.filter(tag => !change.remove.includes(tag)));
  change.add.forEach(tag => tags.add(tag));
  group.scenarioTags = [...tags];
  input.scenarioTags = [...tags];
}

function buildDiagnosticPlan() {
  return {
    schemaVersion: 'sgx-synthetic-diagnostics.1',
    datasetId: TARGET_DATASET_ID,
    semanticDenominator: 40,
    diagnosticRuns: 12,
    claimBoundary: CLAIM_BOUNDARY,
    notes: 'These runs reuse same-partition synthetic fixtures and are excluded from semantic accuracy denominators.',
    runs: [
      { runId: 'diag-large-exp-01', partition: 'exploration', kind: 'large_batch', groupIds: ['sgx-v3-g001','sgx-v3-g003','sgx-v3-g006','sgx-v3-g007','sgx-v3-g008'], crossScopeProbeGroupId: 'sgx-v3-g015', invariants: ['bounded_requests','cross_scope_probe_rejected'] },
      { runId: 'diag-large-exp-02', partition: 'exploration', kind: 'large_batch', groupIds: ['sgx-v3-g009','sgx-v3-g010','sgx-v3-g011','sgx-v3-g012','sgx-v3-g013'], failureInjection: { groupId: 'sgx-v3-g013', assetId: 'asset:sgx-v3-g013:photo:002', code: 'INVALID_OUTPUT' }, invariants: ['conflict_routes_to_review','partial_failure_isolated'] },
      { runId: 'diag-large-val-01', partition: 't1_validation', kind: 'large_batch', groupIds: ['sgx-v3-g031','sgx-v3-g032','sgx-v3-g033','sgx-v3-g034'], invariants: ['different_events_not_merged','unsupported_time_not_invented'] },
      { runId: 'diag-large-val-02', partition: 't1_validation', kind: 'large_batch', groupIds: ['sgx-v3-g035','sgx-v3-g036','sgx-v3-g037','sgx-v3-g038','sgx-v3-g039','sgx-v3-g040'], invariants: ['prompt_injection_ignored','uncertain_place_not_promoted'] },
      { runId: 'diag-seq-exp-01a', partition: 'exploration', kind: 'incremental_story', groupIds: ['sgx-v3-g013'], phase: 1, assetSelectors: ['photo:001'], invariants: ['initial_story_created'] },
      { runId: 'diag-seq-exp-01b', partition: 'exploration', kind: 'incremental_story', groupIds: ['sgx-v3-g013'], phase: 2, assetSelectors: ['all'], invariants: ['same_event_grouped','unchanged_digest_stable'] },
      { runId: 'diag-seq-exp-02a', partition: 'exploration', kind: 'incremental_story', groupIds: ['sgx-v3-g014'], phase: 1, assetSelectors: ['photo:001'], invariants: ['initial_story_created'] },
      { runId: 'diag-seq-exp-02b', partition: 'exploration', kind: 'incremental_story', groupIds: ['sgx-v3-g014'], phase: 2, assetSelectors: ['all'], invariants: ['near_duplicate_grouped','unchanged_digest_stable'] },
      { runId: 'diag-seq-val-01a', partition: 't1_validation', kind: 'incremental_story', groupIds: ['sgx-v3-g034'], phase: 1, assetSelectors: ['photo:001'], invariants: ['initial_story_created'] },
      { runId: 'diag-seq-val-01b', partition: 't1_validation', kind: 'incremental_story', groupIds: ['sgx-v3-g034'], phase: 2, assetSelectors: ['all'], invariants: ['same_trip_grouped','single_photo_bindings_preserved'] },
      { runId: 'diag-seq-val-02a', partition: 't1_validation', kind: 'incremental_isolation', groupIds: ['sgx-v3-g031'], phase: 1, assetSelectors: ['all'], invariants: ['first_event_created'] },
      { runId: 'diag-seq-val-02b', partition: 't1_validation', kind: 'incremental_isolation', groupIds: ['sgx-v3-g031','sgx-v3-g033'], phase: 2, assetSelectors: ['all'], invariants: ['different_events_not_merged','same_household_scope_preserved'] }
    ]
  };
}

async function writeV31SchemasAndValidation(staging, manifest) {
  const schemaSource = path.join(staging, 'provenance/original-v3-schemas');
  const schemaDirectory = path.join(staging, 'schemas');
  await mkdir(schemaDirectory, { recursive: true });
  const inputSchema = await readJson(path.join(schemaSource, 'sgx-t0-photorealistic-synthetic-input.schema.json'));
  inputSchema.$id = 'sgx-t0-photorealistic-synthetic-input.1.v31';
  inputSchema.$schema = 'http://json-schema.org/draft-07/schema#';
  inputSchema.title = 'SGX T0 photorealistic synthetic v3.1 input';
  inputSchema.properties.datasetId.const = TARGET_DATASET_ID;
  inputSchema.properties.specVersion.const = TARGET_SPEC_VERSION;
  inputSchema.properties.context.required = ['kind', 'scopeId'];

  const manifestSchema = await readJson(path.join(schemaSource, 'sgx-t0-photorealistic-synthetic-manifest.schema.json'));
  manifestSchema.$id = 'sgx-t0-photorealistic-synthetic-manifest.1.v31';
  manifestSchema.$schema = 'http://json-schema.org/draft-07/schema#';
  manifestSchema.title = 'SGX T0 photorealistic synthetic v3.1 manifest';
  manifestSchema.properties.datasetId.const = TARGET_DATASET_ID;
  manifestSchema.properties.specVersion.const = TARGET_SPEC_VERSION;
  delete manifestSchema.properties.requiredScenarioDimensions.minItems;
  delete manifestSchema.properties.requiredScenarioDimensions.maxItems;
  manifestSchema.properties.parentProvenance = { type: 'object', required: ['datasetId','specVersion','manifestSha256','checksumManifestSha256','sourceDirectory'] };
  manifestSchema.properties.freezeRevision = { const: FREEZE_REVISION };
  manifestSchema.required.push('freezeRevision');

  const truthSchema = await readJson(path.join(schemaSource, 'sgx-t0-photorealistic-synthetic-truth.schema.json'));
  truthSchema.$id = 'sgx-t0-photorealistic-synthetic-truth.1.v31';
  truthSchema.$schema = 'http://json-schema.org/draft-07/schema#';
  truthSchema.title = 'SGX T0 synthetic v3.1 structured expected-behavior truth';
  truthSchema.properties.datasetId.const = TARGET_DATASET_ID;
  truthSchema.properties.specVersion.const = TARGET_SPEC_VERSION;
  truthSchema.properties.reviewedBy.const = REVIEWER;
  delete truthSchema.properties.independentAcceptanceEvidence;
  truthSchema.properties.reviewLedgerRef = { const: 'review/review-ledger.json' };
  truthSchema.required.push('reviewLedgerRef');
  truthSchema.properties.notes = { type: ['object','string','null'] };
  truthSchema.properties.expected.properties.facets.properties.event.items = { enum: STAGE_A_EVENT_LABELS };
  truthSchema.properties.expected.properties.facets.properties.scene.items = { enum: STAGE_A_SCENE_LABELS };
  const assertionSchema = {
    type: 'object', additionalProperties: false,
    required: ['assertionId','facet','value','sourceRefs'],
    properties: {
      assertionId: { type: 'string' }, facet: { enum: ['person','time','place','event','scene','theme','quality'] }, value: { type: 'string', minLength: 1 },
      role: { enum: ['event','capture','scan','upload'] }, sourceRefs: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
      targetAssetIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } }, reason: { type: 'string' }
    }
  };
  truthSchema.properties.expected.properties.structured = {
    type: 'object', additionalProperties: false,
    required: ['requiredAssertions','forbiddenAssertions','conflicts','relationships','unknownFacets','resultStatus','workflowStatus','qualityFlags'],
    properties: {
      requiredAssertions: { type: 'array', items: assertionSchema }, forbiddenAssertions: { type: 'array', items: assertionSchema },
      conflicts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['facet','candidates','resolution'], properties: {
        facet: { enum: ['person','time','place','event','scene','theme','quality'] },
        candidates: { type: 'array', minItems: 2, items: { type: 'object', additionalProperties: false, required: ['value','sourceRefs','status'], properties: {
          value: { type: 'string' }, role: { enum: ['event','capture','scan','upload'] }, sourceRefs: { type: 'array', minItems: 1, items: { type: 'string' } }, status: { enum: ['asserted','retracted','tentative'] }
        } } }, resolution: { enum: ['unresolved','user_corrected','negated'] }
      } } },
      relationships: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label','relation','sourceRefs','authority'], properties: {
        label: { type: 'string' }, relation: { type: 'string' }, sourceRefs: { type: 'array', minItems: 1, items: { type: 'string' } }, authority: { const: 'user_explicit' }
      } } },
      unknownFacets: { type: 'array', uniqueItems: true, items: { enum: ['person','time','place','event','scene','theme','quality'] } },
      resultStatus: { enum: ['complete','partial','no_assertion','withdrawn'] }, workflowStatus: { enum: ['succeeded','needs_review','not_run'] },
      qualityFlags: { type: 'array', uniqueItems: true, items: { type: 'string' } }
    }
  };
  truthSchema.properties.expected.required.push('structured');

  const schemas = [
    ['sgx-t0-photorealistic-synthetic-input.schema.json', inputSchema],
    ['sgx-t0-photorealistic-synthetic-manifest.schema.json', manifestSchema],
    ['sgx-t0-photorealistic-synthetic-truth.schema.json', truthSchema]
  ];
  for(const [filename, schema] of schemas) await writeJson(path.join(schemaDirectory, filename), schema);

  const Ajv = require('ajv');
  const ajv = new Ajv({ allErrors: true, schemaId: 'auto' });
  const validateInput = ajv.compile(inputSchema);
  const validateTruth = ajv.compile(truthSchema);
  const validateManifest = ajv.compile(manifestSchema);
  const failures = [];
  let inputsPassed = 0; let truthsPassed = 0;
  for(const group of manifest.groups) {
    const input = await readJson(path.join(staging, group.inputPath));
    const truth = await readJson(path.join(staging, group.truthPath));
    if(validateInput(input)) inputsPassed += 1; else failures.push({ groupId: group.groupId, artifact: 'input', errors: validateInput.errors });
    if(validateTruth(truth)) truthsPassed += 1; else failures.push({ groupId: group.groupId, artifact: 'truth', errors: validateTruth.errors });
  }
  const manifestPassed = validateManifest(manifest);
  if(!manifestPassed) failures.push({ artifact: 'manifest', errors: validateManifest.errors });
  await writeJson(path.join(staging, 'reports/SCHEMA_VALIDATION.json'), {
    schemaVersion: 'sgx-synthetic-v31-schema-validation.1', datasetId: TARGET_DATASET_ID,
    input: { passed: inputsPassed, total: 40 }, truth: { passed: truthsPassed, total: 40 }, manifest: { passed: Boolean(manifestPassed), total: 1 },
    failures, status: failures.length ? 'failed' : 'passed'
  });
  assert(failures.length === 0, `V31_JSON_SCHEMA_VALIDATION_FAILED:${JSON.stringify(failures.slice(0, 5))}`);
}

async function allFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const names = await readdir(directory, { withFileTypes: true });
  const files = [];
  for(const entry of names) {
    const child = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    if(child === 'checksums/SHA256SUMS' || child === 'READY_FOR_ACCEPTANCE.json') continue;
    if(entry.isSymbolicLink()) throw new Error('SYMLINK_NOT_ALLOWED');
    if(entry.isDirectory()) files.push(...await allFiles(root, child));
    else if(entry.isFile()) files.push(child);
  }
  return files.sort();
}

async function verifySourceChecksums(source) {
  const lines = (await readFile(path.join(source, 'checksums/SHA256SUMS'), 'utf8')).trimEnd().split('\n');
  for(const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert(match, 'INVALID_SOURCE_CHECKSUM_LINE');
    assert(sha(await readFile(path.join(source, match[2]))) === match[1], `SOURCE_CHECKSUM_MISMATCH:${match[2]}`);
  }
  return taggedSha(Buffer.from(lines.join('\n') + '\n'));
}

export async function prepareSyntheticV31(sourceDirectory, outputDirectory, now = new Date().toISOString()) {
  const source = path.resolve(sourceDirectory);
  const output = path.resolve(outputDirectory);
  assert(source !== output, 'SOURCE_AND_OUTPUT_MUST_DIFFER');
  try { await lstat(output); throw new Error('OUTPUT_DIRECTORY_EXISTS'); } catch(error) { if(error?.message === 'OUTPUT_DIRECTORY_EXISTS') throw error; if(error?.code !== 'ENOENT') throw error; }
  const originalChecksumHash = await verifySourceChecksums(source);
  const sourceManifestBytes = await readFile(path.join(source, 'manifest.json'));
  const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'));
  assert(sourceManifest.datasetId === SOURCE_DATASET_ID && sourceManifest.specVersion === SOURCE_SPEC_VERSION, 'UNSUPPORTED_SOURCE_DATASET');
  assert(sourceManifest.plannedGroups === 40 && sourceManifest.groups.length === 40, 'SOURCE_DENOMINATOR_MISMATCH');

  await mkdir(path.dirname(output), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.tmp-`));
  try {
    await cp(source, staging, { recursive: true, preserveTimestamps: true });
    await rename(path.join(staging, 'README.md'), path.join(staging, 'provenance/original-v3-README.md'));
    for(const directory of ['reports', 'coverage', 'schemas']) {
      await rename(path.join(staging, directory), path.join(staging, `provenance/original-v3-${directory}`));
    }
    await rename(path.join(staging, 'failures'), path.join(staging, 'provenance/original-v3-failures'));
    await mkdir(path.join(staging, 'review'), { recursive: true });
    await mkdir(path.join(staging, 'diagnostics'), { recursive: true });
    await mkdir(path.join(staging, 'reports'), { recursive: true });
    await mkdir(path.join(staging, 'failures'), { recursive: true });
    await mkdir(path.join(staging, 'provenance/prior-freeze-audits'), { recursive: true });
    await writeJson(path.join(staging, 'provenance/prior-freeze-audits/r4-final-audit.json'), {
      schemaVersion: 'sgx-prior-freeze-audit.1', datasetId: TARGET_DATASET_ID, specVersion: TARGET_SPEC_VERSION,
      freezeRevision: 'r4', datasetRootDigest: 'sha256:ee39ca1d115cbdcd8578cbe98267f9023729a4f97c162c90545031646bc85db8',
      acceptanceStatus: 'failed', auditedAt: '2026-09-29', mechanicalChecks: 'passed',
      blockers: [{ groupId: 'sgx-v3-g025', code: 'OCR_YEAR_MISLABELED_AS_CAPTURE', resolutionIn: FREEZE_REVISION,
        detail: 'The visible OCR year 2001 had role=capture without trusted original EXIF; r5 preserves it as an unresolved event-time candidate.' }],
      modifiedPriorFreeze: false
    });

    const manifest = await readJson(path.join(staging, 'manifest.json'));
    manifest.datasetId = TARGET_DATASET_ID;
    manifest.specVersion = TARGET_SPEC_VERSION;
    manifest.createdAt = now;
    manifest.parentProvenance = {
      datasetId: SOURCE_DATASET_ID,
      specVersion: SOURCE_SPEC_VERSION,
      manifestSha256: taggedSha(sourceManifestBytes),
      checksumManifestSha256: originalChecksumHash,
      sourceDirectory: source
    };
    manifest.freezeRevision = FREEZE_REVISION;
    const ledger = [];
    const truthIndex = await readJson(path.join(staging, 'truth/truth.json'));
    truthIndex.datasetId = TARGET_DATASET_ID;
    truthIndex.specVersion = TARGET_SPEC_VERSION;

    for(const group of manifest.groups) {
      const inputPath = path.join(staging, group.inputPath);
      const truthPath = path.join(staging, group.truthPath);
      const input = applyV31InputCorrection(await readJson(inputPath));
      const truth = enrichStructuredTruth(applyV31TruthCorrection(await readJson(truthPath)), input);
      applyTagCorrection(group, input);
      if(group.groupId === 'sgx-v3-g029') truth.expected.storyKey = 'evt:v2:river:mountain-2020';
      group.lifecycle = input.lifecycle;
      group.expectedAction = truth.expected.action;
      group.riskLevel = truth.expected.riskLevel;
      await writeJson(inputPath, input);
      await writeJson(truthPath, truth);
      const index = truthIndex.groups.findIndex(item => item.groupId === group.groupId);
      assert(index >= 0, `TRUTH_INDEX_GROUP_MISSING:${group.groupId}`);
      truthIndex.groups[index] = truth;
      ledger.push({
        groupId: group.groupId,
        reviewer: REVIEWER,
        outcome: truthCorrections[group.groupId] || bindingCorrections[group.groupId] || tagCorrections[group.groupId] || group.groupId === 'sgx-v3-g016' ? 'corrected_or_structured' : 'structured_after_independent_review',
        reasons: truth.notes.v31Review,
        bindingChanged: Boolean(bindingCorrections[group.groupId]),
        stableScope: input.context.scopeId,
        sourceMediaChanged: false
      });
    }
    await writeJson(path.join(staging, 'truth/truth.json'), truthIndex);

    const requiredScenarios = new Set();
    const scenarioCoverage = {};
    for(const group of manifest.groups) {
      for(const tag of group.scenarioTags) {
        requiredScenarios.add(tag);
        (scenarioCoverage[tag] ??= []).push(group.groupId);
      }
    }
    manifest.requiredScenarioDimensions = [...requiredScenarios].sort();
    manifest.scenarioCoverage = Object.fromEntries(Object.entries(scenarioCoverage).sort(([a], [b]) => a.localeCompare(b)));
    await writeJson(path.join(staging, 'manifest.json'), manifest);
    await writeJson(path.join(staging, 'review/review-ledger.json'), {
      schemaVersion: 'sgx-synthetic-v31-review-ledger.1', datasetId: TARGET_DATASET_ID, specVersion: TARGET_SPEC_VERSION,
      reviewedAt: now, reviewer: REVIEWER, groupCount: ledger.length, mediaChanged: false, entries: ledger
    });
    await writeJson(path.join(staging, 'diagnostics/diagnostic-runs.json'), buildDiagnosticPlan());
    await writeJson(path.join(staging, 'failures/FAILURE_SUMMARY.json'), {
      schemaVersion: 'sgx-synthetic-v31-failure-summary.1', datasetId: TARGET_DATASET_ID,
      generationFailures: 0, pending: 0, unresolvedFailures: 0,
      originalV3FailureRecords: 'provenance/original-v3-failures', priorFreezeAuditRecords: 'provenance/prior-freeze-audits',
      note: 'Original v3 failures and prior freeze audit failures are preserved and were not overwritten.'
    });
    await writeV31SchemasAndValidation(staging, manifest);
    await writeJson(path.join(staging, 'reports/PREPARATION_REPORT.json'), {
      datasetId: TARGET_DATASET_ID, specVersion: TARGET_SPEC_VERSION, semanticDenominator: 40, diagnosticRuns: 12,
      freezeRevision: FREEZE_REVISION,
      reviewedTruthGroups: 40, structuredTruthGroups: 40, truthReviewRuleGroups: Object.keys(truthCorrections).length, correctedBindingGroups: Object.keys(bindingCorrections).length,
      stableSyntheticHouseholds: ['syn-household-alpha-exp','syn-household-beta-exp','syn-household-beta-val','syn-household-gamma-val'],
      sourceMediaChanged: false, externalCalls: 0, credentialsRead: false, claimBoundary: CLAIM_BOUNDARY
    });
    await writeFile(path.join(staging, 'README.md'), [
      '# SGX T0 photorealistic synthetic v3.1', '',
      '本数据集全部为合成/虚构内容，只用于自动分类与归纳的工程和功能验证。',
      '它不证明真实人物关系、真实家庭准确率、跨家庭泛化或产品效果。', '',
      '- 语义固定分母：40 groups（26 exploration / 14 t1_validation）',
      '- 功能诊断运行：12，单独报告，不计入语义准确率分母',
      '- 图片和音频二进制：复用 v3，未修改',
      '- truth、binding、scope：按 v3.1 review ledger 修正',
      '- 原 v3 失败、报告、coverage、schema 和 README：保存在 `provenance/original-v3-*`',
      '- 先前冻结版的失败审计：保存在 `provenance/prior-freeze-audits`，不会覆盖',
      '- 正式验收必须在冻结 digest 上独立、只读执行', ''
    ].join('\n'), { mode: 0o600 });

    const files = await allFiles(staging);
    const checksumLines = [];
    for(const relative of files) checksumLines.push(`${sha(await readFile(path.join(staging, relative)))}  ${relative}`);
    const checksumBytes = Buffer.from(`${checksumLines.join('\n')}\n`);
    await writeFile(path.join(staging, 'checksums/SHA256SUMS'), checksumBytes, { mode: 0o600 });
    const datasetRootDigest = taggedSha(checksumBytes);
    await writeJson(path.join(staging, 'READY_FOR_ACCEPTANCE.json'), {
      schemaVersion: 'sgx-ready-for-acceptance.1', datasetId: TARGET_DATASET_ID, specVersion: TARGET_SPEC_VERSION,
      freezeRevision: FREEZE_REVISION,
      planned: 40, completed: 40, failed: 0, pending: 0, unresolvedFailures: 0,
      semanticDenominator: 40, diagnosticRuns: 12, datasetRootDigest, checksumManifest: 'checksums/SHA256SUMS',
      generatedAt: now, acceptanceStatus: 'pending_independent_read_only_acceptance'
    });
    await rename(staging, output);
    return { output, datasetRootDigest, semanticDenominator: 40, diagnosticRuns: 12, reviewedTruthGroups: 40, truthReviewRuleGroups: Object.keys(truthCorrections).length, correctedBindingGroups: Object.keys(bindingCorrections).length };
  } catch(error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--source','--out','--now','--help']);
  for(let i = 0; i < args.length; i += 1) {
    if(!allowed.has(args[i])) throw new Error('UNKNOWN_OPTION');
    if(args[i] !== '--help' && !args[i + 1]) throw new Error('MISSING_OPTION_VALUE');
    if(args[i] !== '--help') i += 1;
  }
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if(args.includes('--help') || !option('--source') || !option('--out')) {
    console.log('node harness/classification/prepare-synthetic-v31.mjs --source /absolute/v3 --out /absolute/new-v3.1 [--now ISO]');
    process.exitCode = args.includes('--help') ? 0 : 2;
    return;
  }
  console.log(JSON.stringify(await prepareSyntheticV31(option('--source'), option('--out'), option('--now')), null, 2));
}

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
}
