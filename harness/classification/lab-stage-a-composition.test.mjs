import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const contract = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/stage-a-contract.js`);
const {
  buildStageALabPlan,
  composeStageALabResult,
  computePlaceKindPolicyDigest
} = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/lab-stage-a-composition.js`);
const {
  organizeSparseContent,
  validateOrganizationInput
} = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/content-organization.js`);
const {
  ACTIVE_EVIDENCE_RULE_POLICY_VERSION,
  buildActiveEvidenceRulePolicy,
  collectEvidenceRuleReviewItems
} = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/evidence-rule-policy.js`);

const scope = { householdId: 'house_lab', subjectId: 'elder_lab' };
const createdAt = '2026-09-29T09:00:00.000Z';
const deadlineAt = '2026-09-30T09:00:00.000Z';
const hashBytes = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const clone = value => structuredClone(value);

function imageEvidence(id, bytes, extra = {}) {
  return {
    evidenceId: id, subjectId: scope.subjectId, householdId: scope.householdId, schemaVersion: '1.0',
    ownerId: scope.subjectId, contributorId: 'daughter_lab', consentRef: 'consent_lab', visibility: 'household',
    ingestedAt: createdAt, lifecycleState: 'active', sourceRef: { kind: 'object', id: `object_${id}` },
    sourceHash: hashBytes(bytes), revision: 1, byteLength: bytes.byteLength, modality: 'image', mimeType: 'image/jpeg',
    dimensions: { width: 640, height: 480 }, ...extra
  };
}

function textEvidence(id, text, modality = 'text') {
  return {
    evidenceId: id, subjectId: scope.subjectId, householdId: scope.householdId, schemaVersion: '1.0',
    ownerId: scope.subjectId, contributorId: 'daughter_lab', consentRef: 'consent_lab', visibility: 'household',
    ingestedAt: createdAt, lifecycleState: 'active', sourceRef: { kind: modality === 'text' ? 'message' : 'object', id: `source_${id}` },
    sourceHash: hashBytes(Buffer.from(text, 'utf8')), revision: 1, byteLength: Buffer.byteLength(text, 'utf8'),
    modality, mimeType: 'text/plain', ...(modality === 'transcript' ? { asr: { final: true, producerVersion: 'asr-test.1' } } : {})
  };
}

function content(id, evidenceId, modality) {
  return { contentId: id, evidenceId, modality, lifecycleState: 'active' };
}

function binding(id, sourceContentId, target, authority = 'user_explicit') {
  return {
    bindingId: id, sourceContentId, target, authority, state: 'active', method: authority === 'user_explicit' ? 'user-selection.1' : 'ai-binding.1',
    evidenceRefs: [], createdAt
  };
}

function envelopeOf({ images = [], texts = [], bindings = [], context = 'album_upload' }) {
  const evidence = [...images.map(item => item.record), ...texts.map(item => item.record)];
  const contents = [
    ...images.map((item, index) => content(`content_image_${index + 1}`, item.record.evidenceId, 'image')),
    ...texts.map((item, index) => content(`content_text_${index + 1}`, item.record.evidenceId, item.record.modality === 'transcript' ? 'final_asr' : 'user_text'))
  ];
  const contentById = new Map(contents.map(item => [item.contentId, item]));
  const completedBindings = bindings.map(item => {
    const source = contentById.get(item.sourceContentId);
    const targetRefs = item.target.kind === 'contents' ? item.target.contentIds.map(id => contentById.get(id).evidenceId) : [];
    return { ...item, evidenceRefs: [source.evidenceId, ...targetRefs] };
  });
  return {
    specVersion: '2.0.0', contractVersion: 'classification-ingestion.2', ingestionId: 'ingestion_lab', batchId: 'batch_lab',
    scope, actorId: 'daughter_lab', context: context === 'family_transfer'
      ? { kind: 'family_transfer', senderId: 'daughter_lab', recipientIds: [scope.subjectId] }
      : { kind: 'album_upload' },
    authorizationRevision: 'auth_lab_1', taxonomyVersion: 'taxonomy.lab.1',
    purposes: ['classification', 'album_organization', 'search_candidate'], evidence, contents, bindings: completedBindings,
    ...(context === 'family_transfer' ? { reviewPolicy: { policyVersion: 'family-inbox.1', remindAfterDays: 3, hideFromHomeAfterDays: 7, highRiskRetention: 'until_resolved' } } : {}),
    createdAt
  };
}

function planInput(envelope, assets, texts, overrides = {}) {
  const policyBase = { policyVersion: 'place-kind.lab.1', taxonomyVersion: envelope.taxonomyVersion, genericLabels: ['家中', '室内'] };
  const placeKindPolicy = { ...policyBase, policyDigest: computePlaceKindPolicyDigest(policyBase) };
  const { authorization: authorizationOverride = {}, ...remainingOverrides } = overrides;
  return {
    envelope,
    payloads: { textByEvidenceId: Object.fromEntries(texts.map(item => [item.record.evidenceId, item.text])) },
    imageBytesByEvidenceId: Object.fromEntries(assets.map(item => [item.record.evidenceId, item.bytes])),
    authorization: {
      actorId: envelope.actorId, authorityRef: 'grant_lab_1', scope, authorizationRevision: envelope.authorizationRevision,
      contextRevision: 'context_lab_1', active: true, allowedEvidenceIds: envelope.evidence.map(item => item.evidenceId),
      allowedConsentRefs: ['consent_lab'], allowedCorrectionIds: (overrides.corrections ?? []).map(item => item.correctionId),
      allowPersonMatching: false, ...authorizationOverride
    },
    placeKindPolicy, runId: 'run_lab_1', trigger: 'upload',
    budget: { maxRequests: 10, maxInputTokens: 100000, maxOutputTokens: 10000, maxCostCny: 5, deadlineAt, candidatesPerPhoto: 4, maxOutputPerRequest: 4096, maxCallDurationMs: 60000 },
    createdAt,
    ...remainingOverrides
  };
}

