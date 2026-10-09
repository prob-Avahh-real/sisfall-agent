// Instant posture risk: maps canonical features + environment context onto a
// 0-100 score, a band (stable/caution/danger), and human-readable drivers.
//
// Coverage-aware: 'measured' features count at full weight, 'proxy' at a
// discount, 'unavailable' are excluded and the remaining weights renormalize.
// The score therefore never silently degrades when a source cannot observe a
// feature — it is computed from what is actually known and reports coverage.

import { DEFAULT_CONFIG } from './config.js';
import { FEATURE_KEYS, FEATURE_LABELS, normalizeCoverage, clamp01 } from './features.js';

function pressure(value, scale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clamp01((value - scale.start) / (scale.full - scale.start));
}

export function assessRisk(features = {}, context = {}, config = DEFAULT_CONFIG) {
  const { weights, scales, thresholds, coverageWeight = {}, driversFloor = 0.22 } = config.risk;
  const coverage = normalizeCoverage(context.coverage ?? features.coverage, 'measured');

  let numerator = 0;
  let denominator = 0;
  const pressures = {};
  for (const key of FEATURE_KEYS) {
    const level = coverage[key];
    const factor = coverageWeight[level] ?? 0;
    const p = pressure(features[key], scales[key]);
    pressures[key] = p;
    numerator += weights[key] * p * factor;
    denominator += weights[key] * factor;
  }

  // Environmental context (obstacle, low light) is handled one level up in the
  // agent: it shortens warning horizons (config.risk.environment.horizonScale)
  // instead of adding a constant to the posture score.
  const score = Math.round(clamp01(denominator > 0 ? numerator / denominator : 0) * 100);
  const level = score >= thresholds.danger ? 'danger' : score >= thresholds.caution ? 'caution' : 'stable';

  const drivers = FEATURE_KEYS.map((key) => [
    coverage[key] === 'unavailable' ? 0 : pressures[key],
    FEATURE_LABELS[key],
  ])
    .filter(([value]) => value > driversFloor)
    .sort((a, b) => b[0] - a[0])
    .map(([, label]) => label)
    .slice(0, 3);

  return {
    score,
    level,
    drivers: drivers.length ? drivers : ['姿态处于稳定范围内'],
    coverage,
  };
}

// Display-only smoother (used by the web gauge, not by the agent loop —
// the agent's trend logic lives in core/predictor.js).
export class RiskSmoother {
  constructor(size = 8) {
    this.size = size;
    this.values = [];
  }
  add(value) {
    this.values.push(value);
    if (this.values.length > this.size) this.values.shift();
    const weights = this.values.map((_, i) => i + 1);
    return Math.round(this.values.reduce((sum, v, i) => sum + v * weights[i], 0) / weights.reduce((a, b) => a + b, 0));
  }
}
