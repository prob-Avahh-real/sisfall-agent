// Patient staging: classifies sustained evidence from a session window into
// fall-risk stages 0-3, so advice and care can be matched to severity instead
// of reacting frame-by-frame forever.
//
// Evidence components (all 0..1, weights in config.staging):
//   episodes    acute near-fall episodes inside the window (saturating)
//   timeInBand  fraction of time spent in caution/danger/imminent bands
//   steadiness  gait variability from window statistics (CV of lean/offset)
//   symptoms    mean non-motion symptom boost over the window
//
// Stage floors: certain active symptoms (e.g. fresh dizziness) force a minimum
// stage regardless of gait evidence — clinically, a dizzy episode IS elevated
// fall risk even if the walking looks calm right now.
//
// The classification is always explainable: the result carries its evidence,
// its drivers, and whether it was decided from enough data (provisional flag).

import { DEFAULT_CONFIG } from './config.js';
import { clamp01 } from './features.js';
import { STAGE_DEFINITIONS } from './care.js';

function component(value, { floor, full }) {
  return clamp01((value - floor) / (full - floor));
}

export class PatientStager {
  constructor(config = DEFAULT_CONFIG) {
    this.config = config.staging;
    this.boostCap = config.symptoms?.boostCap ?? 35;
    this.reset();
  }

  reset() {
    this.frames = 0;
    this._sumW = 0;
    this._sumBoost = 0;
    this._sumLean = 0;
    this._sumLeanSq = 0;
    this._sumOffset = 0;
    this._sumOffsetSq = 0;
    this._records = []; // { t, w, boost, lean, offset } — kept only for window pruning
    this.episodes = [];
    this.lastSymptoms = null;
    this.lastT = 0;
  }

  /** Called once per processed frame. */
  update({ t, level = 'stable', boost = 0, features = {}, symptoms = null }) {
    const window = this.config.evidenceWindowSec;
    while (this._records.length > 0 && this._records[0].t < t - window) {
      const old = this._records.shift();
      this.frames -= 1;
      this._sumW -= old.w;
      this._sumBoost -= old.boost;
      this._sumLean -= old.lean;
      this._sumLeanSq -= old.lean * old.lean;
      this._sumOffset -= old.offset;
      this._sumOffsetSq -= old.offset * old.offset;
    }

    const lean = Number.isFinite(features.torsoLean) ? features.torsoLean : 0;
    const offset = Number.isFinite(features.lateralOffset) ? features.lateralOffset : 0;
    const w = this.config.bandWeight[level] ?? 0;
    const record = { t, w, boost, lean, offset };
    this._records.push(record);
    this.frames += 1;
    this._sumW += w;
    this._sumBoost += boost;
    this._sumLean += lean;
    this._sumLeanSq += lean * lean;
    this._sumOffset += offset;
    this._sumOffsetSq += offset * offset;

    this.lastSymptoms = symptoms;
    this.lastT = t;
  }

  /** Called when an acute episode closes (the agent tracks episodes). */
  noteEpisode({ t }) {
    this.episodes.push(t);
  }

  /** @returns staged classification with evidence and drivers */
  result() {
    const cfg = this.config;
    const frames = this.frames;
    const window = cfg.evidenceWindowSec;
    const spanSec = frames > 0 ? this.lastT - this._records[0].t : 0;
    const provisional = spanSec < cfg.minEvidenceSec;

    const episodeCount = this.episodes.filter((t) => t >= this.lastT - window).length;
    const episodeRate = clamp01(episodeCount / cfg.episodeRateFull);
    const timeInBand = frames > 0 ? this._sumW / frames : 0;
    const symptomLoad = frames > 0 ? this._sumBoost / frames / this.boostCap : 0;

    let steadiness = 0;
    if (frames > 4) {
      const leanMean = this._sumLean / frames;
      const leanVar = Math.max(0, this._sumLeanSq / frames - leanMean * leanMean);
      const leanCv = Math.sqrt(leanVar) / Math.max(Math.abs(leanMean), cfg.steadiness.minMean.torsoLean);
      const offsetMean = this._sumOffset / frames;
      const offsetVar = Math.max(0, this._sumOffsetSq / frames - offsetMean * offsetMean);
      const offsetCv = Math.sqrt(offsetVar) / Math.max(Math.abs(offsetMean), cfg.steadiness.minMean.lateralOffset);
      steadiness = Math.max(
        component(leanCv, cfg.steadiness.leanCv),
        component(offsetCv, cfg.steadiness.offsetCv)
      );
    }

    const weights = cfg.weights;
    const contributions = [
      { key: 'episodes', value: weights.episodes * episodeRate, label: `近期“差点跌倒” ${episodeCount} 次` },
      { key: 'timeInBand', value: weights.timeInBand * timeInBand, label: '高风险时段占比偏高' },
      { key: 'steadiness', value: weights.steadiness * steadiness, label: '步态波动偏大' },
      { key: 'symptoms', value: weights.symptoms * symptomLoad, label: '非运动症状负担' },
    ];
    const score = Math.round(100 * contributions.reduce((sum, c) => sum + c.value, 0));

    const thresholds = cfg.thresholds;
    let stage = score >= thresholds.high ? 3 : score >= thresholds.fragile ? 2 : score >= thresholds.guarded ? 1 : 0;

    let floorApplied = null;
    if (this.lastSymptoms && this.lastSymptoms.levels) {
      for (const rule of cfg.symptomFloors ?? []) {
        const level =
          rule.symptom === 'any'
            ? Math.max(0, ...Object.values(this.lastSymptoms.levels))
            : this.lastSymptoms.levels[rule.symptom] ?? 0;
        if (level >= rule.level && stage < rule.minStage) {
          stage = rule.minStage;
          floorApplied = rule.symptom;
        }
      }
    }

    const definition = STAGE_DEFINITIONS[stage] ?? STAGE_DEFINITIONS[0];
    const drivers = contributions
      .filter((c) => c.value > 0.03)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
      .map((c) => c.label);

    return {
      stage,
      key: definition.key,
      label: definition.label,
      summary: definition.summary,
      score,
      provisional,
      floorApplied,
      drivers,
      evidence: { episodeCount, episodeRate, timeInBand, steadiness, symptomLoad },
      evidenceWindowSec: window,
      frames,
      spanSec: Math.round(spanSec * 10) / 10,
    };
  }
}