function baseFixture() {
  const image = { record: imageEvidence('evidence_image_1', Buffer.from('image-one')), bytes: Buffer.from('image-one') };
  const noteText = '1982年6月1日，八十年代小时候在武汉家庭聚会';
  const note = { record: textEvidence('evidence_note_1', noteText), text: noteText };
  const asr = { record: textEvidence('evidence_asr_1', '我记得那是家里的聚会', 'transcript'), text: '我记得那是家里的聚会' };
  const bindings = [
    binding('binding_note_1', 'content_text_1', { kind: 'contents', contentIds: ['content_image_1'] }),
    binding('binding_asr_1', 'content_text_2', { kind: 'contents', contentIds: ['content_image_1'] })
  ];
  const envelope = envelopeOf({ images: [image], texts: [note, asr], bindings });
  return { image, note, asr, envelope, input: planInput(envelope, [image], [note, asr]) };
}

function stageObservation(photoId, overrides = {}) {
  const visual = { photoId, source: 'visual', quote: '照片中可见多人围坐' };
  return {
    photoId, people: [], mentions: [],
    times: [{ value: '1982', precision: 'year', role: 'event', supports: [{ photoId, source: 'user_text', evidenceId: 'evidence_note_1', quote: '1982年' }] }],
    places: [{ label: '武汉', canonical: '武汉市', supports: [{ photoId, source: 'user_text', evidenceId: 'evidence_note_1', quote: '武汉' }] }],
    events: [{ type: '家庭聚会', supports: [visual, { ...visual }, { photoId, source: 'user_text', evidenceId: 'evidence_note_1', quote: '家庭聚会' }, { photoId, source: 'final_asr', evidenceId: 'evidence_asr_1', quote: '家里的聚会' }] }],
    scenes: [{ label: '室内家庭', supports: [visual] }], unknownFacets: ['person'], conflicts: [], ...overrides
  };
}

function stageResult(plan, observations, { edges = [], groups = [], workflowStatus = 'succeeded', reviewItems = [] } = {}) {
  const request = plan.stageA.request;
  const providerVersion = 'fixture-model.1';
  const cached = Object.fromEntries(observations.map(value => {
    const photo = request.photos.find(item => item.photoId === value.photoId);
    return [value.photoId, { inputHash: contract.photoHash(photo), version: providerVersion, value }];
  }));
  return {
    contractVersion: 'classification-stage-a.1', providerVersion, runId: request.runId, scope: request.scope,
    workflowStatus, evidenceStatus: 'mock_transport', semanticValidation: 'not_evaluated',
    snapshot: {
      scope: request.scope, revision: 1, version: providerVersion, authorizationRevision: request.authorizationRevision,
      contextHash: contract.digest([request.photos, request.references, request.corrections, contract.digest(plan.stageA.authorization), providerVersion]), observations: cached, edges, groups,
      referencesHash: contract.digest(request.references), correctionsHash: contract.digest(request.corrections), reviewItems, candidateTraces: [], pendingPhotoIds: [], workflowStatus
    },
    changedPhotoIds: observations.map(item => item.photoId), invalidatedPhotoIds: [], retiredGroupIds: [], candidateTraces: [], reviewItems, errors: [],
    usage: { requests: 0, images: 0, inputTokens: 0, outputTokens: 0, costCny: 0, latencyMs: 0, records: [] }
  };
}

test('builds a deterministic batch-isolated plan and preserves three ID namespaces without mutating input', () => {
  const { input } = baseFixture();
  const beforeEnvelope = clone(input.envelope);
  const beforeBytes = Buffer.from(input.imageBytesByEvidenceId.evidence_image_1);
  const first = buildStageALabPlan(input);
  const second = buildStageALabPlan(input);
  assert.equal(first.audit.inputDigest, second.audit.inputDigest);
  assert.deepEqual(first.routes, second.routes);
  assert.deepEqual(first.routes.images, [{ contentId: 'content_image_1', evidenceId: 'evidence_image_1', stagePhotoId: 'evidence_image_1' }]);
  assert.deepEqual(first.routes.texts.map(route => route.bindingId), ['binding_note_1', 'binding_asr_1']);
  assert.equal(first.stageA.request.photos[0].photoId, 'evidence_image_1');
  assert.deepEqual(first.stageA.request.photos[0].textEvidence.map(item => item.evidenceId), ['evidence_note_1', 'evidence_asr_1']);
  assert.deepEqual(input.envelope, beforeEnvelope);
  assert.deepEqual(Buffer.from(input.imageBytesByEvidenceId.evidence_image_1), beforeBytes);
  assert.deepEqual({ externalCalls: first.audit.externalCalls, credentialsRead: first.audit.credentialsRead, costCny: first.audit.costCny }, { externalCalls: 0, credentialsRead: false, costCny: 0 });

  const normalizedLeft = buildStageALabPlan({ ...input, authorization: { ...input.authorization, allowedCorrectionIds: ['correction_b', 'correction_a', 'correction_a'] } });
  const normalizedRight = buildStageALabPlan({ ...input, authorization: { ...input.authorization, allowedCorrectionIds: ['correction_a', 'correction_b'] } });
  assert.equal(normalizedLeft.audit.authorizationDigest, normalizedRight.audit.authorizationDigest);
  assert.equal(normalizedLeft.audit.inputDigest, normalizedRight.audit.inputDigest);
});

