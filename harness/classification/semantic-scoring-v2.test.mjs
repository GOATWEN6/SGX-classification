import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const clone = value => JSON.parse(JSON.stringify(value));

const paths = {
  policySchema: 'contracts/classification-scoring-policy-v2.schema.json',
  truthSchema: 'contracts/classification-truth-v2.schema.json',
  casesSchema: 'contracts/classification-semantic-scoring-cases-v2.schema.json',
  policy: 'harness/classification/fixtures/semantic-scoring-policy-v2.json',
  truth: 'harness/classification/fixtures/semantic-truth-v2.json',
  cases: 'harness/classification/fixtures/semantic-scoring-v2-cases.json',
  ledger: 'docs/algorithms/evidence/CLASSIFICATION_SEMANTIC_V2_BLIND_REVIEW_2026-09-29.json',
  spec: 'docs/superpowers/specs/2026-09-29-classification-semantic-scoring-v2-spec.md',
  freeze: 'docs/algorithms/evidence/CLASSIFICATION_SEMANTIC_V2_FREEZE_2026-09-29.json',
};

async function validators() {
  const ajv = new Ajv({ allErrors: true, strictKeywords: true });
  return {
    policy: ajv.compile(await readJson(paths.policySchema)),
    truth: ajv.compile(await readJson(paths.truthSchema)),
    cases: ajv.compile(await readJson(paths.casesSchema)),
  };
}

const normalizeValue = value => value.normalize('NFKC').trim().toLowerCase();
const sameValue = (left, right) => normalizeValue(left) === normalizeValue(right);
const intersects = (left, right) => left.some(value => right.includes(value));
const sorted = values => [...values].sort();

function hasSameTimeShape(left, right) {
  return left.facet !== 'time'
    || (left.timeRole === right.timeRole && left.precision === right.precision);
}

function matchesAssertion(prediction, assertion) {
  return prediction.facet === assertion.facet
    && hasSameTimeShape(prediction, assertion)
    && [assertion.value, ...assertion.aliases].some(value => sameValue(prediction.value, value));
}

function matchesVariant(prediction, variant) {
  return prediction.facet === variant.facet
    && hasSameTimeShape(prediction, variant)
    && variant.values.some(value => sameValue(prediction.value, value));
}

function findSemanticMatch(prediction, truthItem) {
  const required = truthItem.requiredCore.find(assertion => matchesAssertion(prediction, assertion));
  if (required) return { class: 'required_core', assertion: required };

  for (const variant of truthItem.acceptableVariants) {
    if (!matchesVariant(prediction, variant)) continue;
    const assertion = truthItem.requiredCore.find(entry => entry.assertionId === variant.satisfiesAssertionId);
    return { class: 'acceptable_variant', assertion, variant };
  }

  const supported = truthItem.supportedExtras.find(assertion => matchesAssertion(prediction, assertion));
  if (supported) return { class: 'supported_extra', assertion: supported };
  return null;
}

function findConflictCandidate(prediction, truthItem) {
  for (const conflict of truthItem.conflicts) {
    if (prediction.facet !== conflict.facet) continue;
    const candidate = conflict.candidates.find(entry => sameValue(prediction.value, entry.value)
      && hasSameTimeShape(prediction, { ...entry, facet: conflict.facet }));
    if (candidate) return { conflict, candidate };
  }
  return null;
}

function hasValidProvenance(prediction, assertion, policy) {
  const sourceRefMatch = intersects(prediction.sourceRefs, assertion.sourceRefs);
  const authorityKinds = policy.truthAuthorityEvidenceKinds[assertion.authority] ?? [];
  const authorityMatch = prediction.evidenceKinds.some(kind => authorityKinds.includes(kind));
  const roleMatch = prediction.facet !== 'time'
    || prediction.evidenceKinds.every(kind => policy.timeRoles[prediction.timeRole].allowedEvidenceKinds.includes(kind));
  return sourceRefMatch && authorityMatch && roleMatch;
}

