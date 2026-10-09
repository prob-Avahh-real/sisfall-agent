import test from 'node:test';
import assert from 'node:assert/strict';
import { PatientStager } from '../core/staging.js';

function feed(stager, frames, fn, hz = 15, t0 = 0) {
  for (let i = 0; i < frames; i += 1) {
    const t = t0 + i / hz;
    const f = fn(t);
    stager.update({
      t,
      level: f.level ?? 'stable',
      boost: f.boost ?? 0,
      features: { torsoLean: f.lean, lateralOffset: f.offset },
      symptoms: f.symptoms ?? null,
    });
  }
}

test('empty stager reports stage 0, provisional', () => {
  const r = new PatientStager().result();
  assert.equal(r.stage, 0);
  assert.equal(r.provisional, true);
  assert.equal(r.score, 0);
});

test('steady walk stays stage 0 once established', () => {
  const s = new PatientStager();
  feed(s, 900, (t) => ({
    lean: 7 + 2.2 * Math.sin(0.9 * t * 2 * Math.PI) + 1.2 * Math.sin(37 * t),
    offset: 0.34 + 0.07 * Math.sin(0.45 * t * 2 * Math.PI),
  }));
  const r = s.result();
  assert.equal(r.stage, 0);
  assert.equal(r.provisional, false);
});

test('unsteady walk stages as guarded from gait variability', () => {
  const s = new PatientStager();
  feed(s, 1350, (t) => ({
    lean: 9 + 4.5 * Math.sin(0.7 * t * 2 * Math.PI) + 3.5 * Math.sin(53 * t),
    offset: 0.42 + 0.1 * Math.sin(0.55 * t * 2 * Math.PI) + 0.09 * Math.sin(71 * t),
  }));
  const r = s.result();
  assert.equal(r.stage, 1);
  assert.ok(r.evidence.steadiness > 0.8);
  assert.ok(r.drivers.some((d) => d.includes('波动')));
});

test('sustained acute session with episodes stages as high risk', () => {
  const s = new PatientStager();
  feed(s, 900, (t) => ({
    lean: 12 + 8 * Math.sin(0.8 * t * 2 * Math.PI) + 5 * Math.sin(41 * t),
    offset: 1.0 + 0.2 * Math.sin(0.5 * t * 2 * Math.PI) + 0.1 * Math.sin(67 * t),
    level: 'imminent',
    boost: 25,
  }));
  s.noteEpisode({ t: 10 });
  s.noteEpisode({ t: 50 });
  const r = s.result();
  assert.equal(r.stage, 3);
  assert.equal(r.evidence.episodeCount, 2);
  assert.ok(r.drivers.length > 0);
});

test('fresh dizziness floors the stage regardless of calm gait', () => {
  const s = new PatientStager();
  const symptomCtx = {
    levels: { dizziness: 0.8 },
    active: [{ key: 'dizziness', label: '头晕', level: 0.8 }],
    top: 'dizziness',
    topLabel: '头晕',
  };
  feed(s, 120, () => ({ lean: 7, offset: 0.34, symptoms: symptomCtx }));
  const r = s.result();
  assert.equal(r.stage, 2);
  assert.equal(r.floorApplied, 'dizziness');
});

test('window pruning forgets old evidence', () => {
  const s = new PatientStager();
  // 60s of acute-band frames, then 15+ minutes of quiet: window is 15 min
  feed(s, 900, () => ({ lean: 12, offset: 0.6, level: 'imminent' }), 15, 0);
  feed(s, 14000, () => ({ lean: 7, offset: 0.34, level: 'stable' }), 15, 60);
  const r = s.result();
  assert.ok(r.evidence.timeInBand < 0.2, `timeInBand ${r.evidence.timeInBand}`);
});
