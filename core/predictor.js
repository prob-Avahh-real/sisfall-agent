// Short-horizon forecast: turns the recent risk-score history into a
// prediction, so the agent can warn "danger in ~1.2 s" instead of only
// reacting once the posture is already dangerous.
//
// Two independent danger signatures:
//   1. A confident rising trend -> extrapolate time-to-threshold.
//   2. Staggering: irregular, bursty lateral corrections at an already
//      non-trivial risk level (classic near-fall precursor).
//
// All gates (min rise rate, fit confidence, score floor) are config-driven so
// sensitivity can be tuned without touching this file.

import { DEFAULT_CONFIG } from './config.js';
import { clamp01 } from './features.js';

function emptyForecast() {
  return {
    slope: 0,
    confidence: 0,
    timeToDangerSec: null,
    instability: 0,
    imminent: false,
    projectedLevel: 'stable',
    drivers: [],
  };
}

/** Least-squares fit of [t, score] pairs -> slope (pts/s) + fit quality. */
function fitTrend(pairs) {
  const n = pairs.length;
  if (n < 4) return { slope: 0, confidence: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return { slope: 0, confidence: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const my = sy / n;
  let ssRes = 0;
  let ssTot = 0;
  for (const [x, y] of pairs) {
    const residual = y - (slope * x + intercept);
    ssRes += residual * residual;
    ssTot += (y - my) * (y - my);
  }
  const confidence = ssTot < 1e-6 ? 0 : clamp01(1 - ssRes / ssTot);
  return { slope, confidence };
}

export class RiskForecast {
  constructor(config = DEFAULT_CONFIG) {
    this.config = config.forecast;
    this.dangerThreshold = config.risk.thresholds.danger;
    this.scores = [];
    this.offsets = [];
  }

  reset() {
    this.scores = [];
    this.offsets = [];
  }

  push(t, score, features = {}) {
    this.scores.push([t, score]);
    if (this.scores.length > this.config.windowFrames) this.scores.shift();
    const offset = typeof features.lateralOffset === 'number' && Number.isFinite(features.lateralOffset)
      ? features.lateralOffset
      : 0;
    this.offsets.push(offset);
    if (this.offsets.length > this.config.instabilityWindow) this.offsets.shift();
  }

  /**
   * @param {object} [opts] { horizonScale } multiplies both forecast horizons
   *   (e.g. 1.5 when dizziness is active: warn earlier than usual)
   */
  result({ horizonScale = 1 } = {}) {
    const cfg = this.config;
    if (this.scores.length < 4) return emptyForecast();
    const imminentHorizon = cfg.imminentHorizonSec * horizonScale;
    const dangerHorizon = cfg.dangerHorizonSec * horizonScale;

    const last = this.scores[this.scores.length - 1][1];
    const { slope, confidence } = fitTrend(this.scores);
    const rising = slope >= cfg.minRiseRate;
    const confident = confidence >= cfg.minConfidence;

    let timeToDangerSec = null;
    if (rising && last < this.dangerThreshold) {
      timeToDangerSec = Math.min((this.dangerThreshold - last) / slope, cfg.maxTimeToDangerSec);
    } else if (rising && last >= this.dangerThreshold) {
      timeToDangerSec = 0;
    }

    const instability = this._instability();
    const risingImminent =
      rising && confident && last >= cfg.scoreFloor && timeToDangerSec != null && timeToDangerSec <= imminentHorizon;
    const staggerImminent = last >= cfg.instabilityScoreFloor && instability >= cfg.instabilityFloor;
    const imminent = risingImminent || staggerImminent;

    let projectedLevel = 'stable';
    if (imminent) projectedLevel = 'imminent';
    else if (rising && confident && timeToDangerSec != null && timeToDangerSec <= dangerHorizon) projectedLevel = 'danger';
    else if (rising && confident && last >= cfg.scoreFloor) projectedLevel = 'caution';

    const drivers = [];
    if (rising && confident) drivers.push('Risk rising — forecast from recent trend');
    if (staggerImminent && !risingImminent) drivers.push('Irregular balance corrections (staggering pattern)');

    return {
      slope,
      confidence,
      timeToDangerSec,
      instability,
      imminent,
      projectedLevel,
      drivers,
    };
  }

  /** Burstiness of consecutive lateral-offset changes: staggering index. */
  _instability() {
    const xs = this.offsets;
    if (xs.length < 6) return 0;
    const deltas = [];
    for (let i = 1; i < xs.length; i += 1) deltas.push(Math.abs(xs[i] - xs[i - 1]));
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (mean < 1e-6) return 0;
    const sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) * (b - mean), 0) / deltas.length);
    const burstiness = sd / mean;
    return clamp01((burstiness - 0.55) / 1.1);
  }
}
