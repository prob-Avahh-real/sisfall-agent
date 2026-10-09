import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, interleave, SCENARIOS } from '../sources/sim.js';

test('all scenarios are deterministic for a fixed seed', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const a = runScenario(name);
    const b = runScenario(name);
    assert.deepEqual(a.observations, b.observations, name);
    assert.deepEqual(a.checkins, b.checkins, name);
  }
});

test('scenario shapes are sane and contain no NaN', () => {
  const { observations, meta } = runScenario('near-fall');
  assert.equal(observations.length, meta.durationSec * meta.hz + 1);
  for (const o of observations) {
    assert.ok(Number.isFinite(o.features.torsoLean));
    assert.ok(Number.isFinite(o.features.lateralOffset));
    assert.ok(Number.isFinite(o.features.hipDropSpeed));
    assert.ok(Number.isFinite(o.features.kneeAsymmetry));
  }
  const maxLean = Math.max(...observations.map((o) => o.features.torsoLean));
  const minLean = Math.min(...observations.map((o) => o.features.torsoLean));
  assert.ok(maxLean > 50, `maxLean ${maxLean}`);
  assert.ok(minLean < 15, `minLean ${minLean}`);
});

test('dizzy-walk carries a scheduled check-in and interleave orders events', () => {
  const { observations, checkins } = runScenario('dizzy-walk');
  assert.equal(checkins.length, 1);
  assert.equal(checkins[0].symptom, 'dizziness');
  const events = interleave(observations, checkins);
  assert.equal(events.length, observations.length + checkins.length);
  for (let i = 1; i < events.length; i += 1) assert.ok(events[i].t >= events[i - 1].t);
  assert.ok(events.some((e) => e.kind === 'checkin'));
});

test('imu scenario runs through the real mapper (proxy coverage present)', () => {
  const { observations } = runScenario('imu-near-fall');
  assert.ok(observations.length > 700, `frames ${observations.length}`);
  const last = observations[observations.length - 1];
  assert.equal(last.coverage.kneeAsymmetry, 'unavailable');
  assert.equal(last.coverage.torsoLean, 'measured');
  // the mapper must have seen the tilt
  const maxLean = Math.max(...observations.map((o) => o.features.torsoLean));
  assert.ok(maxLean > 35, `imu maxLean ${maxLean}`);
});

test('unknown scenario is rejected', () => {
  assert.throws(() => runScenario('nope'));
});