test('person matching is opt-in and requires a person consent reference for every routed image', () => {
  const image1 = { record: imageEvidence('image_person_1', Buffer.from('person-one')), bytes: Buffer.from('person-one') };
  const image2 = { record: imageEvidence('image_person_2', Buffer.from('person-two')), bytes: Buffer.from('person-two') };
  const envelope = envelopeOf({ images: [image1, image2] });
  const authorized = {
    allowPersonMatching: true,
    personMatchingEvidenceIds: ['image_person_1', 'image_person_2'],
    personConsentRefsByEvidenceId: {
      image_person_1: 'person_consent_1',
      image_person_2: 'person_consent_2'
    }
  };
  const plan = buildStageALabPlan(planInput(envelope, [image1, image2], [], { authorization: authorized }));
  assert.equal(plan.stageA.authorization.allowPersonMatching, true);
  assert.deepEqual(plan.stageA.request.references, []);
  assert.deepEqual(plan.stageA.request.corrections, []);

  assert.throws(() => buildStageALabPlan(planInput(envelope, [image1, image2], [], {
    authorization: {
      ...authorized,
      personConsentRefsByEvidenceId: { image_person_1: 'person_consent_1' }
    }
  })), /PERSON_CONSENT_MISSING/);
  assert.throws(() => buildStageALabPlan(planInput(envelope, [image1, image2], [], {
    authorization: { ...authorized, allowPersonMatching: false }
  })), /PERSON_MATCHING_NOT_AUTHORIZED/);
});

test('confirmed person references and corrections require matching consent and remain trusted inputs', () => {
  const image1 = { record: imageEvidence('image_reference_1', Buffer.from('reference-one')), bytes: Buffer.from('reference-one') };
  const image2 = { record: imageEvidence('image_reference_2', Buffer.from('reference-two')), bytes: Buffer.from('reference-two') };
  const envelope = envelopeOf({ images: [image1, image2] });
  const authorization = {
    allowPersonMatching: true,
    personMatchingEvidenceIds: ['image_reference_1', 'image_reference_2'],
    personConsentRefsByEvidenceId: {
      image_reference_1: 'person_consent_reference_1',
      image_reference_2: 'person_consent_reference_2'
    }
  };
  const base = buildStageALabPlan(planInput(envelope, [image1, image2], [], { authorization }));
  const [left, right] = base.stageA.request.photos;
  const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.3 };
  const reference = {
    personId: 'confirmed_person_1', displayName: '用户确认人物', revision: 1,
    endpoint: { photoId: left.photoId, faceId: 'face_reference_1' }, faceBox: box,
    photoHash: contract.photoHash(left), confirmed: true
  };
  const correction = {
    correctionId: 'person_correction_1', revision: 1, authorityRef: 'grant_lab_1', kind: 'person', decision: 'same',
    left: { photoId: left.photoId, faceId: 'face_reference_1' },
    right: { photoId: right.photoId, faceId: 'face_reference_2' },
    leftPhotoHash: left.sourceHash, rightPhotoHash: right.sourceHash,
    leftFaceBox: box, rightFaceBox: box, active: true
  };
  const plan = buildStageALabPlan(planInput(envelope, [image1, image2], [], {
    authorization,
    references: [reference],
    corrections: [correction]
  }));
  assert.equal(plan.stageA.request.references[0].displayName, '用户确认人物');
  assert.equal(plan.stageA.request.references[0].confirmed, true);
  assert.equal(plan.stageA.request.corrections[0].authorityRef, 'grant_lab_1');
});

test('composes stage observations onto product content IDs with source types, temporal qualifier and multiple supports', () => {
  const { input } = baseFixture();
  const plan = buildStageALabPlan(input);
  const photoId = plan.stageA.request.photos[0].photoId;
  const result = stageResult(plan, [stageObservation(photoId)]);
  const output = composeStageALabResult({ plan, stageResult: result, createdAt });
  assert.deepEqual(output, composeStageALabResult({ plan, stageResult: result, createdAt }));
  const image = output.contents.find(item => item.contentId === 'content_image_1');
  assert.deepEqual(new Set(image.evidenceIds), new Set(['evidence_image_1', 'evidence_note_1', 'evidence_asr_1']));
  assert.equal(output.contents.find(item => item.contentId === 'content_text_1').originalText, '1982年6月1日，八十年代小时候在武汉家庭聚会');
  const event = output.observations.find(item => item.facet === 'event');
  assert.equal(event.contentId, 'content_image_1');
  assert.deepEqual(event.supports.map(item => item.sourceType), ['final_asr', 'visual', 'user_text']);
  assert.equal(event.supports.length, 3);
  assert.deepEqual(new Set(event.supports.map(item => item.evidenceId)), new Set(['evidence_image_1', 'evidence_note_1', 'evidence_asr_1']));
  assert.deepEqual(output.observations.find(item => item.facet === 'time').temporal, { role: 'event', precision: 'year' });
  assert.equal(output.observations.find(item => item.facet === 'place').placeKind, 'named');
  assert.deepEqual(output.audit.sourceStagePhotoIds, ['evidence_image_1']);
});

test('keeps multi-image, batch and AI-candidate text out of per-photo Stage A context', () => {
  const image1 = { record: imageEvidence('image_1', Buffer.from('image-1')), bytes: Buffer.from('image-1') };
  const image2 = { record: imageEvidence('image_2', Buffer.from('image-2')), bytes: Buffer.from('image-2') };
  const batch = { record: textEvidence('text_batch', '这一批是家里的旧照片'), text: '这一批是家里的旧照片' };
  const multi = { record: textEvidence('text_multi', '这两张是同一次聚会'), text: '这两张是同一次聚会' };
  const candidate = { record: textEvidence('text_candidate', '可能和第一张有关'), text: '可能和第一张有关' };
  const bindings = [
    binding('binding_batch', 'content_text_1', { kind: 'batch' }),
    binding('binding_multi', 'content_text_2', { kind: 'contents', contentIds: ['content_image_1', 'content_image_2'] }),
    binding('binding_candidate_base', 'content_text_3', { kind: 'batch' }),
    binding('binding_candidate', 'content_text_3', { kind: 'contents', contentIds: ['content_image_1'] }, 'ai_candidate')
  ];
  const envelope = envelopeOf({ images: [image1, image2], texts: [batch, multi, candidate], bindings });
  const plan = buildStageALabPlan(planInput(envelope, [image1, image2], [batch, multi, candidate]));
  assert.deepEqual(new Set(plan.routes.texts.map(route => route.disposition)), new Set(['preserved_batch', 'deferred_multi_image', 'ai_candidate_only']));
  assert.ok(plan.stageA.request.photos.every(photo => (photo.textEvidence ?? []).length === 0));
  assert.equal(plan.baseOrganization.batchBindings.length, 2);
  assert.equal(plan.baseOrganization.retrievalCandidates.length, 1);
});

