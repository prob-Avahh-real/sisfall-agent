// SteadyStepAgent: the perception -> reasoning -> decision loop.
//
//   ingest(observation) =>
//     baseline.update(features)          learn "normal for this person"
//     risk = assessRisk(...)             how dangerous is the posture now
//     symptoms = SymptomState.at(t)      non-motion context, decaying over time
//     effective = risk + symptom boost   same posture, more dangerous when dizzy
//     forecast = RiskForecast            where is it heading (horizon scaled)
//     decision = decidePolicy(...)       what, if anything, to do about it
//     stage = PatientStager.result()     longitudinal classification 0-3
//     journal.record(...)                audit trail of everything above
//
// The agent is environment-agnostic: it consumes canonical observations
// (features + coverage + optional context) from any source — camera pose,
// wearable IMU, simulator, replay — and returns a step object for the caller
// (web UI, terminal demo, tests) to render or act on. Check-ins for
// non-motion symptoms arrive through ingestCheckin() and fuse into the same
// loop; carePlan() turns the staged classification into advice.

import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { PersonalBaseline } from './baseline.js';
import { RiskForecast } from './predictor.js';
import { assessRisk } from './risk.js';
import { createPolicyState, decidePolicy } from './policy.js';
import { Journal } from './journal.js';
import { SymptomState, adviceFor, SYMPTOM_LABELS } from './symptoms.js';
import { PatientStager } from './staging.js';
import { carePlan } from './care.js';

const ACUTE = new Set(['imminent', 'danger']);

export class SteadyStepAgent {
  constructor({ config, journal } = {}) {
    this.config = mergeConfig(DEFAULT_CONFIG, config);
    this.journal = journal ?? new Journal();
    this.baseline = new PersonalBaseline(this.config);
    this.forecast = new RiskForecast(this.config);
    this.symptoms = new SymptomState(this.config);
    this.stager = new PatientStager(this.config);
    this.policy = createPolicyState(0);
    this.lastT = 0;
    this._episode = null;
    this._activeSymptoms = new Set();
    this._lastStage = null;
    this.stats = { frames: 0, maxScore: 0, episodes: [], actionCounts: {}, startedAt: null };
  }

  get baselineProgress() {
    return this.baseline.progress;
  }

  /** Forget the learned personal normal (e.g., new wearer or new placement). */
  resetBaseline() {
    this.baseline.reset();
    this.forecast.reset();
    this.policy = createPolicyState(this.lastT);
    this.journal.record({ t: this.lastT, type: 'calibration', message: 'Personal baseline reset' });
  }

  /** Clear all reported symptoms (e.g., start of a new day). */
  resetSymptoms() {
    this.symptoms.reset();
    this._activeSymptoms = new Set();
    this.journal.record({ t: this.lastT, type: 'symptom', action: 'reset' });
  }

  /**
   * Record a non-motion symptom check-in (dizziness, fatigue, ...).
   * Returns immediate advice; the symptom then decays over its half-life and
   * feeds risk fusion + staging.
   */
  ingestCheckin({ t = this.lastT, symptom, severity = 0.6, note = '' } = {}) {
    const record = this.symptoms.checkin({ t, symptom, severity, note });
    this.journal.record({ t, type: 'checkin', symptom, severity: record.severity, note });
    const context = this.symptoms.at(t);
    return {
      t,
      symptom,
      label: SYMPTOM_LABELS[symptom],
      level: context.levels[symptom],
      advice: adviceFor(symptom, context.windowRemainingSec),
      boost: context.boost,
      windowRemainingSec: context.windowRemainingSec,
    };
  }

