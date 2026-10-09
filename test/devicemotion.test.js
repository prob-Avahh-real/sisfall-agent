import test from 'node:test';
import assert from 'node:assert/strict';
import { DevicemotionSource, motionPermissionRequired, requestMotionPermission } from '../sources/devicemotion.js';

const evt = (x, y, z) => ({ accelerationIncludingGravity: { x, y, z } });

function fakeTarget() {
  const handlers = new Map();
  return {
    addEventListener: (type, fn) => handlers.set(type, fn),
    removeEventListener: (type) => handlers.delete(type),
    dispatch: (type, e) => handlers.get(type)?.(e),
    has: (type) => handlers.has(type),
  };
}

test('maps DeviceMotion m/s² events to observations once the mapper warms', () => {
  let t = 0;
  const observations = [];
  const source = new DevicemotionSource({ now: () => (t += 1 / 50), onObservation: (o) => observations.push(o) });
  let observation = null;
  for (let i = 0; i < 40; i += 1) observation = source.handleEvent(evt(0, 9.81, 0)); // upright phone
  assert.ok(observation, 'warmed up');
  assert.ok(observation.features.torsoLean < 5);
  assert.ok(observations.length > 0);
  assert.equal(source.stats.unsupported, 0);
  assert.equal(source.stats.samples, 40);
});

test('tilt produces a torso lean reading', () => {
  let t = 0;
  const source = new DevicemotionSource({ now: () => (t += 1 / 50) });
  for (let i = 0; i < 40; i += 1) source.handleEvent(evt(0, 9.81, 0));
  const theta = (50 * Math.PI) / 180;
  let observation = null;
  for (let i = 0; i < 60; i += 1) {
    observation = source.handleEvent(evt(9.81 * Math.sin(theta), 9.81 * Math.cos(theta), 0));
  }
  assert.ok(observation.features.torsoLean > 30, `lean ${observation.features.torsoLean}`);
});

test('events without accelerationIncludingGravity count as unsupported', () => {
  const source = new DevicemotionSource();
  assert.equal(source.handleEvent({ acceleration: { x: 0, y: 0, z: 0 } }), null);
  assert.equal(source.handleEvent({}), null);
  assert.equal(source.stats.unsupported, 2);
});

test('start/stop wire the devicemotion listener', () => {
  const target = fakeTarget();
  const source = new DevicemotionSource();
  source.start(target);
  assert.ok(target.has('devicemotion'));
  source.stop();
  assert.ok(!target.has('devicemotion'));
});

test('dispatch through a started target reaches onObservation', () => {
  const target = fakeTarget();
  let t = 0;
  const observations = [];
  const source = new DevicemotionSource({ now: () => (t += 1 / 50), onObservation: (o) => observations.push(o) });
  source.start(target);
  for (let i = 0; i < 40; i += 1) target.dispatch('devicemotion', evt(0, 9.81, 0));
  assert.ok(observations.length > 0);
  assert.equal(source.stats.observations, observations.length);
});

test('permission helper adapts to the iOS flow', async () => {
  assert.equal(motionPermissionRequired({}), false);
  assert.equal(await requestMotionPermission({}), 'granted');
  const scope = { DeviceMotionEvent: { requestPermission: async () => 'denied' } };
  assert.equal(motionPermissionRequired(scope), true);
  assert.equal(await requestMotionPermission(scope), 'denied');
});