test('text-only input skips Stage A but still composes supplied text observations', () => {
  const note = { record: textEvidence('text_only', '1985年在北京毕业'), text: '1985年在北京毕业' };
  const envelope = envelopeOf({ texts: [note], bindings: [binding('binding_text_only', 'content_text_1', { kind: 'batch' })] });
  const plan = buildStageALabPlan(planInput(envelope, [], [note]));
  assert.equal(plan.stageA, undefined);
  assert.equal(plan.audit.skippedReason, 'no_active_images');
  const textObservation = { contentId: 'content_text_1', evidenceId: 'text_only', facet: 'time', rawValue: '1985', normalizedValue: '1985', supports: [{ evidenceId: 'text_only', sourceType: 'user_text', quote: '1985年' }], state: 'candidate' };
  const output = composeStageALabResult({ plan, textObservations: [textObservation], createdAt });
  assert.equal(output.observations.length, 1);
  assert.equal(output.audit.stageAExecuted, false);
  assert.throws(() => composeStageALabResult({ plan, stageResult: { workflowStatus: 'succeeded' }, createdAt }), /STAGE_A_RESULT_MISMATCH/);
});

test('fails closed for authorization drift, person matching, missing/foreign/tampered assets and policy drift', () => {
  const { input } = baseFixture();
  assert.throws(() => buildStageALabPlan({ ...input, authorization: { ...input.authorization, active: false } }), /INACTIVE_AUTHORIZATION/);
  assert.throws(() => buildStageALabPlan({ ...input, authorization: { ...input.authorization, authorizationRevision: 'auth_old' } }), /AUTHORIZATION_CHANGED/);
  assert.throws(() => buildStageALabPlan({ ...input, authorization: { ...input.authorization, allowPersonMatching: true } }), /PERSON_CONSENT_MISSING/);
  assert.throws(() => buildStageALabPlan({ ...input, imageBytesByEvidenceId: {} }), /MISSING_IMAGE_ASSET/);
  assert.throws(() => buildStageALabPlan({ ...input, imageBytesByEvidenceId: { ...input.imageBytesByEvidenceId, foreign_image: Buffer.from('x') } }), /FOREIGN_IMAGE_ASSET/);
  assert.throws(() => buildStageALabPlan({ ...input, imageBytesByEvidenceId: { evidence_image_1: Buffer.from('tampered') } }), /SOURCE_LENGTH_MISMATCH|SOURCE_HASH_MISMATCH/);
  assert.throws(() => buildStageALabPlan({ ...input, placeKindPolicy: { ...input.placeKindPolicy, taxonomyVersion: 'taxonomy.other' } }), /PLACE_KIND_POLICY_MISMATCH/);
  assert.throws(() => buildStageALabPlan({ ...input, placeKindPolicy: { ...input.placeKindPolicy, policyDigest: `sha256:${'0'.repeat(64)}` } }), /PLACE_KIND_POLICY_DIGEST_MISMATCH/);
});

test('rejects partial ASR and tampered text before a Stage A plan exists', () => {
  const { input } = baseFixture();
  const partial = clone(input);
  partial.envelope.evidence.find(item => item.evidenceId === 'evidence_asr_1').asr.final = false;
  assert.throws(() => buildStageALabPlan(partial), /PARTIAL_ASR_NOT_ALLOWED/);
  assert.throws(() => buildStageALabPlan({ ...input, payloads: { textByEvidenceId: { ...input.payloads.textByEvidenceId, evidence_note_1: '篡改' } } }), /SOURCE_LENGTH_MISMATCH|SOURCE_HASH_MISMATCH/);
});

test('quarantines untrusted capture time while preserving supported scan and upload timeline roles', () => {
  const { input } = baseFixture();
  const image = input.envelope.evidence.find(item => item.modality === 'image' && item.lifecycleState === 'active');
  input.derivedOcrTextByEvidenceId = {
    [image.evidenceId]: { sourceHash: image.sourceHash, text: '照片边缘印有1982-06-01' }
  };
  const plan = buildStageALabPlan(input);
  const photoId = plan.stageA.request.photos[0].photoId;
  const observation = stageObservation(photoId, {
    times: [
      { value: '1982-06-01', precision: 'date', role: 'capture', supports: [{ photoId, source: 'ocr', quote: '照片边缘印有1982-06-01' }] },
      { value: '1982', precision: 'year', role: 'capture', supports: [{ photoId, source: 'user_text', evidenceId: 'evidence_note_1', quote: '1982年' }] },
      { value: '1982-06-01', precision: 'date', role: 'scan', supports: [{ photoId, source: 'user_text', evidenceId: 'evidence_note_1', quote: '1982年6月1日' }] },
      { value: '1980s', precision: 'decade', role: 'upload', supports: [{ photoId, source: 'user_text', evidenceId: 'evidence_note_1', quote: '八十年代' }] }
    ]
  });
  const output = composeStageALabResult({ plan, stageResult: stageResult(plan, [observation]), createdAt });
  assert.deepEqual(output.observations.filter(item => item.facet === 'time').map(item => item.temporal.role).sort(), ['scan', 'upload']);
  assert.equal(output.unresolvedTemporalObservations.length, 2);
  const ocrCapture = output.unresolvedTemporalObservations.find(item => item.evidenceKinds.includes('ocr_candidate'));
  assert.equal(ocrCapture.e2RuntimeObservation.kind, 'visible_time_text');
  assert.equal(ocrCapture.e2RuntimeObservation.precision, 'exact_day');
  assert.equal(output.unresolvedTemporalObservations.find(item => item.rawValue === '1982').e2RuntimeObservation, undefined);
  assert.ok(!output.unresolvedTemporalObservations.some(item => item.reason === 'role_missing'));
  assert.equal(output.reviewItems.filter(item => item.startsWith('ROLE_UNKNOWN_TIME:')).length, 0);
  assert.equal(output.unresolvedTemporalObservations.length, 2);
});

