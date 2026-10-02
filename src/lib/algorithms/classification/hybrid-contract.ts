import { z } from 'zod';
import { ScopeSchema } from './stage-a-contract';

export const HYBRID_CONTRACT_VERSION = 'classification-hybrid.2';
export const HYBRID_SCHEMA_VERSION = '2.0';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTime = z.string().datetime({ offset: true });
const uniqueIds = (values: string[]): boolean => new Set(values).size === values.length;

const versionFields = {
  schemaVersion: z.literal(HYBRID_SCHEMA_VERSION),
  contractVersion: z.literal(HYBRID_CONTRACT_VERSION)
};

export const FeatureKindSchema = z.enum([
  'exact_hash',
  'perceptual_hash',
  'exif_time',
  'geo',
  'ocr_text',
  'image_embedding',
  'text_embedding',
  'quality',
  'person_embedding'
]);

export const AssetFeatureSchema = z.object({
  ...versionFields,
  featureId: id,
  scope: ScopeSchema,
  contentId: id,
  sourceEvidenceIds: z.array(id).min(1).max(64).refine(uniqueIds, 'DUPLICATE_SOURCE_EVIDENCE'),
  sourceDigest: hash,
  featureKind: FeatureKindSchema,
  producerVersion: id,
  modelVersion: id.optional(),
  valueRef: id.optional(),
  valueDigest: hash,
  vectorDimensions: z.number().int().positive().max(65536).optional(),
  biometricConsentRef: id.optional(),
  lifecycleState: z.enum(['active', 'invalidated', 'withdrawn']),
  createdAt: dateTime
}).strict().superRefine((value, ctx) => {
  const vector = ['image_embedding', 'text_embedding', 'person_embedding'].includes(value.featureKind);
  if(vector && (!value.modelVersion || !value.valueRef || !value.vectorDimensions)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'VECTOR_FEATURE_METADATA_REQUIRED' });
  }
  if(value.featureKind === 'person_embedding' && !value.biometricConsentRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BIOMETRIC_CONSENT_REQUIRED' });
  }
  if(value.featureKind !== 'person_embedding' && value.biometricConsentRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BIOMETRIC_CONSENT_NOT_APPLICABLE' });
  }
});

export const RetrievalCandidateSchema = z.object({
  ...versionFields,
  candidateId: id,
  scope: ScopeSchema,
  fromContentId: id,
  toContentId: id,
  relation: z.enum(['same_story', 'same_event', 'same_person', 'related']),
  rank: z.number().int().positive().max(1000),
  retrievalScore: z.number().min(0).max(1).optional(),
  stageDecision: z.enum(['same', 'different', 'unknown']).optional(),
  method: id,
  coverage: z.enum(['selected', 'fallback']),
  reasons: z.array(id).min(1).max(32),
  featureRefs: z.array(id).max(64).refine(uniqueIds, 'DUPLICATE_FEATURE_REF'),
  evidenceRefs: z.array(id).min(1).max(64).refine(uniqueIds, 'DUPLICATE_EVIDENCE_REF'),
  createdAt: dateTime
}).strict().refine(value => value.fromContentId !== value.toContentId, 'SELF_RETRIEVAL_CANDIDATE');

export const FamilyReferenceSchema = z.object({
  ...versionFields,
  referenceId: id,
  scope: ScopeSchema,
  kind: z.enum(['person', 'event', 'place', 'vocabulary', 'relation_correction']),
  canonicalId: id,
  labelState: z.enum(['unnamed', 'user_confirmed']),
  displayLabel: z.string().min(1).max(128).optional(),
  maturity: z.enum(['provisional', 'stable']),
  sourceContentIds: z.array(id).min(1).max(100).refine(uniqueIds, 'DUPLICATE_SOURCE_CONTENT'),
  evidenceRefs: z.array(id).min(1).max(100).refine(uniqueIds, 'DUPLICATE_EVIDENCE_REF'),
  featureRefs: z.array(id).max(100).refine(uniqueIds, 'DUPLICATE_FEATURE_REF'),
  confirmedBy: id,
  confirmedAt: dateTime,
  authorizationRevision: id,
  biometricConsentRef: id.optional(),
  revision: z.number().int().positive(),
  lifecycleState: z.enum(['active', 'withdrawn'])
}).strict().superRefine((value, ctx) => {
  if(value.labelState === 'user_confirmed' && !value.displayLabel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CONFIRMED_LABEL_REQUIRED' });
  }
  if(value.labelState === 'unnamed' && value.displayLabel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'UNNAMED_REFERENCE_HAS_LABEL' });
  }
  if(value.kind === 'person') {
    if(!value.biometricConsentRef) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BIOMETRIC_CONSENT_REQUIRED' });
    if(value.maturity === 'stable' && value.sourceContentIds.length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'STABLE_PERSON_REFERENCE_REQUIRES_DIVERSE_SOURCES' });
    }
  } else if(value.biometricConsentRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BIOMETRIC_CONSENT_NOT_APPLICABLE' });
  }
});

