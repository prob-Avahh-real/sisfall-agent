// Care plans: maps a staged classification onto concrete, stage-appropriate
// advice — activity, environment, clinical, and monitoring — plus escalation
// guidance. Advice is a strategy table (data, not branching logic), so a new
// stage or a localized plan is a content change, not a code change.
//
// This is guidance for a prototype, not medical advice; stage 3 escalation
// means "recommend contacting a professional", nothing automatic.

export const STAGE_DEFINITIONS = [
  {
    stage: 0,
    key: 'steady',
    label: 'Stage 0 · Steady',
    summary: 'No meaningful instability detected in this window.',
    reviewInDays: 7,
    advice: [
      { kind: 'activity', text: 'Keep walking 20–30 minutes most days to maintain strength and balance.' },
      { kind: 'monitoring', text: 'Stay checked in — the agent keeps re-assessing in the background.' },
    ],
  },
  {
    stage: 1,
    key: 'guarded',
    label: 'Stage 1 · Guarded',
    summary: 'Early instability signs — worth acting on now.',
    reviewInDays: 3,
    advice: [
      { kind: 'activity', text: 'Add a short balance routine most days (heel-to-toe standing, slow sit-to-stand ×5).' },
      { kind: 'environment', text: 'Review footwear, rugs, and lighting along your usual routes.' },
      { kind: 'monitoring', text: 'Keep SteadyStep active during walks; treat caution cues as real.' },
    ],
  },
  {
    stage: 2,
    key: 'fragile',
    label: 'Stage 2 · Fragile',
    summary: 'Clear fall-risk pattern — act with support.',
    reviewInDays: 2,
    advice: [
      { kind: 'activity', text: 'Walk with support (rail, stick, or companion); avoid uneven ground and dim light.' },
      { kind: 'environment', text: 'Add grab bars and night lights; clear loose cables from walkways.' },
      { kind: 'clinical', text: 'Ask a physiotherapist about a strength-and-balance program.' },
      { kind: 'monitoring', text: 'Accompanied walks preferred; check in twice a day.' },
    ],
  },
  {
    stage: 3,
    key: 'high-risk',
    label: 'Stage 3 · High risk',
    summary: 'Sustained high risk — escalation advised.',
    reviewInDays: 1,
    escalation: true,
    advice: [
      { kind: 'clinical', text: 'Contact your clinician about the recent instability; bring the session journal.' },
      { kind: 'care', text: 'Inform a caregiver or emergency contact about this period.' },
      { kind: 'activity', text: 'Limit solo walking; use the prescribed assistive device.' },
      { kind: 'monitoring', text: 'Continuous monitoring and immediate alarm enabled.' },
    ],
  },
];

// Symptom-driven additions appended to whatever the stage plan says.
const SYMPTOM_ADDONS = {
  dizziness: { kind: 'activity', text: 'Dizziness active — stand up slowly and pause between position changes.' },
  fatigue: { kind: 'activity', text: 'Fatigue active — schedule rests before you feel you need them.' },
  sleepDebt: { kind: 'activity', text: 'Low sleep raises today’s risk — keep walks short and familiar.' },
  anxiety: { kind: 'monitoring', text: 'Anxiety active — slower steps and a wider stance help stability.' },
  pain: { kind: 'activity', text: 'Pain active — avoid loading the painful side during turns.' },
  medicationOff: { kind: 'clinical', text: 'Medication may be wearing off — note the timing of instability for your clinician.' },
};

/**
 * @param {object} staged result from PatientStager.result()
 * @param {object} [context] { symptoms, episodeCount }
 * @returns care plan { stage, label, headline, advice, escalation, reviewInDays }
 */
export function carePlan(staged, { symptoms = null, episodeCount = 0 } = {}) {
  const definition = STAGE_DEFINITIONS[staged?.stage ?? 0] ?? STAGE_DEFINITIONS[0];
  const advice = definition.advice.map((item) => ({ ...item }));

  if (symptoms && symptoms.top && SYMPTOM_ADDONS[symptoms.top]) {
    advice.push({ ...SYMPTOM_ADDONS[symptoms.top], rationale: `Reported: ${symptoms.topLabel}` });
  }
  if (episodeCount > 0 && definition.stage < 2) {
    advice.push({
      kind: 'monitoring',
      text: 'A recent near-fall was recorded — remove its trigger (that spot, that time of day, that pace).',
      rationale: 'Near-falls predict future falls.',
    });
  }

  return {
    stage: definition.stage,
    key: definition.key,
    label: definition.label,
    headline: definition.summary,
    provisional: staged?.provisional ?? true,
    escalation: definition.escalation === true,
    reviewInDays: definition.reviewInDays ?? 7,
    advice,
    drivers: staged?.drivers ?? [],
  };
}