test('preserves every supported event-time precision', () => {
  const { input } = baseFixture();
  const plan = buildStageALabPlan(input);
  const photoId = plan.stageA.request.photos[0].photoId;
  const support = value => [{ photoId, source: 'user_text', evidenceId: 'evidence_note_1', quote: value }];
  const observation = stageObservation(photoId, { times: [
    { value: '1982-06-01', precision: 'date', role: 'event', supports: support('1982年6月1日') },
    { value: '1982', precision: 'year', role: 'event', supports: support('1982年') },
    { value: '1980s', precision: 'decade', role: 'event', supports: support('八十年代') },
    { value: '小时候', precision: 'relative', role: 'event', supports: support('小时候') }
  ] });
  const output = composeStageALabResult({ plan, stageResult: stageResult(plan, [observation]), createdAt });
  assert.deepEqual(new Set(output.observations.filter(item => item.facet === 'time').map(item => item.temporal.precision)), new Set(['date', 'year', 'decade', 'relative']));
  assert.ok(output.observations.filter(item => item.facet === 'time').every(item => item.temporal.role === 'event'));
});

test('allows capture time only when caller explicitly marks original EXIF as trusted', () => {
  const fixture = baseFixture();
  fixture.image.record.capturedAt = '1982-06-01T00:00:00.000Z';
  fixture.envelope.evidence[0].capturedAt = fixture.image.record.capturedAt;
  const input = planInput(fixture.envelope, [fixture.image], [fixture.note, fixture.asr], { trustedOriginalCaptureEvidenceIds: ['evidence_image_1'] });
  const plan = buildStageALabPlan(input);
  const photoId = plan.stageA.request.photos[0].photoId;
  const observation = stageObservation(photoId, { times: [{ value: '1982', precision: 'year', role: 'capture', supports: [{ photoId, source: 'exif', quote: '1982-06-01T00:00:00.000Z' }] }] });
  const output = composeStageALabResult({ plan, stageResult: stageResult(plan, [observation]), createdAt });
  assert.deepEqual(output.observations.find(item => item.facet === 'time').temporal, { role: 'capture', precision: 'year' });
  assert.equal(output.unresolvedTemporalObservations.length, 0);
  assert.equal(output.contents.find(item => item.contentId === 'content_image_1').capturedAt, '1982-06-01T00:00:00.000Z');
});

test('applies versioned place-kind policy and never promotes unresolved place to a certain kind', () => {
  const { input } = baseFixture();
  const plan = buildStageALabPlan(input);
  const photoId = plan.stageA.request.photos[0].photoId;
  const supports = [{ photoId, source: 'visual', quote: '照片像在家中某个地方' }];
  const observation = stageObservation(photoId, { places: [{ label: '家中', supports }, { label: '某个地方', supports }] });
  const output = composeStageALabResult({ plan, stageResult: stageResult(plan, [observation]), createdAt });
  assert.equal(output.observations.find(item => item.facet === 'place' && item.rawValue === '家中').placeKind, 'generic');
  assert.equal(output.observations.find(item => item.facet === 'place' && item.rawValue === '某个地方').placeKind, 'unresolved');
  assert.ok(!output.reviewItems.some(item => item.startsWith('PLACE_KIND_UNRESOLVED:')));
});

test('remaps Stage A edge and group endpoints while preserving user correction authority', () => {
  const image1 = { record: imageEvidence('image_edge_1', Buffer.from('edge-one')), bytes: Buffer.from('edge-one') };
  const image2 = { record: imageEvidence('image_edge_2', Buffer.from('edge-two')), bytes: Buffer.from('edge-two') };
  const envelope = envelopeOf({ images: [image1, image2] });
  const correction = {
    correctionId: 'correction_1', revision: 1, authorityRef: 'grant_lab_1', kind: 'event', decision: 'same',
    left: { photoId: 'content_image_1' }, right: { photoId: 'content_image_2' },
    leftPhotoHash: image1.record.sourceHash, rightPhotoHash: image2.record.sourceHash, active: true
  };
  const plan = buildStageALabPlan(planInput(envelope, [image1, image2], [], { corrections: [correction] }));
  const [left, right] = plan.stageA.request.photos;
  const observations = [stageObservation(left.photoId, { mentions: [], times: [], places: [], events: [], unknownFacets: ['person', 'time', 'place', 'event'] }), stageObservation(right.photoId, { mentions: [], times: [], places: [], events: [], unknownFacets: ['person', 'time', 'place', 'event'] })];
  const deps = Object.fromEntries(plan.stageA.request.photos.map(photo => [photo.photoId, contract.photoHash(photo)]));
  const edge = { kind: 'event', left: { photoId: left.photoId }, right: { photoId: right.photoId }, decision: 'same', supports: [], rationale: 'correction_1', deps, origin: 'user' };
  const groups = [{ groupId: 'event_group_1', kind: 'event', members: [{ photoId: left.photoId }, { photoId: right.photoId }], revision: 1, state: 'ai_organized', usableForOrganization: true, supersedes: [] }];
  const output = composeStageALabResult({ plan, stageResult: stageResult(plan, observations, { edges: [edge], groups }), createdAt });
  assert.equal(output.explicitAssociations.length, 1);
  assert.deepEqual([output.explicitAssociations[0].fromContentId, output.explicitAssociations[0].toContentId], ['content_image_1', 'content_image_2']);
  assert.equal(output.explicitAssociations[0].source, 'user_explicit');
  assert.equal(output.explicitAssociations[0].status, 'user_confirmed');
  assert.equal(output.retrievalCandidates.some(item => item.fromContentId.startsWith('image_edge_')), false);
});

