import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowVector, LearnedRiskModel, VECTOR_KEYS } from '../core/learned.js';
import { measuredCoverage } from '../core/features.js';

const frames = (n, fn) => {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(fn(i / 15, i));
  return out;
};

test('vectorizer fixes key order, computes stats, and gates on span', () => {
  const window = frames(15, (t, i) => ({
    t,
    features: { torsoLean: 5 + i, lateralOffset: 0.4, hipDropSpeed: 0.1, kneeAsymmetry: 0.01 },
    coverage: measuredCoverage(),
  }));
  const vector = buildWindowVector(window);
  assert.deepEqual(vector.keys, VECTOR_KEYS);
  assert.equal(vector.values[0], 5 + 14); // leanMax
  assert.ok(Math.abs(vector.values[2] - 14 / (14 / 15)) < 1e-6); // leanRate ≈ 15 deg/s
  assert.ok(buildWindowVector(window.slice(0, 2)) === null, 'too short -> null');
});

test('coverage maps per source feature from the last frame', () => {
  const window = frames(15, (t, i) => ({
    t,
    features: { torsoLean: 10, lateralOffset: 0.5, hipDropSpeed: 0.1, kneeAsymmetry: 0.01 },
    coverage: {
      torsoLean: 'measured',
      lateralOffset: 'proxy',
      hipDropSpeed: 'unavailable',
      kneeAsymmetry: 'unavailable',
    },
  }));
  const vector = buildWindowVector(window);
  assert.equal(vector.coverage.leanMax, 'measured');
  assert.equal(vector.coverage.offsetMax, 'proxy');
  assert.equal(vector.coverage.dropMax, 'unavailable');
  assert.equal(vector.coverage.asymMax, 'unavailable');
});

test('model scoring is monotonic and coverage-aware', () => {
  const artifact = {
    weights: new Array(VECTOR_KEYS.length).fill(1),
    bias: -2,
    mean: new Array(VECTOR_KEYS.length).fill(0),
    std: new Array(VECTOR_KEYS.length).fill(1),
    threshold: 0.5,
  };
  const model = LearnedRiskModel.fromArtifact(artifact);
  const covered = (coverage) => ({ values: VECTOR_KEYS.map((_, i) => (i < 3 ? 3 : 2)), coverage });

  const quiet = { values: VECTOR_KEYS.map(() => 0.1), coverage: {} };
  const danger = covered(Object.fromEntries(VECTOR_KEYS.map((key) => [key, 'measured'])));
  const quietScore = model.score(quiet).score;
  const dangerScore = model.score(danger).score;
  assert.ok(dangerScore > quietScore, `${dangerScore} > ${quietScore}`);
  assert.ok(dangerScore > 90);

  const leanOnly = covered({
    leanMax: 'measured',
    leanMean: 'measured',
    leanRate: 'measured',
    offsetMax: 'unavailable',
    dropMax: 'unavailable',
    dropMean: 'unavailable',
    asymMax: 'unavailable',
  });
  const leanOnlyScore = model.score(leanOnly).score;
  assert.ok(Number.isFinite(leanOnlyScore));
  // Compare probabilities: rounded scores can both saturate at 100.
  assert.ok(
    model.score(leanOnly).probability < model.score(danger).probability,
    'unavailable features contribute neutrally'
  );
  assert.ok(model.score(leanOnly).drivers.length >= 1);
  assert.ok(model.score(danger).drivers.some((driver) => typeof driver === 'string' && driver.length >= 3));
});

test('invalid artifact is rejected', () => {
  assert.throws(() => LearnedRiskModel.fromArtifact({ weights: [1] }));
  assert.throws(() => LearnedRiskModel.fromArtifact(null));
});

test('proxy coverage discounts contributions', () => {
  const artifact = {
    weights: new Array(VECTOR_KEYS.length).fill(1),
    bias: 0,
    mean: new Array(VECTOR_KEYS.length).fill(0),
    std: new Array(VECTOR_KEYS.length).fill(1),
  };
  const model = LearnedRiskModel.fromArtifact(artifact);
  const values = VECTOR_KEYS.map(() => 2);
  const measured = model.score({ values, coverage: Object.fromEntries(VECTOR_KEYS.map((key) => [key, 'measured'])) });
  const proxy = model.score({ values, coverage: Object.fromEntries(VECTOR_KEYS.map((key) => [key, 'proxy'])) });
  assert.ok(proxy.probability < measured.probability);
});
