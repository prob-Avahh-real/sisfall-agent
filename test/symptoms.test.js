import test from 'node:test';
import assert from 'node:assert/strict';
import { SymptomState, SYMPTOM_KEYS, adviceFor } from '../core/symptoms.js';
import { DEFAULT_CONFIG } from '../core/config.js';

test('unknown symptom is rejected', () => {
  assert.throws(() => new SymptomState().checkin({ t: 0, symptom: 'nope' }));
});

test('level decays with the per-symptom half-life', () => {
  const s = new SymptomState();
  s.checkin({ t: 0, symptom: 'dizziness', severity: 0.8 });
  assert.equal(s.levelAt('dizziness', 0), 0.8);
  assert.ok(Math.abs(s.levelAt('dizziness', 600) - 0.4) < 1e-9);
  assert.ok(Math.abs(s.levelAt('dizziness', 1200) - 0.2) < 1e-9);
  assert.equal(s.levelAt('fatigue', 10), 0); // never reported
});

test('re-reporting keeps the stronger of new and still-active level', () => {
  const s = new SymptomState();
  s.checkin({ t: 0, symptom: 'fatigue', severity: 0.9 });
  const again = s.checkin({ t: 100, symptom: 'fatigue', severity: 0.3 });
  assert.ok(again.severity > 0.85); // decayed 0.9 ≈ 0.88 at t=100 (half-life 3600s)
});

test('boost composes, caps, and dizziness extends the horizon', () => {
  const s = new SymptomState();
  s.checkin({ t: 0, symptom: 'dizziness', severity: 1 });
  s.checkin({ t: 0, symptom: 'fatigue', severity: 1 });
  s.checkin({ t: 0, symptom: 'sleepDebt', severity: 1 });
  const at = s.at(0);
  assert.ok(at.boost > 0);
  assert.ok(at.boost <= DEFAULT_CONFIG.symptoms.boostCap);
  assert.equal(at.top, 'dizziness');
  assert.equal(at.horizonScale, DEFAULT_CONFIG.symptoms.horizonScale.dizziness);
  assert.ok(at.horizonScale > 1); // warn earlier while dizzy
  assert.ok(at.windowRemainingSec > 0);
});

test('cleared symptoms leave the active set', () => {
  const s = new SymptomState();
  s.checkin({ t: 0, symptom: 'dizziness', severity: 0.5 });
  assert.equal(s.activeKeys(0).size, 1);
  // 起身发晕半衰期 600s：0.5 * 2^(-6000/600) ≈ 0.0005 < minLevel
  assert.equal(s.activeKeys(6000).size, 0);
});

test('advice text exists for every symptom key', () => {
  for (const key of SYMPTOM_KEYS) {
    assert.ok(adviceFor(key, 0).length > 10, key);
    assert.ok(adviceFor(key, 1200).includes('分钟'), key);
  }
});