function matchesForbidden(prediction, forbidden) {
  if (prediction.facet !== forbidden.facet) return false;
  if (forbidden.match.kind === 'any_unmatched_in_facet') return true;
  if (forbidden.match.kind !== 'exact_value') return false;
  return sameValue(prediction.value, forbidden.match.value)
    && (prediction.facet !== 'time'
      || (prediction.timeRole === forbidden.match.timeRole
        && prediction.precision === forbidden.match.precision));
}

function riskClass(prediction, truthItem, policy) {
  const forbidden = truthItem.forbiddenAssertions.find(entry => matchesForbidden(prediction, entry));
  if (forbidden) return { class: forbidden.riskClass, forbidden };
  const highImpact = policy.riskPolicy.highImpactFacets.includes(prediction.facet)
    || (prediction.facet === 'time'
      && policy.riskPolicy.highImpactTimePrecisions.includes(prediction.precision))
    || (prediction.facet === 'place' && policy.riskPolicy.unmatchedNamedPlaceIsHighImpact);
  return { class: highImpact ? 'unsafe_false_positive' : 'unsupported_extra', forbidden: null };
}

function deriveWorkflowAssessment(workflowStatus, truthItem, policy) {
  const outcomes = policy.denominatorPolicy.workflowAssessment;
  if (workflowStatus === 'failed') return outcomes.failedOutcome;
  if (workflowStatus === 'not_run') return outcomes.notRunOutcome;
  return workflowStatus === truthItem.expectedWorkflowStatus
    ? outcomes.matchOutcome
    : outcomes.mismatchOutcome;
}

function conflictAssessment(entry, truthItem) {
  const expectedFacets = new Set(truthItem.conflicts.map(conflict => conflict.facet));
  const reportedFacets = new Set(entry.input.conflicts);
  const extraFacets = [...reportedFacets].filter(facet => !expectedFacets.has(facet));
  const incompleteConflictIds = [];

  for (const conflict of truthItem.conflicts) {
    const coveredCandidates = conflict.candidates.filter(candidate => entry.input.predictions.some(prediction =>
      prediction.facet === conflict.facet
      && sameValue(prediction.value, candidate.value)
      && hasSameTimeShape(prediction, { ...candidate, facet: conflict.facet })));
    if (!reportedFacets.has(conflict.facet) || coveredCandidates.length !== conflict.candidates.length) {
      incompleteConflictIds.push(conflict.conflictId);
    }
  }

  let status = 'none';
  if (truthItem.conflicts.length) status = incompleteConflictIds.length ? 'incomplete' : 'complete';
  if (extraFacets.length) {
    status = truthItem.conflicts.length && !incompleteConflictIds.length
      ? 'complete_with_unsupported_cross_facet_extra'
      : 'unexpected';
  }
  return { status, incompleteConflictIds, extraFacets };
}

function observationAssessment(entry, truthItem) {
  const preserved = [];
  const matchedInputIds = new Set();
  for (const truthObservation of truthItem.observations) {
    const input = entry.input.observations.find(observation =>
      observation.facet === truthObservation.facet
      && observation.kind === truthObservation.kind
      && sameValue(observation.rawValue, truthObservation.rawValue)
      && sameValue(observation.normalizedValue, truthObservation.normalizedValue)
      && observation.role === truthObservation.role
      && observation.precision === truthObservation.precision
      && intersects(observation.sourceRefs, truthObservation.sourceRefs)
      && observation.evidenceKinds.includes('ocr_candidate'));
    if (input) {
      preserved.push(truthObservation.observationId);
      matchedInputIds.add(input.observationId);
    }
  }
  assert.equal(matchedInputIds.size, entry.input.observations.length,
    `${entry.caseId}:unmatched role_unknown observation`);
  return {
    preservedTruthObservationIds: sorted(preserved),
    missingTruthObservationIds: sorted(truthItem.observations
      .map(observation => observation.observationId)
      .filter(id => !preserved.includes(id))),
  };
}

