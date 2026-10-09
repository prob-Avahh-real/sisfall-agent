// PD 范围契约的强制测试：结构完整 + 用户可见输出不含诊断/处方/疗效语言。
// 契约本体在 core/pd-profile.js——功能增删以那里为准。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PD_PATIENT_ACTIONS, PD_AGENT_ACTIONS, PD_BOUNDARIES, PD_SOURCES, FORBIDDEN_TERMS } from '../core/pd-profile.js';
import { TRAINING_LIBRARY } from '../core/training.js';
import { SYMPTOM_KEYS, adviceFor } from '../core/symptoms.js';
import { carePlan } from '../core/care.js';
import { MUSIC_MODES } from '../core/music.js';
import { BADUANJIN_MOVES } from '../core/baduanjin.js';

test('范围契约结构完整：行动最小集 / agent 动作 / 边界 / 来源', () => {
  assert.ok(PD_PATIENT_ACTIONS.length >= 4, '患者行动最小集至少四类行动');
  const agentIds = new Set(PD_AGENT_ACTIONS.map((item) => item.id));
  for (const id of ['assess', 'cue', 'train', 'medication', 'journal']) {
    assert.ok(agentIds.has(id), `缺少 agent 动作：${id}`);
  }
  const boundaryIds = new Set(PD_BOUNDARIES.map((item) => item.id));
  for (const id of ['no-diagnosis', 'no-prescription', 'no-emergency', 'no-disease-claims', 'no-treatment-claim']) {
    assert.ok(boundaryIds.has(id), `缺少行为边界：${id}`);
  }
  assert.ok(PD_SOURCES.some((source) => source.id === 'cn-guideline-4th'), '国内指南在来源列表中');
  assert.ok(PD_SOURCES.some((source) => source.id === 'nice-ng71'), 'NICE NG71 在来源列表中');
});

function scan(label, texts) {
  for (const text of texts) {
    for (const term of FORBIDDEN_TERMS) {
      assert.ok(!String(text).includes(term), `${label} 含禁用词「${term}」：${text}`);
    }
  }
}

test('护理建议（全部阶段）不含诊断/处方语言', () => {
  for (let stage = 0; stage <= 3; stage += 1) {
    const plan = carePlan({ stage, provisional: false, drivers: [] });
    scan(`stage ${stage}`, plan.advice.map((item) => `${item.text} ${item.rationale ?? ''}`));
  }
});

test('症状建议不含诊断/处方语言', () => {
  scan('症状建议', SYMPTOM_KEYS.map((key) => adviceFor(key, 1200)));
});

test('训练动作库全部带 evidence 且文本合规', () => {
  for (const library of Object.values(TRAINING_LIBRARY)) {
    for (const item of library) {
      assert.ok(item.evidence, `${item.id} 缺少 evidence 依据字段`);
      scan(`动作 ${item.id}`, [item.name, item.cue, item.safety]);
    }
  }
});

test('音乐疗愈模式文案合规（不强声称疗效）', () => {
  scan('音乐疗愈', Object.values(MUSIC_MODES).map((mode) => `${mode.label} ${mode.description}`));
});

test('八段锦招式文案与依据合规', () => {
  for (const move of BADUANJIN_MOVES) {
    assert.ok(move.evidence, `${move.id} 缺少 evidence 字段`);
    scan(`八段锦 ${move.id}`, [move.name, move.cue, move.evidence]);
  }
});

test('起身（体位）管理要素存在：分步起身与诱因在症状与护理建议中均有覆盖', () => {
  // 症状建议：分步起身 + 诱因窗口
  const advice = adviceFor('dizziness', 0);
  assert.ok(advice.includes('坐稳'), '起身发晕建议含坐稳');
  assert.ok(advice.includes('缓慢站起'), '起身发晕建议含缓慢站起');
  assert.ok(advice.includes('服药后'), '症状建议含诱因窗口');
  // 护理建议：1-3 级都必须覆盖起身要点与诱因窗口（删除任一档即红）
  for (const stage of [1, 2, 3]) {
    const plan = carePlan({ stage, provisional: false, drivers: [] });
    assert.ok(plan.advice.some((item) => item.text.includes('起身')), `${stage} 级护理含起身要点`);
    assert.ok(plan.advice.some((item) => item.text.includes('服药后')), `${stage} 级护理含诱因窗口`);
  }
  const stage3 = carePlan({ stage: 3, provisional: false, drivers: [] });
  assert.ok(stage3.advice.some((item) => item.text.includes('发晕')), '3 级护理含发晕处置');
});
