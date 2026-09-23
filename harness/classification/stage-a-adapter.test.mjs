import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { contract, png, scope, ApiVisionProvider, ClassificationEngine } from './fixtures/stage-a.mjs';
const require = createRequire(import.meta.url);
const { adaptTrustedStageACatalog } = require(`${process.env.CLASSIFICATION_BUILD_DIR}/src/lib/algorithms/classification/stage-a-adapter.js`);

const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const textBytes = value => Buffer.byteLength(value, 'utf8');
const budget = { maxRequests: 10, maxInputTokens: 100000, maxOutputTokens: 2048, maxCostCny: 10, deadlineAt: new Date(Date.now() + 10000).toISOString(), candidatesPerPhoto: 4, maxOutputPerRequest: 2048 };
function image(id = 'image_1') { return { evidenceId: id, subjectId: scope.subjectId, householdId: scope.householdId, schemaVersion: '1.0', ownerId: 'owner_a', contributorId: 'contributor_b', consentRef: 'consent_a', visibility: 'private', ingestedAt: '2026-09-23T00:00:00.000Z', lifecycleState: 'active', sourceRef: { kind: 'object', id: `object_${id}` }, sourceHash: sha(png), revision: 1, byteLength: png.byteLength, modality: 'image', mimeType: 'image/png', dimensions: { width: 1, height: 1 } }; }
function text(id, value, modality = 'text') { const bytes = Buffer.from(value, 'utf8'); return { evidenceId: id, subjectId: scope.subjectId, householdId: scope.householdId, schemaVersion: '1.0', ownerId: 'owner_text', contributorId: 'contributor_child', consentRef: 'consent_a', visibility: 'private', ingestedAt: '2026-09-23T00:00:01.000Z', lifecycleState: 'active', sourceRef: { kind: 'message', id: `message_${id}` }, sourceHash: sha(bytes), revision: 1, byteLength: textBytes(value), modality, mimeType: 'text/plain', ...(modality === 'transcript' ? { asr: { final: true, producerVersion: 'asr-fixture.1' } } : {}) }; }
function catalog(overrides = {}) {
  const img = image(); const note = text('note_1', '这是武汉的毕业照'); const asr = text('asr_1', '那是八五年在武汉拍的', 'transcript');
  return { actorId: 'actor_child', scope, authorizationRevision: 'auth_1', contextRevision: 'ctx_1', authorityRef: 'authority_1', allowPersonMatching: false, allowedEvidenceIds: [img.evidenceId, note.evidenceId, asr.evidenceId], allowedConsentRefs: ['consent_a'], evidence: [img, note, asr], photos: [{ image: img, imageBytes: png, textEvidence: [{ record: note, text: '这是武汉的毕业照' }, { record: asr, text: '那是八五年在武汉拍的' }] }], references: [], corrections: [], ...overrides };
}

test('adapter preserves image, user text and final ASR as independent sources', async () => {
  const result = adaptTrustedStageACatalog(catalog(), { runId: 'run_adapter_1', trigger: 'upload', budget });
  const photo = result.request.photos[0];
  assert.deepEqual(photo.textEvidence.map(item => [item.evidenceId, item.source]), [['note_1', 'user_text'], ['asr_1', 'final_asr']]);
  assert.equal(photo.caption, '');
  assert.equal(result.audit.actorId, 'actor_child');
  assert.deepEqual(result.audit.evidence.map(item => item.evidenceId), ['image_1', 'note_1', 'asr_1']);
  assert.equal(result.audit.evidence[0].ownerId, 'owner_a');
  assert.equal(result.audit.evidence[1].contributorId, 'contributor_child');
  assert.equal(contract.RequestSchema.parse(result.request).runId, 'run_adapter_1');
  const resolved = await result.resolveImage(photo, new AbortController().signal);
  assert.deepEqual(Buffer.from(resolved.bytes), png);
});

test('text support must cite the exact source evidence and quote', () => {
  const result = adaptTrustedStageACatalog(catalog(), { runId: 'run_adapter_2', trigger: 'upload', budget });
  const photo = result.request.photos[0];
  const observation = { photoId: photo.photoId, people: [], mentions: [{ text: '武汉', supports: [{ photoId: photo.photoId, source: 'user_text', evidenceId: 'note_1', quote: '武汉' }] }], times: [], places: [], events: [], scenes: [{ label: '室内', supports: [{ photoId: photo.photoId, source: 'visual', quote: '画面可见' }] }], unknownFacets: ['time', 'place', 'event'], conflicts: [] };
  assert.equal(contract.validateObservation(observation, photo).mentions[0].supports[0].evidenceId, 'note_1');
  assert.throws(() => contract.validateObservation({ ...observation, mentions: [{ ...observation.mentions[0], supports: [{ photoId: photo.photoId, source: 'user_text', evidenceId: 'asr_1', quote: '武汉' }] }] }, photo), /FOREIGN_SOURCE/);
});

