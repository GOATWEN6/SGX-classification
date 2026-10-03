import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const base = `${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification`;
const {
  CrossRoundAssociationCandidateSchema,
  buildCrossRoundAssociations,
} = require(`${base}/cross-round-association.js`);

const scope = { householdId: 'house_cross_round', subjectId: 'elder_cross_round' };
const createdAt = '2026-10-03T08:00:00.000Z';
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const contents = [{
  contentId: 'content_current',
  scope,
  modality: 'photo',
  evidenceIds: ['evidence_current'],
  lifecycle: 'active',
}];

function candidate(kind, suffix) {
  const face = kind === 'face_embedding';
  return {
    candidateId: `historical_candidate_${suffix}`,
    sourceContentId: 'content_current',
    sourceEvidenceId: 'evidence_current',
    ...(face ? { sourceFaceId: `face_${'a'.repeat(32)}` } : {}),
    historicalContentId: `content_history_${suffix}`,
    historicalEvidenceId: `evidence_history_${suffix}`,
    kind,
    rank: 1,
    modelId: face ? 'buffalo_l' : 'bge_visualized_m3',
    modelRevision: 'frozen_revision_1',
    reasons: face
      ? ['historical_projection_authorized', 'anonymous_person_candidate']
      : ['historical_projection_authorized', 'semantic_neighbor'],
    featureRefs: [`feature_${suffix}`],
    evidenceRefs: ['evidence_current', `evidence_history_${suffix}`],
    historicalProjection: {
      contentId: `content_history_${suffix}`,
      evidenceId: `evidence_history_${suffix}`,
      evidenceRevision: 1,
      sourceHash: sha(`history-${suffix}`),
      artifactId: `artifact_${suffix}`,
      mimeType: 'image/jpeg',
      byteLength: 2048,
      consentRef: `consent_${suffix}`,
      ...(face ? {
        personConsentRef: `person_consent_${suffix}`,
        faceId: `face_${'b'.repeat(32)}`,
      } : {}),
      confirmedReferenceIds: [],
      lifecycleState: 'active',
    },
  };
}

test('historical Top-K becomes low-impact candidate links without hard scores or fact promotion', () => {
  const result = buildCrossRoundAssociations({
    scope,
    authorizationRevision: 'authorization_cross_round_1',
    contents,
    candidates: [candidate('image_text_embedding', 'semantic'), candidate('face_embedding', 'person')],
    createdAt,
  });
  assert.equal(result.length, 2);
  const semantic = result.find(value => value.method === 'image_text_embedding_topk');
  const person = result.find(value => value.method === 'authorized_face_embedding_topk');
  assert.equal(semantic.relation, 'possibly_related');
  assert.equal(semantic.status, 'candidate_only');
  assert.equal(semantic.decisionBasis, 'retrieval_only');
  assert.equal(semantic.personBasis, 'not_applicable');
  assert.equal(person.personBasis, 'consent_gated_anonymous_candidate');
  assert.deepEqual(person.allowedUses, ['album_suggestion', 'search_candidate']);
  for(const value of result) {
    assert.equal('score' in value, false);
    assert.equal('confidence' in value, false);
    assert.equal('identity' in value, false);
    assert.equal('relationship' in value, false);
  }
  assert.throws(() => CrossRoundAssociationCandidateSchema.parse({ ...semantic, score: 0.95 }));
});

test('cross-round mapper rejects a candidate whose current source is not in this batch', () => {
  const invalid = candidate('image_text_embedding', 'invalid');
  invalid.sourceContentId = 'content_foreign';
  assert.throws(() => buildCrossRoundAssociations({
    scope,
    authorizationRevision: 'authorization_cross_round_1',
    contents,
    candidates: [invalid],
    createdAt,
  }), /INVALID_HISTORICAL_CANDIDATE_SOURCE/);
});
