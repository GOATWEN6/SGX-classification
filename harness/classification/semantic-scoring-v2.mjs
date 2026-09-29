import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const SCORER_VERSION = 'sgx-semantic-scorer.2.0.0';

const SEMANTIC_CLASSES = [
  'required_core',
  'acceptable_variant',
  'supported_extra',
  'missing_required',
  'unsupported_extra',
  'unsafe_false_positive',
  'conflict_incomplete',
];

const WORKFLOW_STATUSES = ['succeeded', 'needs_review', 'failed', 'not_run'];
const WORKFLOW_ASSESSMENTS = ['matches_truth', 'status_mismatch', 'execution_failed', 'not_run'];

export class SemanticScoringError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'SemanticScoringError';
    this.code = code;
    this.details = details;
  }
}

export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const clone = value => JSON.parse(JSON.stringify(value));
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sorted = values => [...values].sort(lexical);
const normalizeValue = value => value.normalize('NFKC').trim().toLowerCase();
const sameValue = (left, right) => normalizeValue(left) === normalizeValue(right);
const intersects = (left, right) => left.some(value => right.includes(value));

function invariant(condition, code, details = {}) {
  if (!condition) throw new SemanticScoringError(code, details);
}

function failClosed(code, operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SemanticScoringError) throw error;
    throw new SemanticScoringError(code);
  }
}

