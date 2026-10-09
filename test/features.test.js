import test from 'node:test';
import assert from 'node:assert/strict';
import { angleFromVertical, normalizeCoverage, measuredCoverage, FEATURE_KEYS, clamp01 } from '../core/features.js';

test('angleFromVertical measures lean from straight up', () => {
  assert.equal(angleFromVertical({ x: 0, y: 0 }, { x: 0, y: -1 }), 0);
  const lean = angleFromVertical({ x: 0, y: 0 }, { x: 0.5, y: -0.5 });
  assert.ok(Math.abs(lean - 45) < 1e-9);
});

test('normalizeCoverage fills missing keys and rejects unknown values', () => {
  const coverage = normalizeCoverage({ torsoLean: 'measured', lateralOffset: 'proxy', hipDropSpeed: 'bogus' });
  assert.equal(coverage.torsoLean, 'measured');
  assert.equal(coverage.lateralOffset, 'proxy');
  assert.equal(coverage.hipDropSpeed, 'unavailable');
  assert.equal(coverage.kneeAsymmetry, 'unavailable');
});

test('measuredCoverage covers every canonical key', () => {
  const coverage = measuredCoverage();
  for (const key of FEATURE_KEYS) assert.equal(coverage[key], 'measured');
});

test('clamp01 bounds values', () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(0.4), 0.4);
  assert.equal(clamp01(9), 1);
});