test('adapted request enters the Mock Provider and preserves text evidence in its payload', async () => {
  const adapted = adaptTrustedStageACatalog(catalog(), { runId: 'run_adapter_mock', trigger: 'upload', budget });
  const requests = [];
  const provider = new ApiVisionProvider({ provider: 'qwen', model: 'qwen3.5-flash-2026-02-23', resolver: adapted.resolveImage, transport: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const photo = adapted.request.photos[0];
    const value = { observations: [{ photoId: photo.photoId, people: [], mentions: [{ text: '武汉', supports: [{ photoId: photo.photoId, source: 'user_text', evidenceId: 'note_1', quote: '武汉' }] }], times: [], places: [], events: [], scenes: [{ label: '室内', supports: [{ photoId: photo.photoId, source: 'visual', quote: '画面可见' }] }], unknownFacets: ['time', 'place', 'event'], conflicts: [] }] };
    return new Response(JSON.stringify({ id: 'mock_adapter', model: 'qwen3.5-flash-2026-02-23', usage: { prompt_tokens: 10, completion_tokens: 10 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { status: 200 });
  }, inputCnyPerMillion: 0.2, outputCnyPerMillion: 2 });
  const result = await new ClassificationEngine(provider).process(adapted.request, () => adapted.authorization);
  assert.equal(result.workflowStatus, 'succeeded');
  assert.ok(requests[0].messages[1].content.some(item => item.type === 'text' && item.text.includes('note_1')));
});

test('cross scope, missing payload and hash mismatch are rejected', () => {
  const wrong = catalog(); wrong.evidence[0].householdId = 'other_house';
  assert.throws(() => adaptTrustedStageACatalog(wrong, { runId: 'run_adapter_3', trigger: 'upload', budget }), /CROSS_SCOPE/);
  const missing = catalog(); missing.photos[0].imageBytes = undefined;
  assert.throws(() => adaptTrustedStageACatalog(missing, { runId: 'run_adapter_4', trigger: 'upload', budget }), /MISSING_EVIDENCE_PAYLOAD/);
  const badHash = catalog(); badHash.photos[0].imageBytes = Buffer.from('different');
  assert.throws(() => adaptTrustedStageACatalog(badHash, { runId: 'run_adapter_5', trigger: 'upload', budget }), /SOURCE_LENGTH_MISMATCH|SOURCE_HASH_MISMATCH/);
});

test('unbound and duplicate text bindings are rejected', () => {
  const base = catalog();
  const extra = text('note_2', '另一条说明');
  assert.throws(() => adaptTrustedStageACatalog({ ...base, evidence: [...base.evidence, extra], allowedEvidenceIds: [...base.allowedEvidenceIds, extra.evidenceId] }, { runId: 'run_adapter_6', trigger: 'upload', budget }), /UNBOUND_TEXT_EVIDENCE/);
  const duplicate = catalog(); duplicate.photos[0].textEvidence = [{ record: duplicate.evidence[1], text: '这是武汉的毕业照' }, { record: duplicate.evidence[1], text: '这是武汉的毕业照' }];
  assert.throws(() => adaptTrustedStageACatalog(duplicate, { runId: 'run_adapter_7', trigger: 'upload', budget }), /DUPLICATE_EVIDENCE_BINDING/);
});

test('deleted evidence requires a prior photo snapshot and becomes inactive', () => {
  const prior = adaptTrustedStageACatalog(catalog(), { runId: 'run_adapter_8', trigger: 'upload', budget }).request.photos[0];
  const tombstone = { evidenceId: 'image_1', subjectId: scope.subjectId, householdId: scope.householdId, schemaVersion: '1.0', revision: 2, lifecycleState: 'deleted', deletedAt: '2026-09-23T00:00:02.000Z' };
  const deleted = { ...catalog(), evidence: [tombstone], allowedEvidenceIds: ['image_1'], photos: [{ image: tombstone, priorPhoto: prior, textEvidence: [] }] };
  const result = adaptTrustedStageACatalog(deleted, { runId: 'run_adapter_9', trigger: 'information_changed', budget });
  assert.equal(result.request.photos[0].active, false);
  assert.throws(() => adaptTrustedStageACatalog({ ...deleted, photos: [{ image: tombstone, textEvidence: [] }] }, { runId: 'run_adapter_10', trigger: 'information_changed', budget }), /DELETION_REQUIRES_PRIOR_PHOTO/);
});

test('partial transcript cannot be adapted', () => {
  const base = catalog();
  const partial = { ...base.evidence[2], asr: { final: false, producerVersion: 'asr-fixture.1' } };
  const changed = { ...base, evidence: [base.evidence[0], base.evidence[1], partial] }; changed.photos[0].textEvidence[1].record = partial; changed.photos[0].textEvidence[1].text = '那是八五年在武汉拍的';
  assert.throws(() => adaptTrustedStageACatalog(changed, { runId: 'run_adapter_11', trigger: 'upload', budget }), /PARTIAL_ASR_NOT_ALLOWED|INVALID_CONTRACT/);
});
