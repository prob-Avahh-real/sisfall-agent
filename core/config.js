// Central, overridable defaults. Every threshold the agent uses lives here so
// behavior can be tuned per deployment (or per test) without touching logic.
//
// Coverage levels and how they enter the score:
//   'measured'    full weight
//   'proxy'       discounted (honest about heuristic inputs)
//   'unavailable' excluded, remaining weights renormalized

export const DEFAULT_CONFIG = {
  risk: {
    // Relative weight per feature in the 0-100 score. Sums to 1 for the
    // originally measured pose feature set; other sets renormalize.
    weights: { torsoLean: 0.31, lateralOffset: 0.29, hipDropSpeed: 0.29, kneeAsymmetry: 0.11 },
    // Maps a raw feature value to a 0..1 "pressure": 0 at `start`, 1 at `full`.
    scales: {
      torsoLean: { start: 8, full: 50 },
      lateralOffset: { start: 0.35, full: 2.0 },
      hipDropSpeed: { start: 0, full: 0.9 },
      kneeAsymmetry: { start: 0, full: 0.18 },
    },
    environment: { lowLight: 0.1, obstacle: 0.18 },
    thresholds: { caution: 42, danger: 72 },
    coverageWeight: { measured: 1, proxy: 0.6, unavailable: 0 },
    driversFloor: 0.22,
  },

  imu: {
    // IMU mapping heuristics (prototype values; tune against field data in M3).
    upRefFrames: 30,     // samples used to capture the "upright" gravity reference
    gravityTau: 0.5,     // s, smoothing of the gravity/tilt estimate (lean signal)
    dropGain: 4,         // 1/s, gain from downward accel to drop-velocity proxy
    dropDecay: 2,        // 1/s, leak on the drop-velocity proxy
    lateralTau: 0.4,     // s, low-pass for lateral correction magnitude
    lateralGain: 0.4,    // g -> lateralOffset proxy scale
  },

  baseline: {
    warmupFrames: 90,      // ~6 s at 15 Hz before personalization is trusted
    ewmaAlpha: 0.0005,     // slow drift of the personal normal (≈minutes, not seconds)
    fastAlpha: 0.06,       // fast smoother for deviation checks (~1 s time constant at 15 Hz)
    outsideHoldFrames: 15, // sustained frames above floor before "outside"
    deviationFloor: 3.0,   // |z| vs personal normal that counts as outside
    zCap: 8,               // z at which deviation strength saturates
    minStd: { torsoLean: 2, lateralOffset: 0.08, hipDropSpeed: 0.05, kneeAsymmetry: 0.01 },
  },

  forecast: {
    windowFrames: 12,        // score window for the trend fit (~0.8 s at 15 Hz)
    minRiseRate: 12,         // score points/second required to call a rise
    minConfidence: 0.35,     // least-squares fit quality gate
    scoreFloor: 25,          // never predict danger from a trivially low score
    imminentHorizonSec: 1.6, // "danger within this" => imminent
    dangerHorizonSec: 4.0,   // looser horizon for the softer forecast tier
    instabilityWindow: 12,
    instabilityFloor: 0.55,  // irregular-correction (staggering) index
    instabilityScoreFloor: 40,
    maxTimeToDangerSec: 10,
  },

  policy: {
    cautionExit: 36,
    dangerExit: 64,
    deviationScoreFloor: 15,  // min absolute score for a personalized nudge
    recoverHoldSec: 2.5,
    audioCooldownSec: 6,      // minimum gap between audible alarms
    cueCooldownSec: 4,        // minimum gap between spoken/text instructions
    reminderIntervalSec: 6,   // re-issue a persisting acute state at this cadence
  },

  symptoms: {
    // Non-motion symptom domain (self-reported check-ins + medication state).
    // Levels decay exponentially from the most recent report; symptoms raise
    // the EFFECTIVE risk (the same posture is more dangerous when dizzy or
    // fatigued) and extend forecast horizons so the agent warns earlier.
    minLevel: 0.05,          // below this a symptom counts as cleared
    boostCap: 35,            // max points added to the effective score
    labelBoostFloor: 5,      // boost that relabels a caution as symptom-driven
    halfLifeSec: { dizziness: 600, fatigue: 3600, sleepDebt: 21600, anxiety: 1800, pain: 3600, medicationOff: 7200 },
    riskBoost: { dizziness: 25, fatigue: 12, sleepDebt: 8, anxiety: 8, pain: 10, medicationOff: 15 },
    // Forecast horizons multiply by this while the symptom is active (> 1 = warn earlier).
    horizonScale: { dizziness: 1.5, fatigue: 1.25, sleepDebt: 1.1, anxiety: 1.1, pain: 1.1, medicationOff: 1.3 },
  },

  staging: {
    // Longitudinal classification of evidence into stages 0-3.
    evidenceWindowSec: 900,  // rolling window used for classification
    minEvidenceSec: 40,      // less than this much observed time => 'provisional'
    weights: { episodes: 0.3, timeInBand: 0.3, steadiness: 0.35, symptoms: 0.05 },
    episodeRateFull: 2,      // episodes per window at which the episode term saturates
    bandWeight: { stable: 0, caution: 0.6, danger: 1, imminent: 1 },
    steadiness: {
      leanCv: { floor: 0.2, full: 0.4 },      // CV = std/mean of torsoLean in window
      offsetCv: { floor: 0.12, full: 0.35 },  // CV of lateralOffset in window
      minMean: { torsoLean: 1, lateralOffset: 0.05 },
    },
    thresholds: { guarded: 25, fragile: 50, high: 75 },
    // Fresh symptoms force a minimum stage regardless of current gait evidence.
    symptomFloors: [
      { symptom: 'dizziness', level: 0.6, minStage: 2 },
      { symptom: 'any', level: 0.5, minStage: 1 },
    ],
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merges `overrides` onto a copy of `base` (plain objects only). */
export function mergeConfig(base, overrides = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return out;
}
