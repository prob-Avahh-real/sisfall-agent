// Personal baseline: learns what "normal" looks like for this one person, so
// the agent can flag "this is unusual for YOU" separately from absolute risk.
//
// Warmup uses exact statistics (Welford). After warmup the normal drifts with
// a slow EWMA (people's gait changes across a day; we must not drift so fast
// that a real deterioration is absorbed). Deviation checks run on a faster
// smoothed signal and require sustained departure before flagging, so a single
// noisy frame cannot fire a personalized warning.

import { FEATURE_KEYS, clamp01 } from './features.js';
import { DEFAULT_CONFIG } from './config.js';

export class PersonalBaseline {
  constructor(config = DEFAULT_CONFIG) {
    this.config = config.baseline;
    this.reset();
  }

  reset() {
    this.n = 0;
    this.mean = {};
    this.m2 = {};
    this.var = {};
    this.fast = {};
    this.fastInit = {};
    this.outsideHold = 0;
    this.outsideRun = 0;
    for (const key of FEATURE_KEYS) {
      this.mean[key] = 0;
      this.m2[key] = 0;
      this.var[key] = 0;
      this.fast[key] = 0;
      this.fastInit[key] = false;
    }
  }

  get warm() {
    return this.n >= this.config.warmupFrames;
  }

  get progress() {
    return clamp01(this.n / this.config.warmupFrames);
  }

  update(features = {}) {
    const { warmupFrames, ewmaAlpha, fastAlpha } = this.config;
    this.n += 1;
    for (const key of FEATURE_KEYS) {
      const value = features[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;

      if (this.n <= warmupFrames) {
        const delta = value - this.mean[key];
        this.mean[key] += delta / this.n;
        this.m2[key] += delta * (value - this.mean[key]);
        if (this.n === warmupFrames) {
          this.var[key] = this.m2[key] / Math.max(this.n - 1, 1);
        }
      } else {
        const prev = this.mean[key];
        this.mean[key] += ewmaAlpha * (value - prev);
        this.var[key] = (1 - ewmaAlpha) * (this.var[key] + ewmaAlpha * (value - prev) * (value - prev));
      }

      this.fast[key] = this.fastInit[key] ? this.fast[key] + fastAlpha * (value - this.fast[key]) : value;
      this.fastInit[key] = true;
    }
  }

  /**
   * How far current smoothed features sit from the personal normal.
   * Returns level 'learning' | 'normal' | 'outside', a 0..1 score, per-feature
   * z values, and the top deviating feature keys.
   */
  deviation(features = {}) {
    if (!this.warm) return { level: 'learning', score: 0, z: {}, top: [] };

    let maxZ = 0;
    const z = {};
    for (const key of FEATURE_KEYS) {
      const value = features[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const floor = this.config.minStd[key] ?? 0.01;
      const sd = Math.max(Math.sqrt(Math.max(this.var[key], 0)), floor);
      const current = this.fastInit[key] ? this.fast[key] : value;
      const zk = Math.abs(current - this.mean[key]) / sd;
      z[key] = zk;
      if (zk > maxZ) maxZ = zk;
    }

    // Require a sustained departure before declaring "outside".
    if (maxZ >= this.config.deviationFloor) this.outsideHold += 1;
    else this.outsideHold = 0;
    const need = this.config.outsideHoldFrames;
    this.outsideRun = Math.min(this.outsideHold, need);

    const top = Object.entries(z)
      .filter(([, value]) => value >= this.config.deviationFloor)
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => key)
      .slice(0, 2);

    return {
      level: this.outsideRun >= need ? 'outside' : 'normal',
      score: clamp01(maxZ / this.config.zCap),
      z,
      top,
    };
  }
}