function validateCaseSemantics(fixture, truth, policy) {
  const truthById = new Map(truth.items.map(item => [item.itemId, item]));
  for (const entry of fixture.cases) {
    const truthItem = truthById.get(entry.truthItemId);
    assert.ok(truthItem, `${entry.caseId}:truth item`);
    const resultsByPrediction = new Map();
    for (const result of entry.expected.classifications) {
      if (!result.predictionId) continue;
      const results = resultsByPrediction.get(result.predictionId) ?? [];
      results.push(result);
      resultsByPrediction.set(result.predictionId, results);
    }

    for (const prediction of entry.input.predictions) {
      const conflictSide = findConflictCandidate(prediction, truthItem);
      const outcomes = resultsByPrediction.get(prediction.predictionId) ?? [];
      if (conflictSide) {
        assert.equal(outcomes.length, 0, `${entry.caseId}:${prediction.predictionId}:conflict lane`);
        assert.equal(intersects(prediction.sourceRefs, conflictSide.candidate.sourceRefs), true,
          `${entry.caseId}:${prediction.predictionId}:conflict sourceRefs`);
        continue;
      }

      assert.equal(outcomes.length, 1, `${entry.caseId}:${prediction.predictionId}:one outcome`);
      const result = outcomes[0];
      const semanticMatch = findSemanticMatch(prediction, truthItem);
      if (semanticMatch && hasValidProvenance(prediction, semanticMatch.assertion, policy)) {
        assert.equal(result.class, semanticMatch.class, `${entry.caseId}:${prediction.predictionId}:semantic class`);
        assert.equal(result.satisfiesAssertionId, semanticMatch.assertion.assertionId,
          `${entry.caseId}:${prediction.predictionId}:semantic target`);
      } else {
        const risk = riskClass(prediction, truthItem, policy);
        assert.equal(result.class, risk.class, `${entry.caseId}:${prediction.predictionId}:fail-closed risk`);
        if (result.matchesForbiddenAssertionId) {
          assert.ok(risk.forbidden, `${entry.caseId}:${prediction.predictionId}:forbidden target`);
          assert.equal(result.matchesForbiddenAssertionId, risk.forbidden.assertionId,
            `${entry.caseId}:${prediction.predictionId}:forbidden target`);
        }
      }
    }

    const satisfiedRequired = new Set(entry.expected.classifications
      .filter(result => ['required_core', 'acceptable_variant'].includes(result.class))
      .map(result => result.satisfiesAssertionId));
    const missingRequired = truthItem.requiredCore
      .map(assertion => assertion.assertionId)
      .filter(id => !satisfiedRequired.has(id));
    assert.deepEqual(sorted(entry.expected.missingRequiredAssertionIds), sorted(missingRequired),
      `${entry.caseId}:missing required completeness`);

    assert.deepEqual(
      {
        preservedTruthObservationIds: sorted(entry.expected.observationAssessment.preservedTruthObservationIds),
        missingTruthObservationIds: sorted(entry.expected.observationAssessment.missingTruthObservationIds),
      },
      observationAssessment(entry, truthItem),
      `${entry.caseId}:observation completeness`,
    );

    assert.equal(entry.expected.workflowAssessment,
      deriveWorkflowAssessment(entry.input.workflowStatus, truthItem, policy),
      `${entry.caseId}:workflow assessment`);

    const conflict = conflictAssessment(entry, truthItem);
    assert.equal(entry.expected.conflictStatus, conflict.status, `${entry.caseId}:conflict status`);
    for (const conflictId of conflict.incompleteConflictIds) {
      assert.equal(entry.expected.classifications.some(result =>
        result.class === 'conflict_incomplete' && result.conflictId === conflictId), true,
      `${entry.caseId}:${conflictId}:missing conflict outcome`);
    }
    for (const facet of conflict.extraFacets) {
      assert.equal(entry.expected.classifications.some(result =>
        result.class === 'unsupported_extra' && result.value === `conflict:${facet}`), true,
      `${entry.caseId}:${facet}:missing unexpected conflict outcome`);
    }
  }
}

