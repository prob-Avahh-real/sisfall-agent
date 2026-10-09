import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentInference } from '../core/environment.js';
import { DEFAULT_CONFIG } from '../core/config.js';

const config = DEFAULT_CONFIG;
const hz = 15;

function feed(inference, durationSec, featureAt, startT = 0) {
  let t = startT;
  for (let i = 0; i <= durationSec * hz; i += 1, t += 1 / hz) {
    inference.update({ t, features: featureAt(t) });
  }
  return t;
}

const calm = () => ({ hipDropSpeed: 0.05, torsoLean: 4, lateralOffset: 0.2 });
const slipAt = (eventT) => (t) => ({
  hipDropSpeed: t >= eventT && t < eventT + 0.5 ? 0.7 : 0.05,
  torsoLean: 4,
  lateralOffset: 0.2,
});

test('滑绊微事件（尖峰后恢复）被登记，并触发一次待答询问', () => {
  const inference = new EnvironmentInference(config);
  const base = feed(inference, 5, calm);
  const endT = feed(inference, 4, slipAt(5), base);
  assert.equal(inference.shouldAsk(endT, 'stable'), true);
  const question = inference.pendingQuestion(endT);
  assert.ok(question.text.includes('湿滑'));
  assert.ok(question.detail.includes('恢复'));
  // 已有待答询问时不重复问
  assert.equal(inference.shouldAsk(endT + 1, 'stable'), false);
});

test('平稳行走从不询问', () => {
  const inference = new EnvironmentInference(config);
  const endT = feed(inference, 60, calm);
  assert.equal(inference.shouldAsk(endT, 'stable'), false);
  assert.equal(inference.snapshot(endT).pendingQuestion, null);
});

test('持续下坠（真跌倒轮廓）不算微事件', () => {
  const inference = new EnvironmentInference(config);
  const base = feed(inference, 4, calm);
  const endT = feed(
    inference,
    6,
    (t) => ({ hipDropSpeed: t < 4 ? 0.05 : 0.8, torsoLean: 4, lateralOffset: 0.2 }),
    base
  );
  assert.equal(inference.shouldAsk(endT + 2, 'stable'), false);
});

test('急性状态下不询问；恢复后才问', () => {
  const inference = new EnvironmentInference(config);
  const base = feed(inference, 5, calm);
  const endT = feed(inference, 4, slipAt(5), base);
  assert.equal(inference.shouldAsk(endT, 'danger'), false); // 先处理急性状态
  assert.equal(inference.shouldAsk(endT + 0.5, 'stable'), true);
});

test('回答"是"激活灵敏度窗口，到期自动恢复', () => {
  const inference = new EnvironmentInference(config);
  feed(inference, 5, calm);
  const snapshot = inference.answer({ t: 10, yes: true });
  assert.equal(snapshot.active, true);
  assert.ok(inference.sensitivityScale(10) < 1);
  const hold = config.risk.environment.inference.confirmedHoldSec;
  assert.equal(inference.activeAt(10 + hold - 1), true);
  assert.equal(inference.activeAt(10 + hold + 1), false);
  assert.equal(inference.sensitivityScale(10 + hold + 1), 1);
});

test('回答"否"在静默期内不再询问', () => {
  const inference = new EnvironmentInference(config);
  feed(inference, 5, calm);
  inference.answer({ t: 10, yes: false });
  feed(inference, 4, slipAt(12), 10); // 静默期内的新事件
  assert.equal(inference.shouldAsk(17, 'stable'), false);
});

test('每场会话询问次数有上限', () => {
  const inference = new EnvironmentInference(config);
  const cfg = config.risk.environment.inference;
  let t = feed(inference, 4, calm);
  let asked = 0;
  for (let round = 0; round < 5; round += 1) {
    const eventT = t + 1;
    t = feed(inference, 4, slipAt(eventT), t); // 事件在 t+1，t+3 前后恢复
    const probe = t + 0.5;
    if (inference.shouldAsk(probe, 'stable')) {
      asked += 1;
      inference.answer({ t: probe, yes: true });
    }
    t = feed(inference, 120, calm, probe); // 越过询问冷却
  }
  assert.equal(asked, cfg.maxAsksPerSession);
});