  /**
   * @param {object} observation { t, features, coverage?, context? }
   * @returns {object} step { t, state, features, coverage, risk, effective,
   *   forecast, baseline, symptoms, stage, actions }
   */
  ingest(observation = {}) {
    const { t = this.lastT, features = {}, context = {} } = observation;
    this.lastT = t;
    this.stats.frames += 1;
    if (this.stats.startedAt == null) this.stats.startedAt = t;

    const wasWarm = this.baseline.warm;
    this.baseline.update(features);
    const risk = assessRisk({ ...features, coverage: observation.coverage }, context, this.config);

    // --- symptom fusion -------------------------------------------------
    const symptomContext = this.symptoms.at(t);
    const thresholds = this.config.risk.thresholds;
    const effectiveScore = Math.min(100, risk.score + symptomContext.boost);
    const effective = {
      ...risk,
      score: effectiveScore,
      boost: symptomContext.boost,
      level: effectiveScore >= thresholds.danger ? 'danger' : effectiveScore >= thresholds.caution ? 'caution' : 'stable',
    };

    // Forecast runs on the effective score: the same trend is more urgent
    // when symptoms are on board, and horizons extend accordingly.
    this.forecast.push(t, effectiveScore, features);
    const forecast = this.forecast.result({ horizonScale: symptomContext.horizonScale });
    const deviation = this.baseline.deviation(features);
    const baseline = { warm: this.baseline.warm, progress: this.baseline.progress, deviation };

    const { state, actions, transition, policy } = decidePolicy(
      this.policy,
      { now: t, risk: effective, forecast, baseline, symptoms: symptomContext },
      this.config
    );
    this.policy = policy;

    // Symptom activation / clearing events.
    const activeNow = new Set(symptomContext.active.map((item) => item.key));
    for (const key of activeNow) {
      if (!this._activeSymptoms.has(key)) {
        this.journal.record({ t, type: 'symptom', action: 'active', symptom: key, level: Number(symptomContext.levels[key].toFixed(3)) });
      }
    }
    for (const key of this._activeSymptoms) {
      if (!activeNow.has(key)) this.journal.record({ t, type: 'symptom', action: 'cleared', symptom: key });
    }
    this._activeSymptoms = activeNow;

    if (!wasWarm && baseline.warm) {
      this.journal.record({ t, type: 'calibration', message: `Personal baseline learned (${this.stats.frames} frames)` });
    }

    // Acute episodes: peak score and duration, for the session journal + staging.
    if (ACUTE.has(state)) {
      if (!this._episode) this._episode = { start: t, maxScore: risk.score };
      this._episode.maxScore = Math.max(this._episode.maxScore, risk.score);
    } else if (this._episode) {
      const episode = { start: this._episode.start, end: t, maxScore: this._episode.maxScore };
      this.stats.episodes.push(episode);
      this.stager.noteEpisode({ t });
      this.journal.record({
        t,
        type: 'episode',
        ...episode,
        recovered: ['recovering', 'stable', 'caution'].includes(state),
      });
      this._episode = null;
    }

    if (transition) {
      this.journal.record({
        t,
        type: 'state',
        from: transition.from,
        to: transition.to,
        score: effective.score,
        rawScore: risk.score,
        boost: symptomContext.boost,
      });
    }
    for (const action of actions) {
      this.stats.actionCounts[action.kind] = (this.stats.actionCounts[action.kind] ?? 0) + 1;
      this.journal.record({
        t,
        type: 'action',
        kind: action.kind,
        urgency: action.urgency,
        text: action.text,
        reason: action.reason,
      });
    }
    this.stats.maxScore = Math.max(this.stats.maxScore, risk.score);

    // --- staging ---------------------------------------------------------
    const bandLevel = forecast.imminent ? 'imminent' : effective.level;
    this.stager.update({ t, level: bandLevel, boost: symptomContext.boost, features, symptoms: symptomContext });
    const stage = this.stager.result();
    if (this._lastStage == null) {
      this._lastStage = stage.stage;
      this.journal.record({ t, type: 'stage', to: stage.stage, score: stage.score, provisional: stage.provisional });
    } else if (stage.stage !== this._lastStage) {
      this.journal.record({ t, type: 'stage', from: this._lastStage, to: stage.stage, score: stage.score, drivers: stage.drivers });
      this._lastStage = stage.stage;
    }

    return {
      t,
      state,
      features,
      coverage: risk.coverage,
      risk,
      effective,
      forecast,
      baseline,
      symptoms: symptomContext,
      stage,
      actions,
    };
  }

  /** Current staged classification (recomputed from the evidence window). */
  stage() {
    return this.stager.result();
  }

  /** Stage-appropriate advice and care guidance for the current state. */
  carePlan() {
    const staged = this.stage();
    const symptomContext = this.symptoms.at(this.lastT);
    return carePlan(staged, { symptoms: symptomContext, episodeCount: this.stats.episodes.length });
  }

  summary() {
    return {
      ...this.stats,
      stage: this._lastStage,
      episodes: [...this.stats.episodes],
      actionCounts: { ...this.stats.actionCounts },
    };
  }
}