function validateTruthSemantics(truth, policy) {
  const knownAuthorities = new Set(Object.keys(policy.truthAuthorityEvidenceKinds));
  for (const item of truth.items) {
    const required = new Map(item.requiredCore.map(assertion => [assertion.assertionId, assertion]));
    for (const assertion of [...item.requiredCore, ...item.supportedExtras]) {
      assert.equal(knownAuthorities.has(assertion.authority), true, `${item.itemId}:${assertion.assertionId}:authority`);
      if (assertion.facet === 'time') {
        assert.ok(assertion.timeRole, `${assertion.assertionId}:timeRole`);
        assert.ok(assertion.precision, `${assertion.assertionId}:precision`);
      } else {
        assert.equal('timeRole' in assertion, false, `${assertion.assertionId}:unexpected timeRole`);
        assert.equal('precision' in assertion, false, `${assertion.assertionId}:unexpected precision`);
      }
    }
    for (const variant of item.acceptableVariants) {
      const target = required.get(variant.satisfiesAssertionId);
      assert.ok(target, `${item.itemId}:${variant.variantId}:target`);
      assert.equal(variant.facet, target.facet, `${variant.variantId}:facet drift`);
      if (target.facet === 'time') {
        assert.ok(variant.timeRole, `${variant.variantId}:timeRole`);
        assert.ok(variant.precision, `${variant.variantId}:precision`);
        assert.equal(variant.timeRole, target.timeRole, `${variant.variantId}:role drift`);
      } else {
        assert.equal('timeRole' in variant, false, `${variant.variantId}:unexpected timeRole`);
        assert.equal('precision' in variant, false, `${variant.variantId}:unexpected precision`);
      }
    }
    for (const conflict of item.conflicts) {
      const keys = conflict.candidates.map(candidate =>
        [candidate.timeRole ?? '', candidate.precision ?? '', candidate.value].join(':'));
      assert.equal(new Set(keys).size, keys.length, `${conflict.conflictId}:duplicate candidate`);
      if (conflict.facet === 'time') {
        assert.ok(conflict.candidates.every(candidate => candidate.timeRole && candidate.precision));
        assert.equal(new Set(conflict.candidates.map(candidate => candidate.timeRole)).size, 1,
          `${conflict.conflictId}:mixed time roles`);
      }
      const statuses = conflict.candidates.map(candidate => candidate.status);
      if (conflict.resolution === 'unresolved') {
        assert.equal(statuses.every(status => ['asserted', 'tentative'].includes(status)), true,
          `${conflict.conflictId}:unresolved status`);
      } else if (conflict.resolution === 'user_corrected') {
        assert.equal(statuses.filter(status => status === 'asserted').length, 1,
          `${conflict.conflictId}:corrected winner`);
        assert.equal(statuses.filter(status => status === 'retracted').length, statuses.length - 1,
          `${conflict.conflictId}:corrected retractions`);
      } else {
        assert.equal(statuses.every(status => status === 'retracted'), true,
          `${conflict.conflictId}:negated status`);
      }
    }
  }
}

test('semantic scoring v2 policy, truth and cases satisfy their frozen schemas', async () => {
  const [validate, policy, truth, cases] = await Promise.all([
    validators(), readJson(paths.policy), readJson(paths.truth), readJson(paths.cases),
  ]);
  assert.equal(validate.policy(policy), true, JSON.stringify(validate.policy.errors));
  assert.equal(validate.truth(truth), true, JSON.stringify(validate.truth.errors));
  assert.equal(validate.cases(cases), true, JSON.stringify(validate.cases.errors));
  validateTruthSemantics(truth, policy);
  validateCaseSemantics(cases, truth, policy);
});

