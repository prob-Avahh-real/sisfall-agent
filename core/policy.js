// Decision policy: a small state machine over {risk, forecast, baseline} that
// decides WHEN to act and WHAT to do — with hysteresis to prevent flapping,
// cooldowns to prevent nagging, and edge-triggered actions so a persisting
// state does not re-fire every frame.
//
// States: calibrating -> stable <-> caution <-> danger/imminent -> recovering
//   imminent  : forecast says danger is coming (the prediction tier)
//   danger    : posture is dangerous now
//   caution   : absolute caution band, or unusual-for-you pattern
//   recovering: just left an acute state; acknowledges the recovery
//
// The policy is pure: it receives the previous policy state and returns the
// next one plus the actions to run. Side effects (sound, UI) are the caller's.

import { DEFAULT_CONFIG } from './config.js';
import { FEATURE_LABELS } from './features.js';

const ACUTE = new Set(['imminent', 'danger']);

export function createPolicyState(now = 0) {
  return {
    state: 'calibrating',
    since: now,
    recoveringUntil: 0,
    lastActionAt: {},
    lastReminderAt: {},
  };
}

function instructionFor(drivers = [], forecast = {}, cause = '', symptoms = null) {
  if (symptoms && symptoms.top === 'dizziness' && cause !== 'deviation') {
    return '您报告了起身发晕。请先坐稳，再缓慢站起。';
  }
  if (cause === 'symptom') return `您报告了${symptoms?.topLabel ?? '症状'}。请放慢速度，稳住身体。`;
  if (cause === 'deviation') return '您的步态与平时不同。请暂停片刻，稳住身体。';
  const top = drivers[0] ?? '';
  if (top === FEATURE_LABELS.hipDropSpeed) return '检测到快速下坠。请立即扶稳。';
  if (top === FEATURE_LABELS.torsoLean) return '身体前倾超过平衡点。请站直或坐下。';
  if (top === FEATURE_LABELS.lateralOffset) return '请将重心移回双脚上方。';
  if (top === FEATURE_LABELS.kneeAsymmetry) return '请均衡站立重心。';
  if (forecast.drivers && forecast.drivers.length) return '平衡呈恶化趋势。请暂停并稳住身体。';
  return '请暂停并稳住身体。';
}

/**
 * @param {object} policy previous policy state (from createPolicyState)
 * @param {object} input { now, risk, forecast, baseline }
 * @param {object} config full agent config
 * @returns {{ state, actions, transition, policy }} next state + actions + updated policy
 */
