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
    label: '0 级 · 平稳',
    summary: '本时间段内未见明显不稳定。',
    reviewInDays: 7,
    advice: [
      { kind: 'activity', text: '坚持每天步行 20–30 分钟，维持力量与平衡。' },
      { kind: 'monitoring', text: '保持签到——智能体在后台持续评估。' },
    ],
  },
  {
    stage: 1,
    key: 'guarded',
    label: '1 级 · 需留意',
    summary: '出现早期不稳定迹象，值得现在就处理。',
    reviewInDays: 3,
    advice: [
      { kind: 'activity', text: '每天加入简短平衡练习（扶稳下的重心转移、慢速坐起 ×5）。' },
      { kind: 'activity', text: '起身口诀：坐起后先坐稳片刻，扶稳慢站，站稳再迈步；服药后与饭后尤其放慢。' },
      { kind: 'environment', text: '检查常用路线的鞋具、地毯与照明。' },
      { kind: 'monitoring', text: '行走时保持 SisFall 运行；认真对待“注意”提示。' },
    ],
  },
  {
    stage: 2,
    key: 'fragile',
    label: '2 级 · 脆弱',
    summary: '明显的跌倒风险模式——请在支持下行动。',
    reviewInDays: 2,
    advice: [
      { kind: 'activity', text: '在支撑下行走（扶手、手杖或有人陪同）；避免不平整地面与昏暗光线。' },
      { kind: 'activity', text: '起身与站起分两步完成，中间停顿片刻再迈步；服药后与饭后尤其放慢。' },
      { kind: 'environment', text: '加装扶手与夜灯；清理走道上的松散线缆。' },
      { kind: 'clinical', text: '咨询康复治疗师，制定力量与平衡训练方案。' },
      { kind: 'monitoring', text: '建议有人陪同行走；每天签到两次。' },
    ],
  },
  {
    stage: 3,
    key: 'high-risk',
    label: '3 级 · 高风险',
    summary: '持续高风险——建议升级处理。',
    reviewInDays: 1,
    escalation: true,
    advice: [
      { kind: 'clinical', text: '联系您的医生，说明近期不稳定情况，并带上会话日志。' },
      { kind: 'care', text: '告知照护者或紧急联系人近期情况。' },
      { kind: 'activity', text: '避免独自行走；使用医嘱辅具。' },
      { kind: 'activity', text: '起身全程有人看护或扶稳；出现发晕立即坐回，服药后与饭后避免立即走动。' },
      { kind: 'monitoring', text: '保持持续监测，即时告警已开启。' },
    ],
  },
];

// Symptom-driven additions appended to whatever the stage plan says.
const SYMPTOM_ADDONS = {
  dizziness: { kind: 'activity', text: '起身发晕期间——变换体位放慢，站立前先坐稳片刻。' },
  fatigue: { kind: 'activity', text: '疲劳期间——在感到需要之前安排休息。' },
  sleepDebt: { kind: 'activity', text: '睡眠不足会提高当日风险——步行尽量短而熟悉。' },
  medicationOff: { kind: 'clinical', text: '药效可能减退——请记录不稳定的时间点，供医生参考。' },
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
    advice.push({ ...SYMPTOM_ADDONS[symptoms.top], rationale: `已报告：${symptoms.topLabel}` });
  }
  if (episodeCount > 0 && definition.stage < 2) {
    advice.push({
      kind: 'monitoring',
      text: '检测到近期一次“差点跌倒”——请排查诱因（地点、时段、步速）。',
      rationale: '“差点跌倒”可预示未来跌倒。',
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