test('accepts only trusted, uniquely identified corrections from the authorization allowlist', () => {
  const image1 = { record: imageEvidence('image_correction_1', Buffer.from('correction-one')), bytes: Buffer.from('correction-one') };
  const image2 = { record: imageEvidence('image_correction_2', Buffer.from('correction-two')), bytes: Buffer.from('correction-two') };
  const envelope = envelopeOf({ images: [image1, image2] });
  const correction = {
    correctionId: 'correction_trusted', revision: 1, authorityRef: 'grant_lab_1', kind: 'event', decision: 'same',
    left: { photoId: 'content_image_1' }, right: { photoId: 'content_image_2' },
    leftPhotoHash: image1.record.sourceHash, rightPhotoHash: image2.record.sourceHash, active: true
  };
  assert.doesNotThrow(() => buildStageALabPlan(planInput(envelope, [image1, image2], [], { corrections: [correction] })));
  assert.throws(() => buildStageALabPlan(planInput(envelope, [image1, image2], [], {
    corrections: [{ ...correction, authorityRef: 'forged_grant' }]
  })), /NOT_AUTHORIZED/);
  assert.throws(() => buildStageALabPlan(planInput(envelope, [image1, image2], [], {
    corrections: [correction], authorization: { allowedCorrectionIds: [] }
  })), /NOT_AUTHORIZED/);
  assert.throws(() => buildStageALabPlan(planInput(envelope, [image1, image2], [], {
    corrections: [correction, { ...correction }]
  })), /DUPLICATE_CORRECTION/);
});

test('remaps standalone Stage A groups into deterministic product-content candidates', () => {
  const image1 = { record: imageEvidence('image_group_1', Buffer.from('group-one')), bytes: Buffer.from('group-one') };
  const image2 = { record: imageEvidence('image_group_2', Buffer.from('group-two')), bytes: Buffer.from('group-two') };
  const plan = buildStageALabPlan(planInput(envelopeOf({ images: [image1, image2] }), [image1, image2], []));
  const [left, right] = plan.stageA.request.photos;
  const empty = photoId => stageObservation(photoId, { mentions: [], times: [], places: [], events: [], scenes: [], unknownFacets: ['person', 'time', 'place', 'event', 'scene'] });
  const groups = [{ groupId: 'event_group_only', kind: 'event', members: [{ photoId: left.photoId }, { photoId: right.photoId }], revision: 1, state: 'ai_organized', usableForOrganization: true, supersedes: [] }];
  const result = stageResult(plan, [empty(left.photoId), empty(right.photoId)], { groups });
  const first = composeStageALabResult({ plan, stageResult: result, createdAt });
  const second = composeStageALabResult({ plan, stageResult: result, createdAt });
  assert.equal(first.retrievalCandidates.length, 1);
  assert.deepEqual([first.retrievalCandidates[0].fromContentId, first.retrievalCandidates[0].toContentId], ['content_image_1', 'content_image_2']);
  assert.equal(first.retrievalCandidates[0].candidateId, second.retrievalCandidates[0].candidateId);
});

test('uses one active evidence-rule policy for live, smoke and replay semantics', () => {
  const image1 = { record: imageEvidence('image_policy_1', Buffer.from('policy-one')), bytes: Buffer.from('policy-one') };
  const image2 = { record: imageEvidence('image_policy_2', Buffer.from('policy-two')), bytes: Buffer.from('policy-two') };
  const plan = buildStageALabPlan(planInput(envelopeOf({ images: [image1, image2] }), [image1, image2], []));
  const [left, right] = plan.stageA.request.photos;
  const empty = photoId => stageObservation(photoId, {
    mentions: [], times: [], places: [], events: [], scenes: [],
    unknownFacets: ['person', 'time', 'place', 'event', 'scene']
  });
  const groups = [{
    groupId: 'event_group_policy', kind: 'event',
    members: [{ photoId: left.photoId }, { photoId: right.photoId }],
    revision: 1, state: 'ai_organized', usableForOrganization: true, supersedes: []
  }];
  const composed = composeStageALabResult({
    plan,
    stageResult: stageResult(plan, [empty(left.photoId), empty(right.photoId)], { groups }),
    createdAt
  });
  const policies = ['live', 'smoke', 'replay'].map(() => buildActiveEvidenceRulePolicy({
    maxCandidatesPerContent: 8,
    createdAt
  }));
  assert.deepEqual(policies[0], policies[1]);
  assert.deepEqual(policies[1], policies[2]);
  assert.equal(policies[0].policyVersion, ACTIVE_EVIDENCE_RULE_POLICY_VERSION);
  assert.equal(policies[0].mode, 'active');
  assert.equal(policies[0].decisionMode, 'evidence_rules');
  assert.equal('autoLinkMin' in policies[0], false);
  assert.equal('autoSeparateMax' in policies[0], false);

  const organizationInput = policy => ({
    schemaVersion: '2.0',
    contractVersion: 'classification-hybrid.2',
    scope,
    contents: composed.contents,
    observations: composed.observations,
    retrievalCandidates: composed.retrievalCandidates,
    explicitAssociations: composed.explicitAssociations,
    decisionPolicy: policy,
    createdAt
  });
  const outputs = policies.map(policy => organizeSparseContent(organizationInput(policy)));
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[1], outputs[2]);
  assert.equal(outputs[0].associations.some(item => item.status === 'ai_auto'), true);
  assert.deepEqual(
    collectEvidenceRuleReviewItems(['PROVIDER_REVIEW'], [], ['ORGANIZER_REVIEW']),
    ['ORGANIZER_REVIEW', 'PROVIDER_REVIEW']
  );
  assert.equal(collectEvidenceRuleReviewItems([], [], []).some(item => item.startsWith('UNRESOLVED_TIME:')), false);
});