export function decidePolicy(policy, input, config = DEFAULT_CONFIG) {
  const cfg = config.policy;
  const { now, risk, forecast, baseline, symptoms = null, training = null } = input;
  const prev = policy.state;

  let next = prev;
  let recoveringUntil = policy.recoveringUntil;
  let cautionCause = 'absolute';

  // --- state derivation (order encodes priority) ---
  if (!baseline.warm) {
    next = 'calibrating';
  } else if (risk.level === 'danger') {
    next = 'danger'; // actual danger outranks a prediction
  } else if (forecast.imminent) {
    next = 'imminent';
  } else if (prev === 'recovering') {
    next = now >= recoveringUntil ? (risk.level === 'caution' ? 'caution' : 'stable') : 'recovering';
  } else if (ACUTE.has(prev)) {
    if (risk.score > cfg.dangerExit) {
      next = prev; // hysteresis: hold until clearly below the exit line
    } else {
      next = 'recovering';
      recoveringUntil = now + cfg.recoverHoldSec;
    }
  } else if (risk.level === 'caution') {
    next = 'caution';
    cautionCause =
      symptoms && symptoms.boost >= (config.symptoms?.labelBoostFloor ?? 5) ? 'symptom' : 'absolute';
  } else if (prev === 'caution' && risk.score > cfg.cautionExit) {
    next = 'caution'; // hysteresis hold
  } else if (
    baseline.deviation &&
    baseline.deviation.level === 'outside' &&
    risk.score >= cfg.deviationScoreFloor
  ) {
    next = 'caution';
    cautionCause = 'deviation';
  } else if (forecast.projectedLevel === 'caution') {
    next = 'caution';
    cautionCause = 'trend';
  } else {
    next = 'stable';
  }

  // --- actions ---
  const nextPolicy = {
    state: next,
    since: next !== prev ? now : policy.since,
    recoveringUntil,
    lastActionAt: { ...policy.lastActionAt },
    lastReminderAt: { ...policy.lastReminderAt },
  };
  const actions = [];
  const transition = next !== prev ? { from: prev, to: next } : null;

  const emit = (action, { force = false } = {}) => {
    const cooldown =
      action.kind === 'audio' ? cfg.audioCooldownSec : action.kind === 'instruction' ? cfg.cueCooldownSec : 0;
    const last = nextPolicy.lastActionAt[action.kind] ?? -Infinity;
    if (!force && cooldown > 0 && now - last < cooldown) return false;
    nextPolicy.lastActionAt[action.kind] = now;
    actions.push(action);
    return true;
  };

  if (transition) {
    if (next === 'imminent') {
      emit(
        {
          kind: 'instruction',
          urgency: 'high',
          text: instructionFor(risk.drivers, forecast, 'acute', symptoms),
          reason: risk.drivers[0],
        },
        { force: true }
      );
      emit({ kind: 'audio', urgency: 'high', text: '警告音', reason: '预测将失衡' }, { force: true });
      nextPolicy.lastReminderAt.imminent = now;
    } else if (next === 'danger') {
      emit({ kind: 'instruction', urgency: 'high', text: instructionFor(risk.drivers, forecast, 'acute', symptoms), reason: risk.drivers[0] });
      emit({ kind: 'audio', urgency: 'high', text: '警告音', reason: '当前姿态危险' });
      nextPolicy.lastReminderAt.danger = now;
    } else if (next === 'caution') {
      if (training?.active && config.training?.dampenCaution) {
        // 训练中波动属预期：暂缓"注意"级提示，但记录 note 供审计。
        // 预警/危险级（imminent/danger）绝不降级——安全边界不动。
        emit({
          kind: 'note',
          urgency: 'low',
          text: `训练中：已暂缓注意提示（${training.exercise ?? '训练动作'}）`,
          reason: '训练中波动属预期',
        });
      } else {
        emit({
          kind: 'instruction',
          urgency: 'medium',
          text:
            cautionCause === 'deviation'
              ? instructionFor(risk.drivers, forecast, 'deviation')
              : cautionCause === 'symptom'
                ? instructionFor(risk.drivers, forecast, 'symptom', symptoms)
                : '请放慢速度，稳住身体。',
          reason:
            cautionCause === 'deviation'
              ? '与您平时不同'
              : cautionCause === 'symptom'
                ? `症状背景：${symptoms?.topLabel ?? '已报告症状'}`
                : risk.drivers[0] ?? '注意区间',
        });
      }
    } else if (next === 'recovering') {
      emit({ kind: 'visual', urgency: 'low', text: '已恢复，很好。', reason: '风险消退' });
    }
  } else if (ACUTE.has(next)) {
    // Persisting acute state: re-issue at a calm cadence, cooldown still applies.
    const lastRemind = nextPolicy.lastReminderAt[next] ?? -Infinity;
    if (now - lastRemind >= cfg.reminderIntervalSec) {
      emit({ kind: 'instruction', urgency: 'high', text: instructionFor(risk.drivers, forecast, 'acute', symptoms), reason: '风险持续' });
      emit({ kind: 'audio', urgency: 'high', text: '警告音', reason: '风险持续' });
      nextPolicy.lastReminderAt[next] = now;
    }
  }

  return { state: next, actions, transition, policy: nextPolicy };
}
