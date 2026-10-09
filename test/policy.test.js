import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyState, decidePolicy } from '../core/policy.js';
import { DEFAULT_CONFIG } from '../core/config.js';

const warmBaseline = { warm: true, progress: 1, deviation: { level: 'normal', score: 0, z: {}, top: [] } };
const riskAt = (score, level) => ({ score, level, drivers: [], coverage: {} });
const stableForecast = {
  slope: 0,
  confidence: 0,
  timeToDangerSec: null,
  instability: 0,
  imminent: false,
  projectedLevel: 'stable',
  drivers: [],
};
const imminentForecast = { ...stableForecast, imminent: true, projectedLevel: 'imminent', timeToDangerSec: 1 };

const decide = (policy, input) =>
  decidePolicy(policy, { now: 0, risk: riskAt(10, 'stable'), forecast: stableForecast, baseline: warmBaseline, ...input }, DEFAULT_CONFIG);

test('cold baseline keeps the agent calibrating, no actions', () => {
  const out = decide(createPolicyState(0), {
    risk: riskAt(80, 'danger'),
    forecast: imminentForecast,
    baseline: { warm: false, progress: 0.3, deviation: { level: 'learning', score: 0, z: {}, top: [] } },
  });
  assert.equal(out.state, 'calibrating');
  assert.equal(out.actions.length, 0);
});

test('forecast imminent enters the imminent state with instruction and audio', () => {
  const out = decide(createPolicyState(0), { now: 5, risk: riskAt(30, 'stable'), forecast: imminentForecast });
  assert.equal(out.state, 'imminent');
  assert.equal(out.transition.to, 'imminent');
  const kinds = out.actions.map((a) => a.kind);
  assert.ok(kinds.includes('audio') && kinds.includes('instruction'));
});

test('hysteresis holds danger until clearly below the exit line, then recovers', () => {
  let out = decide(createPolicyState(0), { now: 1, risk: riskAt(75, 'danger') });
  assert.equal(out.state, 'danger');

  out = decide(out.policy, { now: 1.2, risk: riskAt(66, 'caution') });
  assert.equal(out.state, 'danger'); // 66 > dangerExit(64): hold
  assert.equal(out.transition, null);

  out = decide(out.policy, { now: 3, risk: riskAt(60, 'caution') });
  assert.equal(out.state, 'recovering');
  assert.ok(out.actions.some((a) => a.kind === 'visual'));

  out = decide(out.policy, { now: 3.5, risk: riskAt(50, 'caution') });
  assert.equal(out.state, 'recovering'); // held for recoverHoldSec

  out = decide(out.policy, { now: 6, risk: riskAt(50, 'caution') });
  assert.equal(out.state, 'caution');
});

test('persisting danger is edge-triggered with reminder cadence and audio cooldown', () => {
  let out = decide(createPolicyState(0), { now: 0, risk: riskAt(80, 'danger') });
  assert.equal(out.actions.length, 2); // instruction + audio on entry

  out = decide(out.policy, { now: 1, risk: riskAt(80, 'danger') });
  assert.equal(out.actions.length, 0); // no repeat while persisting

  out = decide(out.policy, { now: 6.1, risk: riskAt(80, 'danger') });
  assert.ok(out.actions.some((a) => a.kind === 'audio'));
  assert.ok(out.actions.some((a) => a.kind === 'instruction'));
});

test('trend caution nudges without sound', () => {
  const rising = { ...stableForecast, projectedLevel: 'caution', slope: 14, confidence: 0.8 };
  const out = decide(createPolicyState(0), { risk: riskAt(28, 'stable'), forecast: rising });
  assert.equal(out.state, 'caution');
  assert.ok(out.actions.some((a) => a.kind === 'instruction'));
  assert.ok(out.actions.every((a) => a.kind !== 'audio'));
});

test('symptom-boosted caution names the symptom', () => {
  const symptoms = { boost: 20, top: 'dizziness', topLabel: 'Dizziness', active: [] };
  const out = decide(createPolicyState(0), { risk: riskAt(45, 'caution'), symptoms });
  assert.equal(out.state, 'caution');
  assert.ok(out.actions.some((a) => (a.reason ?? '').includes('症状背景')));
  assert.ok(out.actions.some((a) => a.text.includes('发晕')));
});

test('unusual-for-you deviation nudges at a modest absolute score', () => {
  const devBaseline = { warm: true, progress: 1, deviation: { level: 'outside', score: 0.6, z: {}, top: ['torsoLean'] } };
  const out = decide(createPolicyState(0), { risk: riskAt(18, 'stable'), baseline: devBaseline });
  assert.equal(out.state, 'caution');
  assert.ok(out.actions.some((a) => a.reason === '与您平时不同'));

  const low = decide(createPolicyState(0), { risk: riskAt(5, 'stable'), baseline: devBaseline });
  assert.equal(low.state, 'stable');
});

test('training mode defers caution cues but never imminent or danger', () => {
  const out = decide(createPolicyState(0), {
    risk: riskAt(45, 'caution'),
    training: { active: true, exercise: '单腿站立' },
  });
  assert.equal(out.state, 'caution');
  assert.ok(out.actions.some((a) => a.kind === 'note'));
  assert.ok(out.actions.every((a) => a.kind !== 'instruction'));

  const acute = decide(createPolicyState(0), {
    risk: riskAt(60, 'caution'),
    forecast: imminentForecast,
    training: { active: true, exercise: '单腿站立' },
  });
  assert.equal(acute.state, 'imminent');
  assert.ok(acute.actions.some((a) => a.kind === 'instruction'));
  assert.ok(acute.actions.some((a) => a.kind === 'audio'));
});

test('caution exits once the score recedes below the exit line', () => {
  let out = decide(createPolicyState(0), { risk: riskAt(45, 'caution') });
  assert.equal(out.state, 'caution');
  out = decide(out.policy, { now: 1, risk: riskAt(38, 'stable') });
  assert.equal(out.state, 'caution'); // hysteresis hold
  out = decide(out.policy, { now: 2, risk: riskAt(20, 'stable') });
  assert.equal(out.state, 'stable');
});
