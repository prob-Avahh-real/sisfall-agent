// 症状签到域（PD 最小集，core/pd-profile.js）：起身发晕（体位相关）、
// 疲劳、睡眠不足、药效减退——只收会直接改变"当下行动安全"的因素；
// 焦虑、疼痛等纳入临床随访（超出本应用行为边界）。
//
// These are NOT features of a single frame — they are context that persists
// and decays in time. A symptom reported at severity s fades exponentially
// with a per-symptom half-life. While active, a symptom:
//
//   - raises the EFFECTIVE risk score (the same posture is more dangerous
//     when you are dizzy or fatigued)            -> riskBoost, capped
//   - extends forecast horizons, so the agent
//     warns earlier than it otherwise would       -> horizonScale (max over active)
//
// The posture score itself stays pure — fusion happens in the agent, and the
// journal records raw score, boost, and effective score separately so the
// contribution of symptoms is always auditable.

import { DEFAULT_CONFIG } from './config.js';

export const SYMPTOM_KEYS = ['dizziness', 'fatigue', 'sleepDebt', 'medicationOff'];

export const SYMPTOM_LABELS = {
  dizziness: '起身发晕',
  fatigue: '疲劳',
  sleepDebt: '睡眠不足',
  medicationOff: '药效减退',
};

/** Actionable guidance shown when a check-in is recorded. */
export function adviceFor(symptom, windowRemainingSec = 0) {
  const windowNote =
    windowRemainingSec > 60 ? `（高度关注约 ${Math.round(windowRemainingSec / 60)} 分钟）` : '';
  switch (symptom) {
    case 'dizziness':
      return `起身发晕时先坐稳片刻、再缓慢站起，站稳后再迈步；服药后、饭后与天热时更容易出现，尤其放慢。若反复出现，请告知医生。${windowNote}`;
    case 'fatigue':
      return `建议先休息，再继续行走。${windowNote}`;
    case 'sleepDebt':
      return `睡眠不足会提高当日跌倒风险。路线与步速都留出余量。${windowNote}`;
    case 'medicationOff':
      return `药效减退可能增加症状风险。下次服药前请放慢节奏。${windowNote}`;
    default:
      return `已记录，智能体会将其纳入评估。${windowNote}`;
  }
}

export class SymptomState {
  constructor(config = DEFAULT_CONFIG) {
    this.config = config.symptoms;
    this.reset();
  }

  reset() {
    this.latest = {}; // symptom -> { t, severity }: O(1) current state
    this.history = []; // bounded audit trail; levelAt() reads latest only
  }

  /**
   * Record a check-in. Re-reporting a symptom keeps the stronger of the new
   * severity and the still-active decayed level (clicking again = "still here").
   */
  checkin({ t, symptom, severity = 0.6, note = '' }) {
    if (!SYMPTOM_KEYS.includes(symptom)) throw new Error(`Unknown symptom: ${symptom}`);
    const requested = Math.min(1, Math.max(0, severity));
    const current = this.levelAt(symptom, t);
    const stored = Math.max(requested, current);
    this.latest[symptom] = { t, severity: stored, note };
    this.history.push({ t, symptom, severity: stored, note });
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    return { t, symptom, severity: stored, note };
  }

  /** Decayed level of one symptom at time t (0..1). */
  levelAt(symptom, t) {
    const latest = this.latest[symptom];
    if (!latest) return 0;
    const halfLife = this.config.halfLifeSec[symptom] ?? 600;
    const dt = Math.max(0, t - latest.t);
    return latest.severity * 0.5 ** (dt / halfLife);
  }

  /**
   * Full symptom context at time t.
   * @returns {{ levels, active, top, topLabel, boost, horizonScale, windowRemainingSec }}
   */
  at(t) {
    const levels = {};
    const active = [];
    for (const key of SYMPTOM_KEYS) {
      const level = this.levelAt(key, t);
      levels[key] = level;
      if (level >= this.config.minLevel) {
        active.push({ key, label: SYMPTOM_LABELS[key], level });
      }
    }
    active.sort((a, b) => b.level - a.level);

    let boost = 0;
    let horizonScale = 1;
    for (const item of active) {
      boost += (this.config.riskBoost[item.key] ?? 0) * item.level;
      horizonScale = Math.max(horizonScale, this.config.horizonScale[item.key] ?? 1);
    }
    boost = Math.min(boost, this.config.boostCap);

    const top = active[0] ?? null;
    const windowRemainingSec = top
      ? (this.config.halfLifeSec[top.key] ?? 600) * Math.log2(Math.max(top.level, 1e-6) / this.config.minLevel)
      : 0;

    return {
      levels,
      active,
      top: top?.key ?? null,
      topLabel: top?.label ?? null,
      boost: Math.round(boost * 10) / 10,
      horizonScale,
      windowRemainingSec: Math.max(0, Math.round(windowRemainingSec)),
    };
  }

  /** Keys whose level is >= minLevel at time t (for activation journaling). */
  activeKeys(t) {
    return new Set(
      SYMPTOM_KEYS.filter((key) => this.levelAt(key, t) >= (this.config.minLevel ?? 0.05))
    );
  }
}
