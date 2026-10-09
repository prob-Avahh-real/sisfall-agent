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
    return 'You reported dizziness. Sit down and hold a stable surface now.';
  }
  if (cause === 'symptom') return `You reported ${symptoms?.topLabel ?? 'a symptom'}. Slow down and steady yourself.`;
  if (cause === 'deviation') return 'Your movement pattern changed from your usual walk. Take a steadying pause.';
  const top = drivers[0] ?? '';
  if (top === FEATURE_LABELS.hipDropSpeed) return 'Rapid lowering detected. Hold a stable surface now.';
  if (top === FEATURE_LABELS.torsoLean) return 'You are leaning past your balance point. Straighten up or sit down.';
  if (top === FEATURE_LABELS.lateralOffset) return 'Shift your weight back over your feet.';
  if (top === FEATURE_LABELS.kneeAsymmetry) return 'Even out your stance.';
  if (forecast.drivers && forecast.drivers.length) return 'Balance is trending unstable. Pause and steady yourself.';
  return 'Pause and steady yourself.';
}

/**
 * @param {object} policy previous policy state (from createPolicyState)
 * @param {object} input { now, risk, forecast, baseline }
 * @param {object} config full agent config
 * @returns {{ state, actions, transition, policy }} next state + actions + updated policy
 */
export function decidePolicy(policy, input, config = DEFAULT_CONFIG) {
  const cfg = config.policy;
  const { now, risk, forecast, baseline, symptoms = null } = input;
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
      emit({ kind: 'audio', urgency: 'high', text: 'warning tone', reason: 'Predicted balance loss' }, { force: true });
      nextPolicy.lastReminderAt.imminent = now;
    } else if (next === 'danger') {
      emit({ kind: 'instruction', urgency: 'high', text: instructionFor(risk.drivers, forecast, 'acute', symptoms), reason: risk.drivers[0] });
      emit({ kind: 'audio', urgency: 'high', text: 'warning tone', reason: 'Dangerous posture now' });
      nextPolicy.lastReminderAt.danger = now;
    } else if (next === 'caution') {
      emit({
        kind: 'instruction',
        urgency: 'medium',
        text:
          cautionCause === 'deviation'
            ? instructionFor(risk.drivers, forecast, 'deviation')
            : cautionCause === 'symptom'
              ? instructionFor(risk.drivers, forecast, 'symptom', symptoms)
              : 'Slow down and steady yourself.',
        reason:
          cautionCause === 'deviation'
            ? 'Unusual for you'
            : cautionCause === 'symptom'
              ? `Symptom context: ${symptoms?.topLabel ?? 'reported symptom'}`
              : risk.drivers[0] ?? 'Caution band',
      });
    } else if (next === 'recovering') {
      emit({ kind: 'visual', urgency: 'low', text: 'Recovered — good.', reason: 'Risk receded' });
    }
  } else if (ACUTE.has(next)) {
    // Persisting acute state: re-issue at a calm cadence, cooldown still applies.
    const lastRemind = nextPolicy.lastReminderAt[next] ?? -Infinity;
    if (now - lastRemind >= cfg.reminderIntervalSec) {
      emit({ kind: 'instruction', urgency: 'high', text: instructionFor(risk.drivers, forecast, 'acute', symptoms), reason: 'Risk persisting' });
      emit({ kind: 'audio', urgency: 'high', text: 'warning tone', reason: 'Risk persisting' });
      nextPolicy.lastReminderAt[next] = now;
    }
  }

  return { state: next, actions, transition, policy: nextPolicy };
}