test('truth binds policy and blind-review ledger bytes with no dangling semantic references', async () => {
  const [truth, policy, policyBytes, ledger, ledgerBytes] = await Promise.all([
    readJson(paths.truth),
    readJson(paths.policy),
    readFile(path.join(root, paths.policy)),
    readJson(paths.ledger),
    readFile(path.join(root, paths.ledger)),
  ]);
  assert.equal(truth.scoringPolicy.sha256, sha256(policyBytes));
  assert.equal(truth.blindReview.ledgerSha256, sha256(ledgerBytes));
  assert.deepEqual(truth.blindReview.reviewerIds.sort(), ledger.reviewers.map(entry => entry.reviewerId).sort());
  assert.equal(truth.blindReview.packetSha256, ledger.packet.packetSha256);
  assert.equal(truth.blindReview.reviewRulesSha256, ledger.packet.reviewRulesSha256);
  validateTruthSemantics(truth, policy);
  assert.equal(new Set(truth.items.map(item => item.itemId)).size, truth.items.length);

  const globalIds = new Set();
  for (const item of truth.items) {
    const requiredIds = new Set(item.requiredCore.map(assertion => assertion.assertionId));
    for (const variant of item.acceptableVariants) {
      assert.equal(requiredIds.has(variant.satisfiesAssertionId), true, `${item.itemId}:${variant.variantId}`);
    }
    for (const assertion of [...item.requiredCore, ...item.supportedExtras]) {
      assert.equal(globalIds.has(assertion.assertionId), false, assertion.assertionId);
      globalIds.add(assertion.assertionId);
      if (assertion.facet === 'time') {
        assert.ok(assertion.timeRole, assertion.assertionId);
        assert.ok(assertion.precision, assertion.assertionId);
      }
    }
    for (const conflict of item.conflicts) {
      assert.equal(new Set(conflict.candidates.map(candidate => candidate.value)).size, conflict.candidates.length);
      assert.ok(conflict.candidates.every(candidate => candidate.sourceRefs.length > 0));
    }
    assert.deepEqual(item.evaluation.closedFacets, ['time', 'place', 'event', 'scene']);
    assert.deepEqual(item.evaluation.excludedFacets.map(entry => entry.facet).sort(), ['person_cluster', 'quality', 'theme']);
  }
});

test('visible pixel date remains role-unknown and does not create a frozen conflict', async () => {
  const [truth, policy] = await Promise.all([readJson(paths.truth), readJson(paths.policy)]);
  const item = truth.items.find(entry => entry.itemId === 'sgx-v3-g025');
  assert.ok(item);
  assert.deepEqual(item.conflicts, []);
  assert.equal(item.expectedWorkflowStatus, 'needs_review');
  assert.deepEqual(item.observations.map(entry => ({ value: entry.normalizedValue, role: entry.role })), [
    { value: '2001-07', role: 'role_unknown' },
  ]);
  assert.equal(item.requiredCore.some(entry => entry.value === '1998-summer' && entry.timeRole === 'event'), true);
  assert.equal(policy.timePrecisionPolicy.scoredPrecisions.includes('season'), true);
  assert.equal(policy.timePrecisionPolicy.scoredPrecisions.includes('year_month'), true);
  assert.equal(policy.timePrecisionPolicy.neverObservationOnlyByPrecision, true);
});

