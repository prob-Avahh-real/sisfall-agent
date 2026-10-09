// Learned risk model (M3): a logistic-regression window scorer that plugs in
// behind the same risk contract as the rule-based assessRisk — coverage-aware
// and explainable.
//
// It consumes a ~1 s window of canonical feature frames, vectorizes the window
// (max/mean/rate per source feature), and outputs a danger probability mapped
// to the shared 0-100 scale. ONE vectorizer serves both training and runtime
// (this file) so the two can never skew.
//
// Coverage handling (project invariant): an unavailable source feature
// contributes 0 — standardized value 0 means "at the personal average", i.e.
// neutral, never a fabricated extreme. Proxy features are discounted by
// config.risk.coverageWeight. Drivers list the top positive contributions with
// human labels, so every learned score stays explainable.

import { DEFAULT_CONFIG } from './config.js';

export const VECTOR_KEYS = ['leanMax', 'leanMean', 'leanRate', 'offsetMax', 'dropMax', 'dropMean', 'asymMax'];

export const VECTOR_SOURCES = {
  leanMax: 'torsoLean',
  leanMean: 'torsoLean',
  leanRate: 'torsoLean',
  offsetMax: 'lateralOffset',
  dropMax: 'hipDropSpeed',
  dropMean: 'hipDropSpeed',
  asymMax: 'kneeAsymmetry',
};

export const VECTOR_LABELS = {
  leanMax: '前倾峰值',
  leanMean: '持续前倾',
  leanRate: '快速前倾',
  offsetMax: '重心移出支撑面',
  dropMax: '快速下坠',
  dropMean: '持续下降',
  asymMax: '下肢负重不均',
};

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Build a fixed-order window vector from feature frames.
 * @param {Array<{t:number, features:object, coverage?:object}>} frames
 * @returns {{ keys: string[], values: number[], span: number, coverage: object } | null}
 */
export function buildWindowVector(frames, { minSpanSec = 0.6, windowSec = 1 } = {}) {
  if (!frames || frames.length < 2) return null;
  const lastT = frames[frames.length - 1].t;
  const usable = frames.filter((f) => f.t >= lastT - windowSec);
  if (usable.length < 2) return null;
  const span = usable[usable.length - 1].t - usable[0].t;
  if (span < minSpanSec) return null;

  const maxOf = (key) =>
    usable.reduce((m, f) => {
      const value = finite(f.features?.[key]);
      return value === null ? m : Math.max(m, value);
    }, -Infinity);
  const meanOf = (key) => {
    const values = usable.map((f) => finite(f.features?.[key])).filter((v) => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  };

  const firstLean = finite(usable[0].features?.torsoLean);
  const lastLean = finite(usable[usable.length - 1].features?.torsoLean);
  const leanRate = firstLean !== null && lastLean !== null && span > 0 ? (lastLean - firstLean) / span : 0;

  const safeMax = (key) => {
    const value = maxOf(key);
    return Math.max(0, value === -Infinity ? 0 : value);
  };
  const byKey = {
    leanMax: safeMax('torsoLean'),
    leanMean: meanOf('torsoLean'),
    leanRate,
    offsetMax: safeMax('lateralOffset'),
    dropMax: safeMax('hipDropSpeed'),
    dropMean: meanOf('hipDropSpeed'),
    asymMax: safeMax('kneeAsymmetry'),
  };

  const lastCoverage = usable[usable.length - 1].coverage ?? {};
  const coverage = {};
  for (const key of VECTOR_KEYS) coverage[key] = lastCoverage[VECTOR_SOURCES[key]] ?? 'measured';

  return { keys: VECTOR_KEYS, values: VECTOR_KEYS.map((key) => byKey[key]), span, coverage };
}

export class LearnedRiskModel {
  /**
   * @param {object} artifact { version, weights, bias, mean, std, threshold, metrics?, trainedOn? }
   */
  constructor(artifact) {
    if (!artifact || !Array.isArray(artifact.weights) || artifact.weights.length !== VECTOR_KEYS.length) {
      throw new Error(`Invalid risk-model artifact: expected ${VECTOR_KEYS.length} weights`);
    }
    this.artifact = artifact;
  }

  static fromArtifact(artifact) {
    return new LearnedRiskModel(artifact);
  }

  get threshold() {
    return this.artifact.threshold ?? 0.5;
  }

  /**
   * @param {object} vector from buildWindowVector: { keys, values, coverage }
   * @returns {{ score:number, probability:number, contributions:object, drivers:string[] }}
   */
  score(vector, config = DEFAULT_CONFIG) {
    const { weights, bias, mean, std } = this.artifact;
    const coverage = vector.coverage ?? {};
    const coverageWeight = config.risk.coverageWeight ?? {};

    let logit = bias;
    const contributions = {};
    VECTOR_KEYS.forEach((key, i) => {
      const raw = finite(vector.values?.[i]) ?? (mean?.[i] ?? 0);
      const z = (raw - (mean?.[i] ?? 0)) / ((std?.[i] || 1) || 1);
      const factor = coverageWeight[coverage[key] ?? 'measured'] ?? 1;
      const contribution = weights[i] * z * factor;
      contributions[key] = contribution;
      logit += contribution;
    });

    const clamped = Math.max(-30, Math.min(30, logit));
    const probability = 1 / (1 + Math.exp(-clamped));

    const drivers = Object.entries(contributions)
      .filter(([, value]) => value > 0.3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key]) => VECTOR_LABELS[key]);

    return {
      score: Math.round(probability * 100),
      probability,
      contributions,
      drivers: drivers.length ? drivers : ['步态模式正常'],
    };
  }
}
