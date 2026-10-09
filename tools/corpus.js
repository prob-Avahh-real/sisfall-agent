// Deterministic synthetic corpus (M3): generates raw accelerometer runs
// (quiet walk, near-fall, hard fall with free-fall + impact + lying), pushes
// them through the REAL ImuMapper, and emits labeled 1 s window vectors via
// the shared vectorizer. Reproducible: seeded LCG, no wall clock.
//
// This corpus validates the PIPELINE and guards regressions. Real-world
// performance must come from SisFall-class data (tools/sisfall.js) — the
// synthetic corpus is not evidence of clinical accuracy and the artifact
// metadata says so.

import { makeRandom, nearFallSeverity } from '../sources/sim.js';
import { ImuMapper } from '../sources/imu.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { buildWindowVector } from '../core/learned.js';

const noise = (rnd, scale) => (rnd() * 2 - 1) * scale;

/** Raw-accel synthesis with fall/lying phases; mirrors sources/sim.js style. */
export function syntheticRawRun(kind, { seed = 1, hz = 50, durationSec = 20 } = {}) {
  const rnd = makeRandom(seed);
  const samples = [];
  const steps = Math.round(durationSec * hz);
  const eventStart = 8;
  const freeFall = 0.35;
  const impact = 0.12;
  const lying = 2.2;
  const impactAt = eventStart + freeFall;
  const lyingEnd = impactAt + impact + lying;

  for (let i = 0; i <= steps; i += 1) {
    const t = i / hz;
    let up;
    let motion = 0;
    let lateral = 0;

    if (kind === 'walk') {
      up = { x: 0, y: 1, z: 0 };
      motion = 0.12 * Math.sin(2 * Math.PI * 1.1 * t);
    } else if (kind === 'near-fall') {
      const s = nearFallSeverity(t, { start: eventStart, ramp: 2.4, hold: 0.6, recover: 1.6 });
      const theta = (s * 55 * Math.PI) / 180;
      up = { x: Math.sin(theta), y: Math.cos(theta), z: 0 };
      motion = 0.1 * Math.sin(2 * Math.PI * 1.1 * t);
      lateral = 0.3 * s * Math.sin(2 * Math.PI * 2.2 * t);
    } else {
      // hard fall: walk -> free-fall -> impact -> lying -> recovered
      if (t < eventStart) {
        up = { x: 0, y: 1, z: 0 };
        motion = 0.12 * Math.sin(2 * Math.PI * 1.1 * t);
      } else if (t < impactAt) {
        up = { x: 0, y: 0.15, z: 0 }; // proper accel collapses during free fall
        motion = noise(rnd, 0.05);
      } else if (t < impactAt + impact) {
        up = { x: 0.4, y: 3.2, z: 0.2 }; // impact spike on mixed axes
        motion = noise(rnd, 0.3);
      } else if (t < lyingEnd) {
        up = { x: 1, y: 0.05, z: 0 }; // lying: torso axis horizontal
        motion = noise(rnd, 0.02);
      } else {
        up = { x: 0, y: 1, z: 0 };
        motion = 0.1 * Math.sin(2 * Math.PI * 1.1 * t);
      }
    }

    samples.push({
      t: Math.round(t * 1000) / 1000,
      ax: up.x + motion * 0.35 + lateral + noise(rnd, 0.02),
      ay: up.y + motion + noise(rnd, 0.02),
      az: up.z + noise(rnd, 0.02),
      gx: 0,
      gy: 0,
      gz: 0,
    });
  }

  // Danger ranges start where the envelope becomes VISIBLE to the feature set,
  // not where it starts on paper: a smooth 2.4 s ramp takes ~0.45 s to move
  // the mapped lean, and free-fall takes ~0.35 s to collapse the smoothed
  // gravity the drop proxy relies on. Labeling the anticipatory sliver as
  // positive would be unlearnable noise (identical to walking).
  let dangerRange = null;
  if (kind === 'near-fall') dangerRange = [eventStart + 0.45, eventStart + 2.4 + 0.6];
  if (kind === 'fall') dangerRange = [eventStart + 0.35, lyingEnd];
  return { runId: `${kind}-seed${seed}`, kind, samples, dangerRange };
}

/**
 * Labeled windows from one raw run. Positives: window end inside the danger
 * range. Negatives: window end at least 1 s before danger (or any window of a
 * safe run). Ambiguous windows around the event boundary are dropped.
 * Negatives are deterministically strided to roughly `negativesPerRun`.
 */
export function windowsFromRun(run, { config = DEFAULT_CONFIG, windowSec = 1, hopSec = 0.5, negativesPerRun = 24 } = {}) {
  const mapper = new ImuMapper(config);
  const observations = [];
  for (const sample of run.samples) {
    const observation = mapper.map(sample);
    if (observation) observations.push(observation);
  }

  const windows = [];
  const frameBuffer = [];
  let lastEnd = -Infinity;
  for (const observation of observations) {
    frameBuffer.push({ t: observation.t, features: observation.features, coverage: observation.coverage });
    while (frameBuffer.length && frameBuffer[0].t < observation.t - windowSec) frameBuffer.shift();
    if (observation.t - frameBuffer[0].t < windowSec - hopSec) continue;
    if (observation.t - lastEnd < hopSec) continue;

    let label = 0;
    if (run.dangerRange) {
      const [start, end] = run.dangerRange;
      if (observation.t >= start && observation.t <= end) label = 1;
      // Ambiguous zone: the model cannot know in advance that a ramp will
      // recover, so windows bridging the event edges are dropped rather than
      // mislabeled — the recovery tail is ~1.6 s and needs the wider post pad.
      else if (observation.t > start - 1 && observation.t < end + 2) continue;
    }
    const vector = buildWindowVector(frameBuffer, { minSpanSec: windowSec - hopSec, windowSec });
    if (!vector) continue;
    windows.push({ runId: run.runId, tEnd: observation.t, label, vector });
    lastEnd = observation.t;
  }

  const positives = windows.filter((w) => w.label === 1);
  const negatives = windows.filter((w) => w.label === 0);
  const stride = Math.max(1, Math.ceil(negatives.length / negativesPerRun));
  const kept = negatives.filter((_, index) => index % stride === 0);
  return [...positives, ...kept];
}

/** Full synthetic corpus across kinds × seeds. */
export function buildSyntheticCorpus({
  seeds = [1, 2, 3, 4, 5, 6, 7, 8],
  kinds = ['walk', 'near-fall', 'fall'],
  config = DEFAULT_CONFIG,
  ...windowOpts
} = {}) {
  const samples = [];
  for (const kind of kinds) {
    for (const seed of seeds) {
      const run = syntheticRawRun(kind, { seed });
      samples.push(...windowsFromRun(run, { config, ...windowOpts }));
    }
  }
  return {
    samples,
    meta: {
      source: 'synthetic-v1',
      seeds,
      kinds,
      sampleCount: samples.length,
      positives: samples.filter((s) => s.label === 1).length,
      note: 'Pipeline validation corpus only — not evidence of clinical accuracy.',
    },
  };
}
