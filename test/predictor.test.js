import test from 'node:test';
import assert from 'node:assert/strict';
import { RiskForecast } from '../core/predictor.js';

test('flat stable scores produce no forecast', () => {
  const f = new RiskForecast();
  for (let i = 0; i < 12; i += 1) f.push(i / 15, 10, { lateralOffset: 0.4 });
  const r = f.result();
  assert.equal(r.imminent, false);
  assert.equal(r.projectedLevel, 'stable');
  assert.equal(r.timeToDangerSec, null);
});

test('a confident rise yields time-to-danger and imminent', () => {
  const f = new RiskForecast();
  for (let i = 0; i < 12; i += 1) f.push(i / 15, i * 2.8, { lateralOffset: 0.4 }); // 42 pts/s
  const r = f.result();
  assert.ok(r.slope > 30);
  assert.ok(r.confidence > 0.8);
  assert.ok(r.timeToDangerSec > 0.5 && r.timeToDangerSec < 3);
  assert.equal(r.imminent, true);
});

test('rising from a trivial level is gated by the score floor', () => {
  const f = new RiskForecast();
  for (let i = 0; i < 12; i += 1) f.push(i / 15, i * 1.2, { lateralOffset: 0.4 }); // last 13.2 < 25
  const r = f.result();
  assert.equal(r.imminent, false);
  assert.notEqual(r.projectedLevel, 'imminent');
});

test('horizonScale extends the prediction horizon (> 1 warns earlier)', () => {
  const build = () => {
    const f = new RiskForecast();
    const inc = 20 / 15; // 20 pts/s
    const start = 32 - 11 * inc; // last = 32 -> ttd = (72-32)/20 = 2.0s
    for (let i = 0; i < 12; i += 1) f.push(i / 15, start + i * inc, { lateralOffset: 0.4 });
    return f;
  };
  assert.equal(build().result().imminent, false);
  assert.equal(build().result({ horizonScale: 1.5 }).imminent, true);
});

test('staggering pattern flags imminent at a moderate score', () => {
  const f = new RiskForecast();
  const offsets = [0.5, 0.52, 0.5, 0.51, 2.8, 0.5, 0.51, 0.5, 2.7, 0.5, 0.52, 0.5];
  for (let i = 0; i < 12; i += 1) f.push(i / 15, 45, { lateralOffset: offsets[i] });
  const r = f.result();
  assert.ok(r.instability >= 0.55, `instability ${r.instability}`);
  assert.equal(r.imminent, true);
  assert.ok(r.drivers.some((d) => d.includes('staggering')));
});

test('short buffer returns the empty forecast', () => {
  const f = new RiskForecast();
  f.push(0, 50, { lateralOffset: 0.4 });
  assert.equal(f.result().imminent, false);
  assert.equal(f.result().timeToDangerSec, null);
});
