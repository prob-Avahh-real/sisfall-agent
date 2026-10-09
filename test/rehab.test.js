// 康复训练（core/training.js）的测试：动作库、会话时间轴、定时纯函数、语音命令。
// 注意：模型训练的测试在 test/training.test.js（M3 管线），此处是"康复训练"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TrainingSession, planForStage, isScheduleDue, isDoseDue, dayKey, matchVoiceCommand } from '../core/training.js';
import { DEFAULT_CONFIG } from '../core/config.js';

test('0-1 级取站立动作库，2 级以上取坐位/扶稳库，全部带依据', () => {
  const light = planForStage(0, DEFAULT_CONFIG);
  assert.equal(light[0].id, 'big-steps');
  assert.equal(light.length, DEFAULT_CONFIG.training.exercisesPerSession);
  assert.ok(light.every((item) => item.safety && item.evidence));
  const metronome = light.find((item) => item.id === 'metronome-walk');
  assert.equal(metronome.bpm, 100, '节拍行走带推荐 BPM');
  assert.ok(light.filter((item) => item.bpm).length >= 2, '至少两个动作带节拍');
  const supported = planForStage(2, DEFAULT_CONFIG);
  assert.equal(supported[0].id, 'seated-big-arms');
  assert.ok(supported.every((item) => item.safety && item.evidence));
});

test('时间轴：准备 →（动作 → 休息）× n → 结束 → done', () => {
  const session = new TrainingSession({ stage: 0, config: DEFAULT_CONFIG, now: 100 });
  const cfg = DEFAULT_CONFIG.training;
  assert.equal(session.currentAt(100.5).phase, 'intro');

  const first = session.currentAt(100 + cfg.introSec + 0.5);
  assert.equal(first.phase, 'exercise');
  assert.equal(first.exercise.id, 'big-steps');
  assert.equal(first.index, 0);

  const restAt = 100 + cfg.introSec + session.plan[0].seconds + 0.1;
  assert.equal(session.currentAt(restAt).phase, 'rest');

  const secondAt = 100 + cfg.introSec + session.plan[0].seconds + cfg.restSec + 0.1;
  const second = session.currentAt(secondAt);
  assert.equal(second.phase, 'exercise');
  assert.equal(second.index, 1);

  const doneAt = 100 + session.totalSec + 1;
  assert.equal(session.currentAt(doneAt).phase, 'done');

  const summary = session.summary({ t: doneAt, completed: true });
  assert.equal(summary.doneExercises, session.plan.length);
  assert.ok(summary.durationSec > session.plan.length * 20);
});

test('提前结束只统计已完成的动作', () => {
  const session = new TrainingSession({ stage: 0, config: DEFAULT_CONFIG, now: 0 });
  const t = DEFAULT_CONFIG.training.introSec + session.plan[0].seconds + 1;
  const summary = session.summary({ t, completed: false });
  assert.equal(summary.completed, false);
  assert.equal(summary.doneExercises, 1);
  assert.equal(summary.totalExercises, session.plan.length);
});

test('定时计划在到点后 10 分钟窗口内触发，且当天只触发一次', () => {
  const schedule = { enabled: true, time: '09:00' };
  const at = (h, m) => new Date(2026, 9, 9, h, m);
  assert.equal(isScheduleDue(schedule, at(8, 59)), false);
  assert.equal(isScheduleDue(schedule, at(9, 0)), true);
  assert.equal(isScheduleDue(schedule, at(9, 10)), true);
  assert.equal(isScheduleDue(schedule, at(9, 11)), false);
  assert.equal(isScheduleDue(schedule, at(9, 5), dayKey(at(9, 5))), false); // 当天已触发
  assert.equal(isScheduleDue(schedule, at(9, 5), dayKey(new Date(2026, 9, 8, 9, 0))), true); // 昨天触发过，今天可再触发
  assert.equal(isScheduleDue({ enabled: false, time: '09:00' }, at(9, 0)), false);
});

test('语音命令：中文关键词匹配，无关语句不误触', () => {
  assert.equal(matchVoiceCommand('开始训练'), 'start');
  assert.equal(matchVoiceCommand('我想做康复训练'), 'start');
  assert.equal(matchVoiceCommand('练一练'), 'start');
  assert.equal(matchVoiceCommand('停止训练'), 'stop');
  assert.equal(matchVoiceCommand('结束训练吧'), 'stop');
  assert.equal(matchVoiceCommand('今天天气不错'), null);
  assert.equal(matchVoiceCommand(''), null);
});

test('服药提醒：到点窗口内返回一次，当天不重复', () => {
  const times = ['08:00', '20:00'];
  const at = (h, m) => new Date(2026, 9, 9, h, m);
  assert.equal(isDoseDue(times, at(7, 59), {}), null);
  assert.equal(isDoseDue(times, at(8, 0), {}), '08:00');
  assert.equal(isDoseDue(times, at(8, 11), {}), null);
  const fired = { [`${dayKey(at(8, 5))}:08:00`]: true };
  assert.equal(isDoseDue(times, at(8, 5), fired), null);
  assert.equal(isDoseDue(times, at(20, 3), fired), '20:00');
  assert.equal(isDoseDue([], at(8, 0), {}), null);
});
