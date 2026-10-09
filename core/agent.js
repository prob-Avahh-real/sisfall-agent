// SisFallAgent: the perception -> reasoning -> decision loop.
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
import { buildWindowVector } from './learned.js';
import { PatientStager } from './staging.js';
import { carePlan } from './care.js';
import { EnvironmentInference } from './environment.js';
import { TrainingSession } from './training.js';

const ACUTE = new Set(['imminent', 'danger']);

export class SisFallAgent {
  constructor({ config, journal, model = null } = {}) {
    this.config = mergeConfig(DEFAULT_CONFIG, config);
    this.journal = journal ?? new Journal();
    this.model = model; // optional LearnedRiskModel; the rule scorer remains the default
    this._featureBuf = [];
    this.baseline = new PersonalBaseline(this.config);
    this.forecast = new RiskForecast(this.config);
    this.symptoms = new SymptomState(this.config);
    this.stager = new PatientStager(this.config);
    this._envInference = new EnvironmentInference(this.config);
    this.training = { active: false, session: null, source: null, startedAt: null, lastSummary: null };
    this.practice = { active: false, name: null };
    this._trainingScores = [];
    this.policy = createPolicyState(0);
    this.lastT = 0;
    this._episode = null;
    this._activeSymptoms = new Set();
    this._lastStage = null;
    this._lastEnvKey = null;
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

  /** 用户回答环境询问。yes=true 确认环境风险一段时间（预警提前），否则驳回并静默。 */
  ingestEnvironmentAnswer({ t = this.lastT, yes = false } = {}) {
    const snapshot = this._envInference.answer({ t, yes });
    this.journal.record({
      t,
      type: 'environment',
      action: yes ? 'confirmed' : 'dismissed',
      confirmedHoldSec: yes ? this.config.risk.environment.inference.confirmedHoldSec : 0,
    });
    return {
      ...snapshot,
      advice: yes
        ? '已记录：环境风险。未来一段时间预警会提前，请放慢脚步。'
        : '已记录：不调整。如有不适请报告症状。',
    };
  }

  /**
   * 练习活动（如八段锦跟练）：与训练共用"预期波动"语义——进行中暂缓
   * 注意级提示（预警/危险不降级）。得分汇总由调用方记入 journal。
   */
  setPractice(active, name = null) {
    this.practice = active ? { active: true, name } : { active: false, name: null };
    if (active) this.journal.record({ t: this.lastT, type: 'practice', action: 'start', name });
  }

  /** 开始一次康复训练会话（动作按当前阶段选择）。 */
  startTraining(t = this.lastT, { source = 'manual' } = {}) {
    if (this.training.active) return { ok: false, reason: '训练已在进行中' };
    const stage = this.stager.result().stage;
    const session = new TrainingSession({ stage, config: this.config, now: t });
    this.training = { active: true, session, source, startedAt: t, lastSummary: this.training.lastSummary };
    this._trainingScores = [];
    this.journal.record({ t, type: 'training', action: 'start', stage, source, exercises: session.plan.length });
    return { ok: true, stage, plan: session.plan, current: session.currentAt(t) };
  }

  /** 查询训练进度（纯查询，无副作用）。 */
  trainingProgress(t = this.lastT) {
    if (!this.training.active) return null;
    return this.training.session.currentAt(t);
  }

  /** 结束训练（自然完成或手动）。返回会话摘要，并入 journal。 */
  finishTraining(t = this.lastT, { completed = true } = {}) {
    if (!this.training.active) return null;
    const session = this.training.session;
    const scores = this._trainingScores;
    const summary = {
      ...session.summary({ t, completed }),
      source: this.training.source,
      meanScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      maxScore: scores.length ? Math.max(...scores) : 0,
    };
    this.training = { active: false, session: null, source: null, startedAt: null, lastSummary: summary };
    this._trainingScores = [];
    this.journal.record({ t, type: 'training', action: completed ? 'finish' : 'stopped', ...summary });
    return summary;
  }

  /**
   * @param {object} observation { t, features, coverage?, context? }
   * @returns {object} step { t, state, features, coverage, risk, effective,
   *   forecast, baseline, symptoms, environment, stage, actions }
   */
  ingest(observation = {}) {
    const { t = this.lastT, features = {}, context = {} } = observation;
    this.lastT = t;
    this.stats.frames += 1;
    if (this.stats.startedAt == null) this.stats.startedAt = t;

    const wasWarm = this.baseline.warm;
    this.baseline.update(features);
    let risk = assessRisk({ ...features, coverage: observation.coverage }, context, this.config);

    // Optional learned scorer (M3) behind the same risk contract: it consumes a
    // ~1 s feature window and, when scoreable, replaces the rule score while
    // keeping the rule score available as `ruleScore` for audit.
    if (this.model) {
      const buffer = this._featureBuf;
      buffer.push({ t, features, coverage: risk.coverage });
      while (buffer.length && buffer[0].t < t - this.config.learned.bufferSec) buffer.shift();
      const vector = buildWindowVector(buffer, {
        minSpanSec: this.config.learned.minWindowSec,
        windowSec: this.config.learned.windowSec,
      });
      if (vector) {
        const learned = this.model.score(vector, this.config);
        const bands = this.config.risk.thresholds;
        risk = {
          ...risk,
          ruleScore: risk.score,
          score: learned.score,
          level: learned.score >= bands.danger ? 'danger' : learned.score >= bands.caution ? 'caution' : 'stable',
          drivers: learned.drivers,
          model: { probability: learned.probability, contributions: learned.contributions },
        };
      }
    }

    // --- symptom fusion -------------------------------------------------
    const symptomContext = this.symptoms.at(t);
    const thresholds = this.config.risk.thresholds;
    const effectiveScore = Math.min(100, risk.score + symptomContext.boost);
    // 症状在场时"注意"入口阈值下调（同样的分数，头晕时更值得提醒）——
    // 这是"同一姿态在症状下更危险"的第二条表达路径（第一条是 boost 本身）。
    const symptomCaution = symptomContext.boost >= (this.config.symptoms?.labelBoostFloor ?? 5);
    const cautionEntry = symptomCaution
      ? this.config.symptoms?.cautionThreshold ?? thresholds.caution
      : thresholds.caution;
    const effective = {
      ...risk,
      score: effectiveScore,
      boost: symptomContext.boost,
      level: effectiveScore >= thresholds.danger ? 'danger' : effectiveScore >= cautionEntry ? 'caution' : 'stable',
    };
    if (this.training.active) this._trainingScores.push(effectiveScore);

    // Environmental context: explicit injection (tests / demo / replay) plus
    // sensor inference (slip micro-event -> bounded question -> user answer).
    // Neither adds to the score; both shorten warning horizons through the
    // sensitivity channel.
    const envCfg = this.config.risk.environment?.horizonScale ?? {};
    const explicitEnvScale = Math.min(
      context.obstacle ? envCfg.obstacle ?? 1 : 1,
      context.lowLight ? envCfg.lowLight ?? 1 : 1
    );
    this._envInference.update({ t, features });
    const inferred = this._envInference.snapshot(t);
    const horizonScale = Math.min(
      symptomContext.horizonScale,
      explicitEnvScale,
      this._envInference.sensitivityScale(t)
    );
    const environment = {
      obstacle: context.obstacle === true,
      lowLight: context.lowLight === true,
      horizonScale,
      inferred: { active: inferred.active, confirmed: inferred.confirmed, lastEvent: inferred.lastEvent },
      pendingQuestion: inferred.pendingQuestion,
    };
    const envKey = `${environment.obstacle}|${environment.lowLight}|${inferred.active}`;
    if (this._lastEnvKey !== envKey) {
      this._lastEnvKey = envKey;
      this.journal.record({
        t,
        type: 'context',
        obstacle: environment.obstacle,
        lowLight: environment.lowLight,
        inferredActive: inferred.active,
        horizonScale,
      });
    }

    // Forecast runs on the effective score: the same trend is more urgent
    // when symptoms or the environment are on board; horizons shrink accordingly.
    this.forecast.push(t, effectiveScore, features);
    const forecast = this.forecast.result({ horizonScale });
    const deviation = this.baseline.deviation(features);
    const baseline = { warm: this.baseline.warm, progress: this.baseline.progress, deviation };

    const trainingContext = this.training.active
      ? { active: true, exercise: this.training.session.currentAt(t).exercise?.name ?? null }
      : this.practice.active
        ? { active: true, exercise: this.practice.name }
        : { active: false };
    const { state, actions: policyActions, transition, policy } = decidePolicy(
      this.policy,
      { now: t, risk: effective, forecast, baseline, symptoms: symptomContext, training: trainingContext },
      this.config
    );
    this.policy = policy;
    const actions = [...policyActions];
    // Active inquiry: a fresh slip micro-event in a settled state turns into
    // one bounded question. The user's answer is the ground truth — the agent
    // never assumes (see core/environment.js).
    if (this._envInference.shouldAsk(t, state)) {
      const question = this._envInference.pendingQuestion(t);
      actions.push({
        kind: 'question',
        urgency: 'low',
        text: question.text,
        detail: question.detail,
        reason: '疑似环境风险',
        questionId: question.id,
      });
    }

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
        ...(risk.ruleScore != null ? { ruleScore: risk.ruleScore } : {}),
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
      environment,
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