test('positive and negative cases bind policy/truth and cover all seven classes and fixed denominator states', async () => {
  const [fixture, truth, policy, policyBytes, truthBytes] = await Promise.all([
    readJson(paths.cases), readJson(paths.truth), readJson(paths.policy),
    readFile(path.join(root, paths.policy)), readFile(path.join(root, paths.truth)),
  ]);
  assert.equal(fixture.policySha256, sha256(policyBytes));
  assert.equal(fixture.truthSha256, sha256(truthBytes));
  validateCaseSemantics(fixture, truth, policy);
  const truthById = new Map(truth.items.map(item => [item.itemId, item]));
  const covered = new Set();
  const caseIds = new Set();
  let hasPositive = false;
  let hasNegative = false;
  let hasFailedDenominator = false;
  let hasNotRunDenominator = false;
  let hasWorkflowMismatch = false;
  let hasPreservedObservation = false;
  let hasVisualExactDateGuard = false;
  let hasOcrExactDateGuard = false;
  let hasDisjointSourceGuard = false;
  for (const entry of fixture.cases) {
    assert.equal(caseIds.has(entry.caseId), false, entry.caseId);
    caseIds.add(entry.caseId);
    const truthItem = truthById.get(entry.truthItemId);
    assert.ok(truthItem, entry.caseId);
    assert.equal(entry.expected.includedInFixedDenominator, true, entry.caseId);
    const predictionIds = new Set(entry.input.predictions.map(prediction => prediction.predictionId));
    assert.equal(predictionIds.size, entry.input.predictions.length);
    const requiredIds = new Set(truthItem.requiredCore.map(assertion => assertion.assertionId));
    const assertionIds = new Set([...truthItem.requiredCore, ...truthItem.supportedExtras]
      .map(assertion => assertion.assertionId));
    const forbiddenIds = new Set(truthItem.forbiddenAssertions.map(assertion => assertion.assertionId));
    const conflictIds = new Set(truthItem.conflicts.map(conflict => conflict.conflictId));
    for (const result of entry.expected.classifications) {
      if (result.predictionId) assert.equal(predictionIds.has(result.predictionId), true, `${entry.caseId}:${result.predictionId}`);
      if (result.satisfiesAssertionId) assert.equal(assertionIds.has(result.satisfiesAssertionId), true, result.satisfiesAssertionId);
      if (result.matchesForbiddenAssertionId) assert.equal(forbiddenIds.has(result.matchesForbiddenAssertionId), true, result.matchesForbiddenAssertionId);
      if (result.conflictId) assert.equal(conflictIds.has(result.conflictId), true, result.conflictId);
    }
    assert.ok(entry.expected.missingRequiredAssertionIds.every(id => requiredIds.has(id)), entry.caseId);
    if (entry.expected.workflowAssessment === 'matches_truth') {
      assert.equal(entry.input.workflowStatus, truthItem.expectedWorkflowStatus, entry.caseId);
    }
    entry.expected.classifications.forEach(result => covered.add(result.class));
    if (entry.expected.missingRequiredAssertionIds.length) covered.add('missing_required');
    hasPositive ||= entry.kind === 'positive';
    hasNegative ||= entry.kind === 'negative';
    hasFailedDenominator ||= entry.input.workflowStatus === 'failed';
    hasNotRunDenominator ||= entry.input.workflowStatus === 'not_run';
    hasWorkflowMismatch ||= entry.expected.workflowAssessment === 'status_mismatch';
    hasPreservedObservation ||= entry.expected.observationAssessment.preservedTruthObservationIds.length > 0;
    hasVisualExactDateGuard ||= entry.caseId === 'g007-visual-cannot-support-exact-event-date';
    hasOcrExactDateGuard ||= entry.caseId === 'g007-ocr-cannot-support-exact-event-date';
    hasDisjointSourceGuard ||= entry.caseId === 'g007-disjoint-source-cannot-support-exact-event-date';
  }
  assert.deepEqual([...covered].sort(), [
    'acceptable_variant',
    'conflict_incomplete',
    'missing_required',
    'required_core',
    'supported_extra',
    'unsafe_false_positive',
    'unsupported_extra',
  ]);
  assert.equal(hasPositive, true);
  assert.equal(hasNegative, true);
  assert.equal(hasFailedDenominator, true);
  assert.equal(hasNotRunDenominator, true);
  assert.equal(hasWorkflowMismatch, true);
  assert.equal(hasPreservedObservation, true);
  assert.equal(hasVisualExactDateGuard, true);
  assert.equal(hasOcrExactDateGuard, true);
  assert.equal(hasDisjointSourceGuard, true);
  assert.equal(JSON.stringify(fixture).includes('overallAccuracy'), false);
});

