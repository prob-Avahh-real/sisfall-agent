import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, RiskSmoother } from '../core/risk.js';
import { measuredCoverage } from '../core/features.js';

test('balanced posture is stable', () => {
  const result = assessRisk({ torsoLean: 4, lateralOffset: 0.2, hipDropSpeed: 0, kneeAsymmetry: 0.01 });
  assert.equal(result.level, 'stable');
  assert.ok(result.score < 20);
});

test('rapid leaning drop is dangerous', () => {
  const result = assessRisk({ torsoLean: 55, lateralOffset: 2.2, hipDropSpeed: 1, kneeAsymmetry: 0.2 });
  assert.equal(result.level, 'danger');
  assert.ok(result.score > 90);
});

test('environmental context raises risk', () => {
  const base = { torsoLean: 27, lateralOffset: 0.8, hipDropSpeed: 0.1, kneeAsymmetry: 0.02 };
  assert.ok(assessRisk(base, { obstacle: true }).score > assessRisk(base).score);
});

test('smoother prioritizes recent readings', () => {
  const s = new RiskSmoother(3);
  s.add(0);
  s.add(0);
  assert.equal(s.add(90), 45);
});

test('coverage: unavailable features drop out and weights renormalize', () => {
  const features = { torsoLean: 12, lateralOffset: 0.4, hipDropSpeed: 0.05, kneeAsymmetry: 0.02 };
  const imuCoverage = {
    torsoLean: 'measured',
    lateralOffset: 'proxy',
    hipDropSpeed: 'proxy',
    kneeAsymmetry: 'unavailable',
  };
  const mixed = assessRisk(features, { coverage: imuCoverage });
  const none = assessRisk(features, { coverage: {} });
  assert.ok(Number.isFinite(mixed.score) && Number.isFinite(none.score));
  assert.equal(none.score, 0); // nothing observable, no environment
  assert.equal(mixed.coverage.kneeAsymmetry, 'unavailable');
  assert.ok(mixed.score > 0);
});

test('drivers name the dominant pressures', () => {
  const result = assessRisk({ torsoLean: 55, lateralOffset: 0, hipDropSpeed: 0, kneeAsymmetry: 0 });
  assert.ok(result.drivers[0].includes('躯干前倾'));
});

test('measured coverage keeps the original score scale', () => {
  const features = { torsoLean: 55, lateralOffset: 2.2, hipDropSpeed: 1, kneeAsymmetry: 0.2 };
  const result = assessRisk(features, { coverage: measuredCoverage() });
  assert.equal(result.score, 100);
});