test('accepts needs-review snapshots, rejects terminal results without snapshots and foreign supports', () => {
  const { input } = baseFixture();
  const plan = buildStageALabPlan(input);
  const photoId = plan.stageA.request.photos[0].photoId;
  const needsReview = stageResult(plan, [stageObservation(photoId)], { workflowStatus: 'needs_review', reviewItems: ['CONFLICT:time'] });
  assert.ok(composeStageALabResult({ plan, stageResult: needsReview, createdAt }).reviewItems.includes('CONFLICT:time'));

  const failed = stageResult(plan, [stageObservation(photoId)]);
  failed.workflowStatus = 'failed';
  delete failed.snapshot;
  assert.throws(() => composeStageALabResult({ plan, stageResult: failed, createdAt }), /STAGE_A_SNAPSHOT_REQUIRED/);

  const foreign = stageObservation(photoId);
  foreign.events[0].supports.push({ photoId: 'foreign_photo', source: 'visual', quote: 'foreign' });
  assert.throws(() => composeStageALabResult({ plan, stageResult: stageResult(plan, [foreign]), createdAt }), /FOREIGN_STAGE_A_SUPPORT/);

  const unknownGroup = stageResult(plan, [stageObservation(photoId)], { groups: [{ groupId: 'foreign_group', kind: 'event', members: [{ photoId: 'foreign_photo' }], revision: 1, state: 'ai_organized', usableForOrganization: true, supersedes: [] }] });
  assert.throws(() => composeStageALabResult({ plan, stageResult: unknownGroup, createdAt }), /STAGE_A_EDGE_FOR_INACTIVE_CONTENT/);
});

test('rejects stale or forged Stage A snapshots before composition', () => {
  const { input } = baseFixture();
  const plan = buildStageALabPlan(input);
  const photoId = plan.stageA.request.photos[0].photoId;

  const staleInput = stageResult(plan, [stageObservation(photoId)]);
  staleInput.snapshot.observations[photoId].inputHash = contract.digest('stale-photo');
  assert.throws(() => composeStageALabResult({ plan, stageResult: staleInput, createdAt }), /STAGE_A_RESULT_MISMATCH/);

  const staleVersion = stageResult(plan, [stageObservation(photoId)]);
  staleVersion.snapshot.observations[photoId].version = 'old-model.1';
  assert.throws(() => composeStageALabResult({ plan, stageResult: staleVersion, createdAt }), /STAGE_A_RESULT_MISMATCH/);

  const unsupported = stageResult(plan, [stageObservation(photoId)]);
  unsupported.snapshot.observations[photoId].value.events[0].supports = [{ photoId, source: 'user_text', evidenceId: 'evidence_note_1', quote: '原文里不存在' }];
  assert.throws(() => composeStageALabResult({ plan, stageResult: unsupported, createdAt }), /UNSUPPORTED_QUOTE/);

  const statusMismatch = stageResult(plan, [stageObservation(photoId)]);
  statusMismatch.workflowStatus = 'needs_review';
  assert.throws(() => composeStageALabResult({ plan, stageResult: statusMismatch, createdAt }), /STAGE_A_RESULT_MISMATCH/);

  const staleContext = stageResult(plan, [stageObservation(photoId)]);
  staleContext.snapshot.contextHash = contract.digest('forged-context');
  assert.throws(() => composeStageALabResult({ plan, stageResult: staleContext, createdAt }), /STAGE_A_RESULT_MISMATCH/);
});

test('never upgrades a self-declared user edge without a matching active correction', () => {
  const image1 = { record: imageEvidence('image_forged_1', Buffer.from('forged-one')), bytes: Buffer.from('forged-one') };
  const image2 = { record: imageEvidence('image_forged_2', Buffer.from('forged-two')), bytes: Buffer.from('forged-two') };
  const plan = buildStageALabPlan(planInput(envelopeOf({ images: [image1, image2] }), [image1, image2], []));
  const [left, right] = plan.stageA.request.photos;
  const empty = photoId => stageObservation(photoId, { mentions: [], times: [], places: [], events: [], scenes: [], unknownFacets: ['person', 'time', 'place', 'event', 'scene'] });
  const deps = Object.fromEntries(plan.stageA.request.photos.map(photo => [photo.photoId, contract.photoHash(photo)]));
  const forged = { kind: 'event', left: { photoId: left.photoId }, right: { photoId: right.photoId }, decision: 'same', supports: [], rationale: 'missing_correction', deps, origin: 'user' };
  assert.throws(() => composeStageALabResult({ plan, stageResult: stageResult(plan, [empty(left.photoId), empty(right.photoId)], { edges: [forged] }), createdAt }), /STAGE_A_RESULT_MISMATCH/);
});