test('schemas and semantic checks reject invalid provenance, incomplete cases and inconsistent workflow or conflicts', async () => {
  const [validate, policy, truth, cases] = await Promise.all([
    validators(), readJson(paths.policy), readJson(paths.truth), readJson(paths.cases),
  ]);

  const numericGate = clone(policy);
  numericGate.gates.functional.numericPassThreshold = 0.8;
  assert.equal(validate.policy(numericGate), false);

  const captureFromText = clone(policy);
  captureFromText.timeRoles.capture.allowedEvidenceKinds = ['trusted_original_exif', 'user_text'];
  assert.equal(validate.policy(captureFromText), false);

  const eventFromVisual = clone(policy);
  eventFromVisual.timeRoles.event.allowedEvidenceKinds.push('visual_content');
  assert.equal(validate.policy(eventFromVisual), false);

  const weakBlindReview = clone(truth);
  weakBlindReview.blindReview.excludedArtifactTypes.pop();
  assert.equal(validate.truth(weakBlindReview), false);

  const oneSidedConflict = clone(truth);
  oneSidedConflict.items.find(item => item.itemId === 'sgx-v3-g011').conflicts[0].candidates.pop();
  assert.equal(validate.truth(oneSidedConflict), false);

  const promotedObservation = clone(truth);
  promotedObservation.items.find(item => item.itemId === 'sgx-v3-g025').observations[0].role = 'capture';
  assert.equal(validate.truth(promotedObservation), false);

  const missingTimeShape = clone(truth);
  const timeAssertion = missingTimeShape.items.find(item => item.itemId === 'sgx-v3-g007').requiredCore
    .find(assertion => assertion.facet === 'time');
  delete timeAssertion.timeRole;
  delete timeAssertion.precision;
  assert.equal(validate.truth(missingTimeShape), false);

  const timeFieldsOnEvent = clone(truth);
  const eventAssertion = timeFieldsOnEvent.items.find(item => item.itemId === 'sgx-v3-g007').requiredCore
    .find(assertion => assertion.facet === 'event');
  eventAssertion.timeRole = 'event';
  eventAssertion.precision = 'year';
  assert.equal(validate.truth(timeFieldsOnEvent), false);

  const missingVariantTimeShape = clone(truth);
  const timeVariant = missingVariantTimeShape.items.find(item => item.itemId === 'sgx-v3-g025').acceptableVariants[0];
  delete timeVariant.timeRole;
  delete timeVariant.precision;
  assert.equal(validate.truth(missingVariantTimeShape), false);

  const correctedWithoutRetraction = clone(truth);
  const correctedConflict = correctedWithoutRetraction.items.find(item => item.itemId === 'sgx-v3-g011').conflicts[0];
  correctedConflict.resolution = 'user_corrected';
  assert.equal(validate.truth(correctedWithoutRetraction), false);

  const mixedConflictRoles = clone(truth);
  mixedConflictRoles.items.find(item => item.itemId === 'sgx-v3-g011').conflicts[0].candidates[1].timeRole = 'capture';
  assert.throws(() => validateTruthSemantics(mixedConflictRoles, policy), /mixed time roles/);

  const duplicateConflictSide = clone(truth);
  const candidates = duplicateConflictSide.items.find(item => item.itemId === 'sgx-v3-g011').conflicts[0].candidates;
  candidates[1] = clone(candidates[0]);
  assert.equal(validate.truth(duplicateConflictSide), false);

  const malformedRequiredClass = clone(cases);
  delete malformedRequiredClass.cases.find(entry => entry.caseId === 'exact-required-core')
    .expected.classifications[0].satisfiesAssertionId;
  assert.equal(validate.cases(malformedRequiredClass), false);

  const failedMarkedAsMatch = clone(cases);
  failedMarkedAsMatch.cases.find(entry => entry.caseId === 'failed-remains-in-denominator')
    .expected.workflowAssessment = 'matches_truth';
  assert.equal(validate.cases(failedMarkedAsMatch), false);

  const incompleteMissingSet = clone(cases);
  incompleteMissingSet.cases.find(entry => entry.caseId === 'exact-required-core')
    .expected.missingRequiredAssertionIds.pop();
  assert.equal(validate.cases(incompleteMissingSet), true, JSON.stringify(validate.cases.errors));
  assert.throws(() => validateCaseSemantics(incompleteMissingSet, truth, policy), /missing required completeness/);

  const acceptedVisualDate = clone(cases);
  acceptedVisualDate.cases.find(entry => entry.caseId === 'g007-visual-cannot-support-exact-event-date')
    .expected.classifications[0] = {
      predictionId: 'p1',
      class: 'required_core',
      satisfiesAssertionId: 'truth:g007:time:event-date',
    };
  assert.equal(validate.cases(acceptedVisualDate), true, JSON.stringify(validate.cases.errors));
  assert.throws(() => validateCaseSemantics(acceptedVisualDate, truth, policy), /fail-closed risk/);

  const hiddenWorkflowMismatch = clone(cases);
  hiddenWorkflowMismatch.cases.find(entry => entry.caseId === 'completed-workflow-status-mismatch')
    .expected.workflowAssessment = 'matches_truth';
  assert.equal(validate.cases(hiddenWorkflowMismatch), true, JSON.stringify(validate.cases.errors));
  assert.throws(() => validateCaseSemantics(hiddenWorkflowMismatch, truth, policy), /workflow assessment/);

  const droppedObservation = clone(cases);
  droppedObservation.cases.find(entry => entry.caseId === 'preserve-role-unknown-visible-date')
    .expected.observationAssessment = {
      preservedTruthObservationIds: [],
      missingTruthObservationIds: ['truth:g025:observation:visible-date'],
    };
  assert.equal(validate.cases(droppedObservation), true, JSON.stringify(validate.cases.errors));
  assert.throws(() => validateCaseSemantics(droppedObservation, truth, policy), /observation completeness/);
});