export const DecisionPolicySchema = z.object({
  ...versionFields,
  policyVersion: id,
  mode: z.enum(['shadow', 'active']),
  decisionMode: z.enum(['evidence_rules', 'calibrated_probability']),
  calibrated: z.boolean(),
  calibrationVersion: id.optional(),
  autoLinkMin: z.number().min(0).max(1).optional(),
  autoSeparateMax: z.number().min(0).max(1).optional(),
  maxCandidatesPerContent: z.number().int().min(1).max(128),
  riskPolicyVersion: id,
  createdAt: dateTime
}).strict().superRefine((value, ctx) => {
  if(value.decisionMode === 'calibrated_probability') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CALIBRATED_PROBABILITY_NOT_IMPLEMENTED' });
  }
  if(value.mode === 'active' && value.decisionMode === 'calibrated_probability'
    && (!value.calibrated || !value.calibrationVersion || value.autoLinkMin === undefined || value.autoSeparateMax === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ACTIVE_POLICY_REQUIRES_CALIBRATION' });
  }
  if(value.calibrated && !value.calibrationVersion) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CALIBRATION_VERSION_REQUIRED' });
  }
  if(value.autoLinkMin !== undefined && value.autoSeparateMax !== undefined && value.autoSeparateMax >= value.autoLinkMin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_DECISION_THRESHOLDS' });
  }
  if(value.decisionMode === 'evidence_rules'
    && (value.autoLinkMin !== undefined || value.autoSeparateMax !== undefined || value.calibrated)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'EVIDENCE_RULES_CANNOT_USE_NUMERIC_THRESHOLDS' });
  }
});

export const DecisionPolicyResultSchema = z.object({
  ...versionFields,
  resultId: id,
  candidateId: id,
  policyVersion: id,
  decisionMode: z.enum(['evidence_rules', 'calibrated_probability']),
  basis: z.enum(['stage_relation', 'retrieval_only', 'conflict_guard', 'person_reference', 'calibrated_probability']),
  evidenceStrength: z.enum(['supported', 'conflicted', 'insufficient']),
  groupImpact: z.enum(['singleton_pair', 'extend_story', 'bridge_existing_groups', 'not_applicable']),
  calibrationVersion: id.optional(),
  action: z.enum(['auto_link_candidate', 'auto_separate', 'keep_separate', 'review']),
  riskLevel: z.enum(['low', 'medium', 'high']),
  shadow: z.boolean(),
  inDistribution: z.boolean(),
  userActionRequired: z.boolean(),
  pSameCalibrated: z.number().min(0).max(1).optional(),
  reasons: z.array(id).min(1).max(32),
  createdAt: dateTime
}).strict().superRefine((value, ctx) => {
  if(value.decisionMode === 'calibrated_probability') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CALIBRATED_PROBABILITY_NOT_IMPLEMENTED' });
  }
  if(value.decisionMode === 'calibrated_probability'
    && (value.pSameCalibrated === undefined || !value.calibrationVersion)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CALIBRATED_RESULT_REQUIRES_PROBABILITY' });
  }
  if(value.pSameCalibrated !== undefined && !value.calibrationVersion) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CALIBRATION_VERSION_REQUIRED' });
  }
  if(value.decisionMode === 'evidence_rules'
    && (value.pSameCalibrated !== undefined || value.calibrationVersion !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'EVIDENCE_RULE_RESULT_HAS_PROBABILITY' });
  }
  if(value.userActionRequired && (value.action !== 'review' || value.shadow)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_USER_ACTION_REQUIREMENT' });
  }
  if(!value.shadow && value.action === 'review' && !value.userActionRequired) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ACTIVE_REVIEW_REQUIRES_USER_ACTION' });
  }
});

export type AssetFeature = z.infer<typeof AssetFeatureSchema>;
export type RetrievalCandidate = z.infer<typeof RetrievalCandidateSchema>;
export type FamilyReference = z.infer<typeof FamilyReferenceSchema>;
export type DecisionPolicy = z.infer<typeof DecisionPolicySchema>;
export type DecisionPolicyResult = z.infer<typeof DecisionPolicyResultSchema>;