function safeClone(value, code) {
  return failClosed(code, () => clone(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function timeShapeKey(value) {
  return value.facet === 'time' ? `${value.timeRole ?? ''}:${value.precision ?? ''}` : '';
}

function semanticValueKeys(assertion) {
  return [assertion.value, ...(assertion.aliases ?? [])]
    .map(value => `${assertion.facet}:${timeShapeKey(assertion)}:${normalizeValue(value)}`);
}

function validatePolicy(policy) {
  invariant(policy?.schemaVersion === 'sgx-scoring-policy.2', 'UNSUPPORTED_POLICY_VERSION');
  invariant(policy.aggregateScore === null, 'AGGREGATE_SCORE_MUST_BE_NULL');
  invariant(Array.isArray(policy.semanticClasses)
    && SEMANTIC_CLASSES.every(entry => policy.semanticClasses.includes(entry))
    && policy.semanticClasses.length === SEMANTIC_CLASSES.length, 'INVALID_SEMANTIC_CLASSES');
  invariant(policy.gates?.functional?.status === 'pending_real_data_calibration'
    && policy.gates.functional.numericPassThreshold === null, 'FUNCTIONAL_GATE_NOT_PENDING');
  invariant(policy.gates?.safety?.blockingClass === 'unsafe_false_positive'
    && policy.gates.safety.maximumAllowed === 0, 'INVALID_SAFETY_GATE');
  invariant(policy.riskPolicy?.unsupportedLowImpactClass === 'unsupported_extra', 'INVALID_RISK_CLASS', {
    field: 'unsupportedLowImpactClass',
  });
  invariant(policy.riskPolicy?.unsupportedHighImpactClass === 'unsafe_false_positive', 'INVALID_RISK_CLASS', {
    field: 'unsupportedHighImpactClass',
  });
  invariant(policy.conflictPolicy?.incompleteClass === 'conflict_incomplete', 'INVALID_CONFLICT_CLASS');
  for (const field of [
    'provenanceValidationPrecedesSemanticMatch',
    'sourceRefsMustIntersectTruth',
    'atLeastOneEvidenceKindMustMatchTruthAuthority',
    'allEvidenceKindsMustBeAllowed',
    'invalidProvenanceCannotSatisfyTruth',
  ]) {
    invariant(policy.matchPolicy?.[field] === true, 'UNSUPPORTED_MATCH_POLICY', { field });
  }
}

function validateTruth(policy, truth) {
  invariant(truth?.schemaVersion === 'sgx-truth.2', 'UNSUPPORTED_TRUTH_VERSION');
  invariant(truth.taxonomyVersion === policy.taxonomyVersion, 'TAXONOMY_VERSION_MISMATCH');
  invariant(truth.scoringPolicy?.policyId === policy.policyId, 'POLICY_ID_MISMATCH');

  const itemIds = new Set();
  const assertionIds = new Set();
  const variantIds = new Set();
  const conflictIds = new Set();
  const observationIds = new Set();
  for (const item of truth.items ?? []) {
    invariant(!itemIds.has(item.itemId), 'DUPLICATE_TRUTH_ITEM', { itemId: item.itemId });
    itemIds.add(item.itemId);
    invariant(item.decisionStatus === 'decided', 'UNDECIDED_TRUTH_ITEM', { itemId: item.itemId });
    invariant(WORKFLOW_STATUSES.includes(item.expectedWorkflowStatus), 'INVALID_EXPECTED_WORKFLOW_STATUS', { itemId: item.itemId });

    const requiredIds = new Set();
    const matchOwners = new Map();
    for (const assertion of item.requiredCore ?? []) {
      invariant(!assertionIds.has(assertion.assertionId), 'DUPLICATE_TRUTH_ASSERTION_ID', {
        assertionId: assertion.assertionId,
      });
      assertionIds.add(assertion.assertionId);
      requiredIds.add(assertion.assertionId);
      for (const key of semanticValueKeys(assertion)) {
        const owner = matchOwners.get(key);
        invariant(!owner || owner.assertionId === assertion.assertionId, 'AMBIGUOUS_SEMANTIC_MATCH', {
          itemId: item.itemId, assertionIds: sorted([owner?.assertionId, assertion.assertionId].filter(Boolean)),
        });
        matchOwners.set(key, { assertionId: assertion.assertionId, lane: 'required' });
      }
    }
    const variantKeys = new Set();
    for (const variant of item.acceptableVariants ?? []) {
      invariant(!variantIds.has(variant.variantId), 'DUPLICATE_VARIANT_ID', { variantId: variant.variantId });
      variantIds.add(variant.variantId);
      invariant(requiredIds.has(variant.satisfiesAssertionId), 'UNKNOWN_VARIANT_TARGET', { variantId: variant.variantId });
      const target = item.requiredCore.find(assertion => assertion.assertionId === variant.satisfiesAssertionId);
      invariant(variant.facet === target.facet
        && (variant.facet !== 'time'
          || (variant.timeRole === target.timeRole && policy.timePrecisionPolicy.scoredPrecisions.includes(variant.precision))),
      'INVALID_VARIANT_SHAPE', { variantId: variant.variantId });
      for (const value of variant.values) {
        const key = `${variant.facet}:${timeShapeKey(variant)}:${normalizeValue(value)}`;
        const owner = matchOwners.get(key);
        invariant(!owner, 'AMBIGUOUS_TRUTH_LANE', {
          itemId: item.itemId, lanes: sorted([owner?.lane, 'variant'].filter(Boolean)),
        });
        invariant(!variantKeys.has(key), 'AMBIGUOUS_TRUTH_LANE', { itemId: item.itemId, lanes: ['variant'] });
        variantKeys.add(key);
        matchOwners.set(key, { assertionId: target.assertionId, lane: 'variant' });
      }
    }
    for (const assertion of item.supportedExtras ?? []) {
      invariant(!assertionIds.has(assertion.assertionId), 'DUPLICATE_TRUTH_ASSERTION_ID', {
        assertionId: assertion.assertionId,
      });
      assertionIds.add(assertion.assertionId);
      for (const key of semanticValueKeys(assertion)) {
        invariant(!matchOwners.has(key), 'AMBIGUOUS_TRUTH_LANE', {
          itemId: item.itemId, lanes: sorted([matchOwners.get(key)?.lane, 'supported'].filter(Boolean)),
        });
        matchOwners.set(key, { assertionId: assertion.assertionId, lane: 'supported' });
      }
    }
    for (const forbidden of item.forbiddenAssertions ?? []) {
      invariant(!assertionIds.has(forbidden.assertionId), 'DUPLICATE_TRUTH_ASSERTION_ID', {
        assertionId: forbidden.assertionId,
      });
      assertionIds.add(forbidden.assertionId);
      invariant(['unsupported_extra', 'unsafe_false_positive'].includes(forbidden.riskClass), 'INVALID_RISK_CLASS', {
        assertionId: forbidden.assertionId,
      });
      if (forbidden.match.kind !== 'exact_value') continue;
      const shape = forbidden.facet === 'time'
        ? `${forbidden.match.timeRole}:${forbidden.match.precision}`
        : '';
      const key = `${forbidden.facet}:${shape}:${normalizeValue(forbidden.match.value)}`;
      invariant(!matchOwners.has(key), 'AMBIGUOUS_FORBIDDEN_MATCH', {
        itemId: item.itemId, forbiddenAssertionId: forbidden.assertionId,
      });
    }

    const conflictFacets = new Set();
    for (const conflict of item.conflicts ?? []) {
      invariant(!conflictIds.has(conflict.conflictId), 'DUPLICATE_CONFLICT_ID', { conflictId: conflict.conflictId });
      conflictIds.add(conflict.conflictId);
      invariant(!conflictFacets.has(conflict.facet), 'MULTIPLE_CONFLICTS_PER_FACET', {
        itemId: item.itemId, facet: conflict.facet,
      });
      conflictFacets.add(conflict.facet);
      invariant(conflict.resolution === 'unresolved', 'RESOLVED_CONFLICT_NOT_SCORABLE', {
        itemId: item.itemId, conflictId: conflict.conflictId,
      });
      const candidates = new Set();
      for (const candidate of conflict.candidates ?? []) {
        const key = `${normalizeValue(candidate.value)}:${candidate.timeRole ?? ''}:${candidate.precision ?? ''}`;
        invariant(!candidates.has(key), 'DUPLICATE_CONFLICT_CANDIDATE', { conflictId: conflict.conflictId });
        candidates.add(key);
        const semanticKey = `${conflict.facet}:${timeShapeKey({ ...candidate, facet: conflict.facet })}:${normalizeValue(candidate.value)}`;
        invariant(!matchOwners.has(semanticKey), 'AMBIGUOUS_TRUTH_LANE', {
          itemId: item.itemId, lanes: sorted([matchOwners.get(semanticKey)?.lane, 'conflict'].filter(Boolean)),
        });
        matchOwners.set(semanticKey, { assertionId: conflict.conflictId, lane: 'conflict' });
      }
      invariant(candidates.size >= policy.conflictPolicy.minimumCandidates, 'INSUFFICIENT_CONFLICT_CANDIDATES', {
        conflictId: conflict.conflictId,
      });
      if (conflict.facet === 'time' && policy.conflictPolicy.sameTimeRoleWithinConflict) {
        invariant(new Set(conflict.candidates.map(candidate => candidate.timeRole)).size === 1,
          'MIXED_TIME_ROLES_IN_CONFLICT', { conflictId: conflict.conflictId });
      }
    }
    const observationKeys = new Set();
    for (const observation of item.observations ?? []) {
      invariant(!observationIds.has(observation.observationId), 'DUPLICATE_TRUTH_OBSERVATION_ID', {
        observationId: observation.observationId,
      });
      observationIds.add(observation.observationId);
      const key = [
        observation.facet,
        observation.kind,
        observation.role,
        observation.precision,
        normalizeValue(observation.normalizedValue),
      ].join(':');
      invariant(!observationKeys.has(key), 'DUPLICATE_TRUTH_OBSERVATION', {
        itemId: item.itemId, observationId: observation.observationId,
      });
      observationKeys.add(key);
    }
  }
}

export function createScoringContext({
  policy,
  truth,
  policyBytes,
  truthBytes,
  scorerBytes,
  expectedPolicySha256,
  expectedTruthSha256,
}) {
  return failClosed('MALFORMED_SCORING_CONTEXT', () => {
    invariant(policyBytes !== undefined && truthBytes !== undefined, 'RAW_BYTES_REQUIRED');
    invariant(scorerBytes !== undefined, 'SCORER_BYTES_REQUIRED');
    const policySha256 = sha256Bytes(policyBytes);
    const truthSha256 = sha256Bytes(truthBytes);
    const scorerSha256 = sha256Bytes(scorerBytes);
    validatePolicy(policy);
    invariant(truth?.scoringPolicy?.sha256 === policySha256, 'POLICY_HASH_MISMATCH');
    if (expectedPolicySha256 !== undefined) {
      invariant(expectedPolicySha256 === policySha256, 'POLICY_HASH_MISMATCH');
    }
    if (expectedTruthSha256 !== undefined) {
      invariant(expectedTruthSha256 === truthSha256, 'TRUTH_HASH_MISMATCH');
    }
    validateTruth(policy, truth);
    const context = {
      policy: safeClone(policy, 'MALFORMED_SCORING_CONTEXT'),
      truth: safeClone(truth, 'MALFORMED_SCORING_CONTEXT'),
      policySha256,
      truthSha256,
      scorerSha256,
    };
    return deepFreeze(context);
  });
}

function hasSameTimeShape(left, right) {
  return left.facet !== 'time'
    || (left.timeRole === right.timeRole && left.precision === right.precision);
}

function matchesAssertion(prediction, assertion) {
  return prediction.facet === assertion.facet
    && hasSameTimeShape(prediction, assertion)
    && [assertion.value, ...(assertion.aliases ?? [])].some(value => sameValue(prediction.value, value));
}

function matchesVariant(prediction, variant) {
  return prediction.facet === variant.facet
    && hasSameTimeShape(prediction, variant)
    && variant.values.some(value => sameValue(prediction.value, value));
}

function oneMatch(matches, itemId, predictionId) {
  invariant(matches.length <= 1, 'AMBIGUOUS_SEMANTIC_MATCH', { itemId, predictionId });
  return matches[0] ?? null;
}

function findSemanticMatch(prediction, truthItem, policy) {
  const required = oneMatch(
    truthItem.requiredCore.filter(assertion =>
      matchesAssertion(prediction, assertion) && hasValidProvenance(prediction, assertion, policy)),
    truthItem.itemId,
    prediction.predictionId,
  );
  if (required) return { class: 'required_core', assertion: required };

  const variants = truthItem.acceptableVariants.filter(variant => {
    if (!matchesVariant(prediction, variant)) return false;
    const target = truthItem.requiredCore.find(entry => entry.assertionId === variant.satisfiesAssertionId);
    return target && hasValidProvenance(prediction, target, policy);
  });
  const variant = oneMatch(variants, truthItem.itemId, prediction.predictionId);
  if (variant) {
    const assertion = truthItem.requiredCore.find(entry => entry.assertionId === variant.satisfiesAssertionId);
    invariant(assertion, 'UNKNOWN_VARIANT_TARGET', { variantId: variant.variantId });
    return { class: 'acceptable_variant', assertion };
  }

  const supported = oneMatch(
    truthItem.supportedExtras.filter(assertion =>
      matchesAssertion(prediction, assertion) && hasValidProvenance(prediction, assertion, policy)),
    truthItem.itemId,
    prediction.predictionId,
  );
  return supported ? { class: 'supported_extra', assertion: supported } : null;
}

function hasValidProvenance(prediction, assertion, policy) {
  const sourceRefMatch = intersects(prediction.sourceRefs, assertion.sourceRefs);
  const authorityKinds = policy.truthAuthorityEvidenceKinds[assertion.authority] ?? [];
  const authorityMatch = prediction.evidenceKinds.some(kind => authorityKinds.includes(kind));
  const allKindsAllowedByAuthority = prediction.evidenceKinds.every(kind => authorityKinds.includes(kind));
  const roleRule = prediction.facet === 'time' ? policy.timeRoles[prediction.timeRole] : null;
  const roleMatch = !roleRule
    || prediction.evidenceKinds.every(kind => roleRule.allowedEvidenceKinds.includes(kind));
  return sourceRefMatch && authorityMatch && allKindsAllowedByAuthority && roleMatch;
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
    || (prediction.facet === 'place'
      && prediction.placeKind === 'named'
      && policy.riskPolicy.unmatchedNamedPlaceIsHighImpact);
  return {
    class: highImpact
      ? policy.riskPolicy.unsupportedHighImpactClass
      : policy.riskPolicy.unsupportedLowImpactClass,
    forbidden: null,
  };
}

function predictionKey(prediction) {
  return [prediction.facet, prediction.timeRole ?? '', prediction.precision ?? '', normalizeValue(prediction.value)].join(':');
}

function validateRunInput(input, truthItem, policy) {
  invariant(input && typeof input === 'object', 'INVALID_SCORING_INPUT');
  invariant(WORKFLOW_STATUSES.includes(input.workflowStatus), 'UNKNOWN_WORKFLOW_STATUS');
  invariant(Array.isArray(input.predictions) && Array.isArray(input.conflicts) && Array.isArray(input.observations),
    'INVALID_SCORING_INPUT');
  if (['failed', 'not_run'].includes(input.workflowStatus)) {
    invariant(input.predictions.length === 0 && input.conflicts.length === 0 && input.observations.length === 0,
      'TERMINAL_RUN_HAS_OUTPUT', { workflowStatus: input.workflowStatus });
  }
  const predictionIds = new Set();
  const predictionKeys = new Set();
  const knownFacets = new Set([
    ...policy.capabilityPolicy.closedScoringFacets,
    ...policy.capabilityPolicy.safetyOnlyFacets,
    ...policy.capabilityPolicy.excludedFacets,
  ]);
  for (const prediction of input.predictions) {
    invariant(knownFacets.has(prediction.facet), 'UNKNOWN_FACET', { facet: prediction.facet });
    invariant(!policy.capabilityPolicy.excludedFacets.includes(prediction.facet), 'EXCLUDED_FACET_ENABLED', {
      facet: prediction.facet,
    });
    invariant(!predictionIds.has(prediction.predictionId), 'DUPLICATE_PREDICTION_ID', {
      predictionId: prediction.predictionId,
    });
    predictionIds.add(prediction.predictionId);
    const key = predictionKey(prediction);
    invariant(!predictionKeys.has(key), 'DUPLICATE_PREDICTION', { key });
    predictionKeys.add(key);
    invariant(typeof prediction.value === 'string' && prediction.value.length > 0, 'INVALID_PREDICTION');
    invariant(Array.isArray(prediction.sourceRefs) && prediction.sourceRefs.length > 0, 'INVALID_PREDICTION_PROVENANCE');
    invariant(Array.isArray(prediction.evidenceKinds) && prediction.evidenceKinds.length > 0,
      'INVALID_PREDICTION_PROVENANCE');
    if (prediction.facet === 'time') {
      invariant(policy.timeRoles[prediction.timeRole], 'UNKNOWN_TIME_ROLE', { timeRole: prediction.timeRole });
      invariant(policy.timePrecisionPolicy.scoredPrecisions.includes(prediction.precision), 'UNKNOWN_TIME_PRECISION', {
        precision: prediction.precision,
      });
    } else {
      invariant(prediction.timeRole === undefined && prediction.precision === undefined,
        'UNEXPECTED_TIME_SHAPE', { predictionId: prediction.predictionId });
    }
    if (prediction.facet === 'place') {
      invariant(['named', 'generic'].includes(prediction.placeKind), 'PLACE_KIND_REQUIRED', {
        predictionId: prediction.predictionId,
      });
    } else {
      invariant(prediction.placeKind === undefined, 'UNEXPECTED_PLACE_KIND', {
        predictionId: prediction.predictionId,
      });
    }
  }
  invariant(new Set(input.conflicts).size === input.conflicts.length, 'DUPLICATE_CONFLICT_FACET');
  for (const facet of input.conflicts) {
    invariant(policy.capabilityPolicy.closedScoringFacets.includes(facet), 'UNKNOWN_CONFLICT_FACET', { facet });
  }
  const observationIds = new Set();
  for (const observation of input.observations) {
    invariant(!observationIds.has(observation.observationId), 'DUPLICATE_OBSERVATION_ID', {
      observationId: observation.observationId,
    });
    observationIds.add(observation.observationId);
    invariant(observation.facet === 'time' && observation.role === 'role_unknown', 'INVALID_OBSERVATION');
    invariant(observation.evidenceKinds?.every(kind => policy.roleUnknownTimeObservations.evidenceKinds.includes(kind)),
      'INVALID_OBSERVATION_PROVENANCE');
  }
  invariant(truthItem.evaluation.closedFacets.every(facet => policy.capabilityPolicy.closedScoringFacets.includes(facet)),
    'TRUTH_CAPABILITY_MISMATCH', { itemId: truthItem.itemId });
}

function findConflictCandidate(prediction, truthItem, policy) {
  const matches = [];
  for (const conflict of truthItem.conflicts) {
    if (prediction.facet !== conflict.facet) continue;
    for (const candidate of conflict.candidates) {
      const candidateShape = { ...candidate, facet: conflict.facet };
      if (!sameValue(prediction.value, candidate.value) || !hasSameTimeShape(prediction, candidateShape)) continue;
      if (!hasValidProvenance(prediction, candidate, policy)) continue;
      matches.push({ conflict, candidate });
    }
  }
  invariant(matches.length <= 1, 'AMBIGUOUS_CONFLICT_CANDIDATE', { predictionId: prediction.predictionId });
  return matches[0] ?? null;
}

function deriveWorkflowAssessment(workflowStatus, truthItem, policy) {
  const outcomes = policy.denominatorPolicy.workflowAssessment;
  if (workflowStatus === 'failed') return outcomes.failedOutcome;
  if (workflowStatus === 'not_run') return outcomes.notRunOutcome;
  return workflowStatus === truthItem.expectedWorkflowStatus ? outcomes.matchOutcome : outcomes.mismatchOutcome;
}

function assessObservations(input, truthItem, policy) {
  const preserved = [];
  const matchedInputIds = new Set();
  for (const truthObservation of truthItem.observations) {
    const matches = input.observations.filter(observation =>
      observation.facet === truthObservation.facet
      && observation.kind === truthObservation.kind
      && sameValue(observation.rawValue, truthObservation.rawValue)
      && sameValue(observation.normalizedValue, truthObservation.normalizedValue)
      && observation.role === truthObservation.role
      && observation.precision === truthObservation.precision
      && intersects(observation.sourceRefs, truthObservation.sourceRefs)
      && observation.evidenceKinds.every(kind =>
        policy.roleUnknownTimeObservations.evidenceKinds.includes(kind)));
    invariant(matches.length <= 1, 'AMBIGUOUS_OBSERVATION', { observationId: truthObservation.observationId });
    if (matches.length === 1) {
      preserved.push(truthObservation.observationId);
      matchedInputIds.add(matches[0].observationId);
    }
  }
  invariant(matchedInputIds.size === input.observations.length, 'UNRECOGNIZED_OBSERVATION');
  return {
    preservedTruthObservationIds: sorted(preserved),
    missingTruthObservationIds: sorted(truthItem.observations
      .map(observation => observation.observationId)
      .filter(id => !preserved.includes(id))),
  };
}

function classificationComparator(left, right) {
  const leftSynthetic = left.predictionId ? 0 : 1;
  const rightSynthetic = right.predictionId ? 0 : 1;
  if (leftSynthetic !== rightSynthetic) return leftSynthetic - rightSynthetic;
  return lexical(
    [left.predictionId ?? '', left.class, left.conflictId ?? '', left.value ?? ''].join(':'),
    [right.predictionId ?? '', right.class, right.conflictId ?? '', right.value ?? ''].join(':'),
  );
}

function emptyCounts() {
  return Object.fromEntries(SEMANTIC_CLASSES.map(entry => [entry, 0]));
}

function scoreInputInternal(context, run) {
  const { policy, truth } = context;
  const truthItem = truth.items.find(item => item.itemId === run.truthItemId);
  invariant(truthItem, 'UNKNOWN_TRUTH_ITEM', { truthItemId: run.truthItemId });
  const input = safeClone(run.input, 'MALFORMED_SCORING_INPUT');
  validateRunInput(input, truthItem, policy);

  const classifications = [];
  const internalOutcomes = [];
  const satisfiedRequired = new Set();
  const creditedAssertionIds = new Set();
  const consumedByConflict = new Map();

  for (const prediction of input.predictions) {
    const conflictSide = findConflictCandidate(prediction, truthItem, policy);
    if (conflictSide) {
      const candidates = consumedByConflict.get(conflictSide.conflict.conflictId) ?? new Set();
      candidates.add(`${normalizeValue(conflictSide.candidate.value)}:${conflictSide.candidate.timeRole ?? ''}:${conflictSide.candidate.precision ?? ''}`);
      consumedByConflict.set(conflictSide.conflict.conflictId, candidates);
      internalOutcomes.push({ consumedPredictionId: prediction.predictionId, facet: conflictSide.conflict.facet });
      continue;
    }

    const semantic = findSemanticMatch(prediction, truthItem, policy);
    let outcome;
    if (semantic) {
      invariant(!creditedAssertionIds.has(semantic.assertion.assertionId), 'DUPLICATE_ASSERTION_CREDIT', {
        assertionId: semantic.assertion.assertionId,
        predictionId: prediction.predictionId,
      });
      creditedAssertionIds.add(semantic.assertion.assertionId);
      outcome = {
        predictionId: prediction.predictionId,
        class: semantic.class,
        satisfiesAssertionId: semantic.assertion.assertionId,
      };
      if (semantic.class === 'required_core' || semantic.class === 'acceptable_variant') {
        satisfiedRequired.add(semantic.assertion.assertionId);
      }
    } else {
      const risk = riskClass(prediction, truthItem, policy);
      outcome = { predictionId: prediction.predictionId, class: risk.class };
      if (risk.forbidden?.match.kind === 'exact_value') {
        outcome.matchesForbiddenAssertionId = risk.forbidden.assertionId;
      }
    }
    classifications.push(outcome);
    internalOutcomes.push({ class: outcome.class, facet: prediction.facet });
  }

  const reportedFacets = new Set(input.conflicts);
  const expectedFacets = new Set(truthItem.conflicts.map(conflict => conflict.facet));
  const incompleteConflictIds = [];
  for (const conflict of truthItem.conflicts) {
    const consumed = consumedByConflict.get(conflict.conflictId) ?? new Set();
    const expected = new Set(conflict.candidates.map(candidate =>
      `${normalizeValue(candidate.value)}:${candidate.timeRole ?? ''}:${candidate.precision ?? ''}`));
    const complete = reportedFacets.has(conflict.facet)
      && expected.size === consumed.size
      && [...expected].every(key => consumed.has(key));
    if (!complete) {
      incompleteConflictIds.push(conflict.conflictId);
      classifications.push({ class: policy.conflictPolicy.incompleteClass, conflictId: conflict.conflictId });
      internalOutcomes.push({ class: policy.conflictPolicy.incompleteClass, facet: conflict.facet });
    }
  }
  const unexpectedFacets = sorted([...reportedFacets].filter(facet => !expectedFacets.has(facet)));
  for (const facet of unexpectedFacets) {
    const forbidden = truthItem.forbiddenAssertions.find(entry =>
      entry.facet === facet && entry.match.kind === 'unexpected_conflict');
    const semanticClass = forbidden?.riskClass ?? policy.riskPolicy.unsupportedLowImpactClass;
    classifications.push({ class: semanticClass, value: `conflict:${facet}` });
    internalOutcomes.push({ class: semanticClass, facet });
  }

  let conflictStatus = 'none';
  if (truthItem.conflicts.length) conflictStatus = incompleteConflictIds.length ? 'incomplete' : 'complete';
  if (unexpectedFacets.length) {
    conflictStatus = truthItem.conflicts.length && !incompleteConflictIds.length
      ? 'complete_with_unsupported_cross_facet_extra'
      : 'unexpected';
  }

  const missingRequired = sorted(truthItem.requiredCore
    .filter(assertion => !satisfiedRequired.has(assertion.assertionId))
    .map(assertion => assertion.assertionId));
  for (const assertion of truthItem.requiredCore) {
    if (!satisfiedRequired.has(assertion.assertionId)) {
      internalOutcomes.push({ class: 'missing_required', facet: assertion.facet });
    }
  }

  const counts = emptyCounts();
  for (const outcome of internalOutcomes) {
    if (outcome.class) counts[outcome.class] += 1;
  }

  return {
    caseId: run.caseId ?? run.truthItemId,
    truthItemId: truthItem.itemId,
    workflowStatus: input.workflowStatus,
    expectedWorkflowStatus: truthItem.expectedWorkflowStatus,
    workflowAssessment: deriveWorkflowAssessment(input.workflowStatus, truthItem, policy),
    includedInFixedDenominator: true,
    classifications: classifications.sort(classificationComparator),
    missingRequiredAssertionIds: missingRequired,
    observationAssessment: assessObservations(input, truthItem, policy),
    conflictAssessment: {
      status: conflictStatus,
      incompleteConflictIds: sorted(incompleteConflictIds),
      unexpectedFacets,
      consumedPredictionIds: sorted(internalOutcomes
        .filter(outcome => outcome.consumedPredictionId)
        .map(outcome => outcome.consumedPredictionId)),
    },
    countsBySemanticClass: counts,
    aggregateScore: null,
    _outcomes: internalOutcomes,
  };
}

export function scoreInput(context, run) {
  return failClosed('MALFORMED_SCORING_INPUT', () => {
    const scored = scoreInputInternal(context, safeClone(run, 'MALFORMED_SCORING_INPUT'));
    delete scored._outcomes;
    return scored;
  });
}

function oracleView(result) {
  return {
    classifications: result.classifications,
    missingRequiredAssertionIds: result.missingRequiredAssertionIds,
    conflictStatus: result.conflictAssessment.status,
    workflowAssessment: result.workflowAssessment,
    includedInFixedDenominator: result.includedInFixedDenominator,
    observationAssessment: result.observationAssessment,
  };
}

export function scoreCasesFixture(context, fixture, { casesBytes } = {}) {
  return failClosed('MALFORMED_CASES_FIXTURE', () => {
    invariant(casesBytes !== undefined, 'CASES_BYTES_REQUIRED');
    let parsedBytes;
    try {
      parsedBytes = JSON.parse(Buffer.from(casesBytes).toString('utf8'));
    } catch {
      throw new SemanticScoringError('INVALID_CASES_BYTES');
    }
    invariant(isDeepStrictEqual(parsedBytes, fixture), 'CASES_BYTES_MISMATCH');
    const casesSha256 = sha256Bytes(casesBytes);
    const cases = safeClone(fixture, 'MALFORMED_CASES_FIXTURE');
    invariant(cases.schemaVersion === 'sgx-semantic-scoring-cases.2', 'UNSUPPORTED_CASES_VERSION');
    invariant(cases.policySha256 === context.policySha256, 'POLICY_HASH_MISMATCH');
    invariant(cases.truthSha256 === context.truthSha256, 'TRUTH_HASH_MISMATCH');

    const reports = [];
    const counts = emptyCounts();
    const workflowStatuses = Object.fromEntries(WORKFLOW_STATUSES.map(status => [status, 0]));
    const workflowAssessments = Object.fromEntries(WORKFLOW_ASSESSMENTS.map(status => [status, 0]));
    const facets = sorted([
      ...context.policy.capabilityPolicy.closedScoringFacets,
      ...context.policy.capabilityPolicy.safetyOnlyFacets,
    ]);
    const perFacet = new Map(facets.map(facet => [facet, emptyCounts()]));

    for (const entry of cases.cases) {
      const result = scoreInputInternal(context, {
        caseId: entry.caseId,
        truthItemId: entry.truthItemId,
        input: entry.input,
      });
      invariant(isDeepStrictEqual(oracleView(result), entry.expected), 'ORACLE_MISMATCH', { caseId: entry.caseId });
      for (const semanticClass of SEMANTIC_CLASSES) counts[semanticClass] += result.countsBySemanticClass[semanticClass];
      workflowStatuses[result.workflowStatus] += 1;
      workflowAssessments[result.workflowAssessment] += 1;
      for (const outcome of result._outcomes) {
        if (outcome.class) perFacet.get(outcome.facet)[outcome.class] += 1;
      }
      delete result._outcomes;
      reports.push(result);
    }

    return {
      schemaVersion: 'sgx-semantic-score-report.2',
      scorerVersion: SCORER_VERSION,
      claimBoundary: 'offline_contract_fixture_only',
      taxonomyVersion: context.policy.taxonomyVersion,
      policyRef: { policyId: context.policy.policyId, sha256: context.policySha256 },
      truthRef: { truthId: context.truth.truthId, sha256: context.truthSha256 },
      casesRef: { schemaVersion: cases.schemaVersion, sha256: casesSha256 },
      scorerRef: { version: SCORER_VERSION, sourceSha256: context.scorerSha256 },
      aggregateScore: null,
      functionalGate: {
        status: context.policy.gates.functional.status,
        numericPassThreshold: null,
      },
      safetyGate: {
        status: 'not_applicable_oracle_fixture',
        blockingClass: context.policy.gates.safety.blockingClass,
        maximumAllowed: context.policy.gates.safety.maximumAllowed,
        actual: null,
        passed: null,
      },
      fixedDenominator: {
        total: reports.length,
        included: reports.filter(report => report.includedInFixedDenominator).length,
        byWorkflowStatus: workflowStatuses,
        byWorkflowAssessment: workflowAssessments,
      },
      countsBySemanticClass: counts,
      perFacetBreakdown: facets.map(facet => ({ facet, countsBySemanticClass: perFacet.get(facet) })),
      workflowStatuses,
      oracle: { total: reports.length, passed: reports.length, failed: 0 },
      cases: reports,
    };
  });
}
