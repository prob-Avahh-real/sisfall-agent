import test from 'node:test';
import assert from 'node:assert/strict';
import { poseObservation } from '../sources/pose.js';
import { FEATURE_KEYS } from '../core/features.js';

// Minimal 33-landmark fixture with the joints poseObservation reads.
function landmarks({ shoulderDx = 0, ankleDx = 0, kneeDy = 0, hipY = 0.55 } = {}) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));
  pts[11] = { x: -0.08 + shoulderDx, y: 0.3 }; // shoulders
  pts[12] = { x: 0.08 + shoulderDx, y: 0.3 };
  pts[23] = { x: -0.05, y: hipY }; // hips
  pts[24] = { x: 0.05, y: hipY };
  pts[25] = { x: -0.05, y: 0.72 }; // knees
  pts[26] = { x: 0.05, y: 0.72 + kneeDy };
  pts[27] = { x: -0.05 + ankleDx, y: 0.95 }; // ankles
  pts[28] = { x: 0.05 + ankleDx, y: 0.95 };
  return pts;
}

test('upright neutral stance: zero lean, centered mass, full measured coverage', () => {
  const obs = poseObservation(landmarks(), null, 1 / 15, 0);
  assert.ok(obs.features.torsoLean < 1e-9);
  assert.ok(obs.features.lateralOffset < 1e-9);
  assert.equal(obs.features.hipDropSpeed, 0); // no previous frame
  assert.equal(obs.features.kneeAsymmetry, 0);
  for (const key of FEATURE_KEYS) assert.equal(obs.coverage[key], 'measured');
});

test('shoulder shift registers as lean and lateral offset', () => {
  const obs = poseObservation(landmarks({ shoulderDx: 0.15 }), null, 1 / 15, 0);
  const expected = (Math.atan2(0.15, 0.25) * 180) / Math.PI;
  assert.ok(Math.abs(obs.features.torsoLean - expected) < 1e-6, `lean ${obs.features.torsoLean}`);
  assert.ok(Math.abs(obs.features.lateralOffset - 1.5) < 1e-9, `offset ${obs.features.lateralOffset}`); // 0.15 / 0.10 stance
});

test('hip drop speed derives from consecutive frames with dt', () => {
  const prev = { hips: { x: 0, y: 0.55 } };
  const obs = poseObservation(landmarks({ hipY: 0.65 }), prev, 0.5, 1);
  assert.ok(Math.abs(obs.features.hipDropSpeed - 0.2) < 1e-9); // 0.10 over 0.5s
});

test('knee asymmetry reads the vertical offset between knees', () => {
  const obs = poseObservation(landmarks({ kneeDy: 0.05 }), null, 1 / 15, 0);
  assert.ok(Math.abs(obs.features.kneeAsymmetry - 0.05) < 1e-9);
});

test('debug payload carries the hips midpoint for chaining frames', () => {
  const obs = poseObservation(landmarks({ hipY: 0.6 }), null, 1 / 15, 0);
  assert.ok(Math.abs(obs.debug.hips.y - 0.6) < 1e-9);
  assert.ok(Math.abs(obs.debug.hips.x) < 1e-9);
});
