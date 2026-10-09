// Canonical feature schema shared by every SisFall source.
//
// A source (camera pose, phone/wearable IMU, simulator) reports two objects:
//
//   features: { torsoLean, lateralOffset, hipDropSpeed, kneeAsymmetry }
//   coverage: { torsoLean: 'measured'|'proxy'|'unavailable', ... }
//
// 'measured'    the sensor observes this directly
// 'proxy'       derived through a documented heuristic (discounted in scoring)
// 'unavailable' not observable by this source (weight is redistributed)
//
// Adding a feature: one entry here, a weight+scale in config.risk, a driver
// label below, and whatever sources can supply it. Agent/forecast/policy are
// feature-agnostic and do not change.

export const FEATURE_KEYS = ['torsoLean', 'lateralOffset', 'hipDropSpeed', 'kneeAsymmetry'];

export const COVERAGE_LEVELS = ['measured', 'proxy', 'unavailable'];

export const FEATURE_LABELS = {
  torsoLean: '躯干前倾超出支撑面',
  lateralOffset: '重心偏移出站立面',
  hipDropSpeed: '髋部快速下坠',
  kneeAsymmetry: '下肢负重不均',
};

/**
 * Fills missing coverage entries and rejects unknown values.
 * A fully absent coverage object (null/undefined) means the caller did not
 * declare coverage at all: every feature defaults to `fallback` ("measured"
 * for direct library use; sources always declare coverage explicitly).
 */
export function normalizeCoverage(coverage, fallback = 'unavailable') {
  if (coverage == null) {
    return Object.fromEntries(FEATURE_KEYS.map((key) => [key, fallback]));
  }
  const out = {};
  for (const key of FEATURE_KEYS) {
    out[key] = COVERAGE_LEVELS.includes(coverage[key]) ? coverage[key] : 'unavailable';
  }
  return out;
}

/** Coverage object for sources that observe every canonical feature directly. */
export function measuredCoverage() {
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, 'measured']));
}

export function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** Angle (degrees) between segment a->b and straight up, in normalized coords. */
export function angleFromVertical(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs((Math.atan2(dx, -dy) * 180) / Math.PI);
}
