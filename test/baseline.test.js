import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalBaseline } from '../core/baseline.js';
import { DEFAULT_CONFIG } from '../core/config.js';

const walkFrame = (i, { mean = 8, amp = 2 } = {}) => ({
  torsoLean: mean + amp * Math.sin(i / 5),
  lateralOffset: 0.4,
  hipDropSpeed: 0.05,
  kneeAsymmetry: 0.02,
});

test('warms up, then reports the personal normal', () => {
  const b = new PersonalBaseline();
  for (let i = 0; i < DEFAULT_CONFIG.baseline.warmupFrames; i += 1) b.update(walkFrame(i));
  assert.equal(b.warm, true);
  assert.ok(b.progress >= 1);
  assert.ok(Math.abs(b.mean.torsoLean - 8) < 0.6);
  const dev = b.deviation(walkFrame(500));
  assert.equal(dev.level, 'normal');
});

test('sustained shift away from the personal normal is flagged', () => {
  const b = new PersonalBaseline();
  for (let i = 0; i < 120; i += 1) b.update(walkFrame(i));
  let dev = null;
  const shifted = { torsoLean: 20, lateralOffset: 0.4, hipDropSpeed: 0.05, kneeAsymmetry: 0.02 };
  for (let i = 0; i < 60; i += 1) {
    b.update(shifted);
    dev = b.deviation(shifted);
  }
  assert.equal(dev.level, 'outside');
  assert.ok(dev.top.includes('torsoLean'));
});

test('a single noisy frame does not flag', () => {
  const b = new PersonalBaseline();
  for (let i = 0; i < 120; i += 1) b.update(walkFrame(i));
  const spike = { torsoLean: 40, lateralOffset: 0.4, hipDropSpeed: 0.05, kneeAsymmetry: 0.02 };
  assert.equal(b.deviation(spike).level, 'normal');
});

test('learning state before warmup', () => {
  const b = new PersonalBaseline();
  b.update(walkFrame(0));
  assert.equal(b.deviation(walkFrame(1)).level, 'learning');
  assert.equal(b.warm, false);
});

test('reset clears the learned normal', () => {
  const b = new PersonalBaseline();
  for (let i = 0; i < 120; i += 1) b.update(walkFrame(i));
  b.reset();
  assert.equal(b.warm, false);
  assert.equal(b.n, 0);
});