test('semantic freeze manifest hashes every frozen E1 artifact by raw bytes', async () => {
  const [freeze, policy, truth, ledger] = await Promise.all([
    readJson(paths.freeze), readJson(paths.policy), readJson(paths.truth), readJson(paths.ledger),
  ]);
  assert.equal(freeze.gates.readyForE2ScorerImplementation, true);
  assert.equal(freeze.gates.readyForRealDistributionClaims, false);
  assert.deepEqual(sorted(freeze.artifacts.map(artifact => artifact.path)), sorted([
    paths.spec,
    paths.policySchema,
    paths.truthSchema,
    paths.casesSchema,
    paths.policy,
    paths.truth,
    paths.cases,
    paths.ledger,
  ]));
  assert.ok(Date.parse(ledger.createdAt) <= Date.parse(truth.blindReview.reviewedAt));
  assert.ok(Date.parse(truth.blindReview.reviewedAt) <= Date.parse(policy.createdAt));
  assert.ok(Date.parse(policy.createdAt) <= Date.parse(truth.createdAt));
  assert.ok(Date.parse(truth.createdAt) <= Date.parse(freeze.createdAt));
  for (const artifact of freeze.artifacts) {
    const bytes = await readFile(path.join(root, artifact.path));
    assert.equal(sha256(bytes), artifact.sha256, artifact.path);
  }
});