test('content observations require their primary evidence among supports but allow additional local evidence', () => {
  const { input } = baseFixture();
  const plan = buildStageALabPlan(input);
  const valid = { contentId: 'content_text_1', evidenceId: 'evidence_note_1', facet: 'event', rawValue: '家庭聚会', supports: [{ evidenceId: 'evidence_note_1', sourceType: 'user_text', quote: '家庭聚会' }], state: 'candidate' };
  assert.doesNotThrow(() => composeStageALabResult({ plan, stageResult: stageResult(plan, [stageObservation(plan.stageA.request.photos[0].photoId)]), textObservations: [valid], createdAt }));
  const invalid = { ...valid, supports: [{ evidenceId: 'evidence_asr_1', sourceType: 'final_asr' }] };
  assert.throws(() => composeStageALabResult({ plan, stageResult: stageResult(plan, [stageObservation(plan.stageA.request.photos[0].photoId)]), textObservations: [invalid], createdAt }), /OBSERVATION_PRIMARY_SUPPORT_MISSING|FOREIGN_SUPPORT|FOREIGN_TEXT_OBSERVATION/);
  const imageInjection = { ...valid, contentId: 'content_image_1' };
  assert.throws(() => composeStageALabResult({ plan, stageResult: stageResult(plan, [stageObservation(plan.stageA.request.photos[0].photoId)]), textObservations: [imageInjection], createdAt }), /FOREIGN_TEXT_OBSERVATION/);
  const sourceSpoof = { ...valid, supports: [{ evidenceId: 'evidence_note_1', sourceType: 'visual' }] };
  assert.throws(() => composeStageALabResult({ plan, stageResult: stageResult(plan, [stageObservation(plan.stageA.request.photos[0].photoId)]), textObservations: [sourceSpoof], createdAt }), /FOREIGN_TEXT_OBSERVATION/);
  const missingSource = { ...valid, supports: [{ evidenceId: 'evidence_note_1', quote: '家庭聚会' }] };
  assert.throws(() => composeStageALabResult({ plan, stageResult: stageResult(plan, [stageObservation(plan.stageA.request.photos[0].photoId)]), textObservations: [missingSource], createdAt }), /FOREIGN_TEXT_OBSERVATION/);
  const unsupportedQuote = { ...valid, supports: [{ evidenceId: 'evidence_note_1', sourceType: 'user_text', quote: '原文不存在的毕业典礼' }] };
  assert.throws(() => composeStageALabResult({ plan, stageResult: stageResult(plan, [stageObservation(plan.stageA.request.photos[0].photoId)]), textObservations: [unsupportedQuote], createdAt }), /FOREIGN_TEXT_OBSERVATION/);
  const emptyQuote = { ...valid, supports: [{ evidenceId: 'evidence_note_1', sourceType: 'user_text', quote: '   ' }] };
  assert.throws(() => composeStageALabResult({ plan, stageResult: stageResult(plan, [stageObservation(plan.stageA.request.photos[0].photoId)]), textObservations: [emptyQuote], createdAt }), /FOREIGN_TEXT_OBSERVATION/);

  assert.doesNotThrow(() => validateOrganizationInput({ scope, contents: [{ contentId: 'content_multi', scope, modality: 'photo', evidenceIds: ['evidence_primary', 'evidence_secondary'], lifecycle: 'active' }], observations: [{ contentId: 'content_multi', evidenceId: 'evidence_primary', facet: 'event', rawValue: '聚会', supports: [{ evidenceId: 'evidence_primary' }, { evidenceId: 'evidence_secondary' }], state: 'candidate' }], explicitAssociations: [], createdAt, config: {} }));
  assert.throws(() => validateOrganizationInput({ scope, contents: [{ contentId: 'content_multi', scope, modality: 'photo', evidenceIds: ['evidence_primary', 'evidence_secondary'], lifecycle: 'active' }], observations: [{ contentId: 'content_multi', evidenceId: 'evidence_primary', facet: 'event', rawValue: '聚会', supports: [{ evidenceId: 'evidence_secondary' }], state: 'candidate' }], explicitAssociations: [], createdAt, config: {} }), /OBSERVATION_PRIMARY_SUPPORT_MISSING/);
});

test('validates merged retrieval candidates for duplicate pairs and foreign endpoints', () => {
  const image = { record: imageEvidence('image_retrieval_1', Buffer.from('retrieval-one')), bytes: Buffer.from('retrieval-one') };
  const note = { record: textEvidence('text_retrieval_1', '可能和这张照片有关'), text: '可能和这张照片有关' };
  const envelope = envelopeOf({ images: [image], texts: [note], bindings: [
    binding('binding_retrieval_batch', 'content_text_1', { kind: 'batch' }),
    binding('binding_retrieval_candidate', 'content_text_1', { kind: 'contents', contentIds: ['content_image_1'] }, 'ai_candidate')
  ] });
  const build = () => buildStageALabPlan(planInput(envelope, [image], [note]));
  const observationFor = plan => stageObservation(plan.stageA.request.photos[0].photoId, {
    mentions: [], times: [], places: [], events: [], scenes: [], unknownFacets: ['person', 'time', 'place', 'event', 'scene']
  });

  const valid = build();
  assert.doesNotThrow(() => composeStageALabResult({ plan: valid, stageResult: stageResult(valid, [observationFor(valid)]), createdAt }));

  const duplicate = build();
  duplicate.baseOrganization.retrievalCandidates.push({
    ...duplicate.baseOrganization.retrievalCandidates[0],
    candidateId: 'candidate_duplicate_pair'
  });
  assert.throws(() => composeStageALabResult({ plan: duplicate, stageResult: stageResult(duplicate, [observationFor(duplicate)]), createdAt }), /DUPLICATE_RETRIEVAL_PAIR/);

  const foreign = build();
  foreign.baseOrganization.retrievalCandidates[0] = {
    ...foreign.baseOrganization.retrievalCandidates[0],
    candidateId: 'candidate_foreign_endpoint',
    toContentId: 'foreign_content'
  };
  assert.throws(() => composeStageALabResult({ plan: foreign, stageResult: stageResult(foreign, [observationFor(foreign)]), createdAt }), /FOREIGN_RETRIEVAL_CONTENT/);
});
