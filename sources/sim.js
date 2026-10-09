// Deterministic scenario simulator: generates observations for every scenario
// the agent must handle, so behavior (including prediction lead time and
// symptom fusion) can be tested without hardware or a camera.
//
// Pose scenarios emit canonical features directly. The IMU scenario emits raw
// accelerometer samples and runs them through the REAL ImuMapper, so the IMU
// path is exercised end-to-end, not bypassed. Scenarios may also carry
// check-ins, which callers interleave with observations via interleave().
//
// All randomness comes from a seeded LCG — runs are reproducible.

import { measuredCoverage } from '../core/features.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { ImuMapper } from './imu.js';

export function makeRandom(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const noise = (rnd, scale) => (rnd() * 2 - 1) * scale;
const smoothstep = (p) => {
  const x = Math.min(1, Math.max(0, p));
  return x * x * (3 - 2 * x);
};

// Severity envelope of the near-fall episode: quiet -> ramp -> peak hold -> recover.
export function nearFallSeverity(t, { start = 8, ramp = 2.6, hold = 0.8, recover = 2 } = {}) {
  if (t < start) return 0;
  if (t < start + ramp) return smoothstep((t - start) / ramp);
  if (t < start + ramp + hold) return 1;
  if (t < start + ramp + hold + recover) return 1 - smoothstep((t - (start + ramp + hold)) / recover);
  return 0;
}

export const SCENARIOS = {
  stable: { label: '平稳行走', durationSec: 60, hz: 15 },
  wobble: { label: '不稳行走', durationSec: 90, hz: 15 },
  'wobble-shift': { label: '步态突变', durationSec: 90, hz: 15 },
  'dizzy-walk': {
    label: '头晕步态（含签到）',
    durationSec: 60,
    hz: 15,
    checkins: [{ t: 5, symptom: 'dizziness', severity: 1.0 }],
  },
  'near-fall': { label: '差点跌倒', durationSec: 18, hz: 15 },
  'imu-near-fall': { label: '差点跌倒（IMU 通道）', durationSec: 16, hz: 50 },
};

function poseFrames(name, { hz, durationSec, seed }) {
  const rnd = makeRandom(seed);
  const frames = [];
  const steps = Math.round(durationSec * hz);

  for (let i = 0; i <= steps; i += 1) {
    const t = i / hz;
    let torsoLean;
    let lateralOffset;
    let hipDropSpeed;
    let kneeAsymmetry;

    if (name === 'stable') {
      torsoLean = 7 + 2.2 * Math.sin(2 * Math.PI * 0.9 * t) + noise(rnd, 1.2);
      lateralOffset = 0.34 + 0.07 * Math.sin(2 * Math.PI * 0.45 * t + 1) + noise(rnd, 0.05);
      hipDropSpeed = noise(rnd, 0.02);
      kneeAsymmetry = 0.012 + noise(rnd, 0.008);
    } else if (name === 'wobble') {
      torsoLean = 9 + 4.5 * Math.sin(2 * Math.PI * 0.7 * t) + noise(rnd, 3.5);
      lateralOffset = 0.42 + 0.1 * Math.sin(2 * Math.PI * 0.55 * t + 0.7) + noise(rnd, 0.09);
      hipDropSpeed = noise(rnd, 0.05);
      kneeAsymmetry = 0.02 + noise(rnd, 0.015);
    } else if (name === 'dizzy-walk') {
      // Moderate, steady unsteadiness — below every unassisted trigger. Only
      // the fused symptom boost (dizziness check-in at t=5) pushes it over.
      torsoLean = 13 + 1.2 * Math.sin(2 * Math.PI * 0.9 * t) + noise(rnd, 1.0);
      lateralOffset = 1.1 + 0.04 * Math.sin(2 * Math.PI * 0.55 * t + 0.7) + noise(rnd, 0.04);
      hipDropSpeed = noise(rnd, 0.04);
      kneeAsymmetry = 0.03 + noise(rnd, 0.01);
    } else if (name === 'wobble-shift') {
      const shifted = t >= 30;
      const leanAmp = shifted ? 5.8 : 1.8;
      const offsetBase = shifted ? 0.85 : 0.38;
      const offsetAmp = shifted ? 0.34 : 0.09;
      torsoLean = 7 + leanAmp * Math.sin(2 * Math.PI * 0.7 * t) + noise(rnd, shifted ? 3.5 : 1.2);
      lateralOffset = offsetBase + offsetAmp * Math.sin(2 * Math.PI * 0.55 * t + 0.7) + noise(rnd, shifted ? 0.09 : 0.045);
      hipDropSpeed = noise(rnd, shifted ? 0.06 : 0.02);
      kneeAsymmetry = (shifted ? 0.03 : 0.012) + noise(rnd, 0.01);
    } else {
      // near-fall
      const s = nearFallSeverity(t);
      torsoLean = 7 + 48 * s + noise(rnd, 1.2);
      lateralOffset = 0.34 + 2.0 * s + noise(rnd, 0.06);
      hipDropSpeed = 0.92 * s + noise(rnd, 0.02);
      kneeAsymmetry = 0.012 + 0.15 * s + noise(rnd, 0.008);
    }

    frames.push({
      t: Math.round(t * 1000) / 1000,
      features: {
        torsoLean,
        lateralOffset,
        hipDropSpeed: Math.max(0, hipDropSpeed),
        kneeAsymmetry: Math.max(0, kneeAsymmetry),
      },
      coverage: measuredCoverage(),
      context: {},
    });
  }
  return frames;
}

function imuFrames({ hz, durationSec, seed }) {
  const rnd = makeRandom(seed + 7);
  const mapper = new ImuMapper(DEFAULT_CONFIG);
  const frames = [];
  const steps = Math.round(durationSec * hz);

  for (let i = 0; i <= steps; i += 1) {
    const t = i / hz;
    const s = nearFallSeverity(t, { start: 8, ramp: 1.8, hold: 0.8, recover: 2 });
    const theta = ((s * 55) * Math.PI) / 180; // forward torso tilt
    // At rest the accelerometer measures +1 g along the device "up" axis.
    const up = { x: Math.sin(theta), y: Math.cos(theta), z: 0 };
    const walk = 0.12 * Math.sin(2 * Math.PI * 1.1 * t);
    const lateralBurst = 0.3 * s * Math.sin(2 * Math.PI * 2.2 * t);
    const sample = {
      t,
      ax: up.x + walk * 0.35 + lateralBurst + noise(rnd, 0.02),
      ay: up.y + walk + noise(rnd, 0.02),
      az: up.z + noise(rnd, 0.02),
      gx: 0,
      gy: 0,
      gz: s > 0 ? 25 : 0, // angular velocity present during the event (unused for now)
    };
    const observation = mapper.map(sample);
    if (observation) frames.push(observation);
  }
  return frames;
}

/**
 * @param {string} name one of SCENARIOS
 * @param {object} [opts] { seed, durationSec, hz } overrides
 * @returns {{ observations, checkins, meta }} observations and scheduled check-ins
 */
export function runScenario(name, opts = {}) {
  const spec = SCENARIOS[name];
  if (!spec) throw new Error(`Unknown scenario: ${name}`);
  const settings = { seed: 42, ...spec, ...opts };
  const observations = name === 'imu-near-fall' ? imuFrames(settings) : poseFrames(name, settings);
  return {
    observations,
    checkins: spec.checkins ? spec.checkins.map((c) => ({ ...c })) : [],
    meta: { name, durationSec: settings.durationSec, hz: settings.hz },
  };
}

/** Merge observations and check-ins into a single time-ordered event list. */
export function interleave(observations, checkins = []) {
  const events = [
    ...observations.map((observation) => ({ t: observation.t, kind: 'observation', observation })),
    ...checkins.map((checkin) => ({ t: checkin.t, kind: 'checkin', checkin })),
  ];
  return events.sort((a, b) => a.t - b.t);
}
