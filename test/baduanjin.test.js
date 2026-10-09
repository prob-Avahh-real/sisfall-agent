// 八段锦跟练模块（core/baduanjin.js）的测试：结构、几何特征、逐式评分、
// 时间轴会话与聚合。评分用合成骨骼验证（接口对合成 landmarks 开放）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BADUANJIN_MOVES, BaduanjinSession, extractBaduanjinFeatures, scoreMove, aggregateScores } from '../core/baduanjin.js';
import { DEFAULT_CONFIG } from '../core/config.js';

// 合成骨骼：托天标准姿势（双手举过头、竖直站立）
function tuotianLandmarks() {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
  points[0] = { x: 0.5, y: 0.1 }; // 鼻
  points[11] = { x: 0.42, y: 0.25 }; points[12] = { x: 0.58, y: 0.25 }; // 肩
  points[13] = { x: 0.44, y: 0.14 }; points[14] = { x: 0.56, y: 0.14 }; // 肘（上举）
  points[15] = { x: 0.46, y: 0.02 }; points[16] = { x: 0.54, y: 0.02 }; // 腕（过头）
  points[23] = { x: 0.45, y: 0.55 }; points[24] = { x: 0.55, y: 0.55 }; // 髋
  return points;
}

test('8 式结构完整：名称/口令/依据/至少两个评分要素', () => {
  assert.equal(BADUANJIN_MOVES.length, 8);
  for (const move of BADUANJIN_MOVES) {
    assert.ok(move.id && move.name && move.cue && move.evidence, move.id);
    assert.ok(move.evaluators.length >= 2, move.id);
    for (const evaluator of move.evaluators) {
      assert.ok(evaluator.id && evaluator.label && typeof evaluator.test === 'function', `${move.id}.${evaluator.id}`);
    }
  }
});

test('特征提取：相对高度以躯干长为单位', () => {
  const features = extractBaduanjinFeatures(tuotianLandmarks());
  assert.ok(features);
  assert.ok(features.wristAboveHeadL > 0.2, `aboveHead ${features.wristAboveHeadL}`);
  assert.ok(Math.abs(features.torsoLean) < 1e-9);
  assert.equal(extractBaduanjinFeatures([{}, {}]), null);
});

test('评分：标准托天高分；垂手做托天低分且关节暴露偏离', () => {
  const move = BADUANJIN_MOVES.find((item) => item.id === 'tuotian');
  const good = scoreMove(move, tuotianLandmarks());
  assert.ok(good.score >= 85, `好动作 ${good.score}`);
  assert.equal(good.jointStates[15], 'ok');
  assert.ok(good.feedback.length === 0);

  const armsDown = tuotianLandmarks();
  armsDown[15] = { x: 0.42, y: 0.62 };
  armsDown[16] = { x: 0.58, y: 0.62 };
  const bad = scoreMove(move, armsDown);
  assert.ok(bad.score <= 70, `垂手 ${bad.score}`);
  assert.ok(good.score - bad.score >= 25, `区分度 ${good.score - bad.score}`);
  // 最差状态优先：手没举起来 → 腕关节必须显示偏离，不能被"双手齐平"盖住
  assert.equal(bad.jointStates[15], 'off');
  assert.ok(bad.feedback.includes('双手托至头上'));
});

test('时间轴：8 式推进到 done（短时长配置）', () => {
  const config = { ...DEFAULT_CONFIG, baduanjin: { moveSeconds: 2, transitionSec: 1 } };
  const session = new BaduanjinSession({ config, now: 100 });
  assert.equal(session.currentAt(100.5).phase, 'move');
  assert.equal(session.currentAt(100.5).index, 0);
  assert.equal(session.currentAt(102.5).phase, 'transition');
  assert.equal(session.currentAt(103.5).index, 1);
  assert.equal(session.currentAt(103.5).phase, 'move');
  assert.equal(session.currentAt(100 + session.totalSec + 1).phase, 'done');
});

test('非法时间不误报 done：undefined/NaN 返回 idle（时钟域错误的防线）', () => {
  const session = new BaduanjinSession({ config: DEFAULT_CONFIG, now: 50 });
  assert.equal(session.currentAt(undefined).phase, 'idle');
  assert.equal(session.currentAt(NaN).phase, 'idle');
  assert.equal(session.currentAt(50.5).phase, 'move'); // 正常时钟仍是 move
});

test('聚合：平均分、空帧处理与总量', () => {
  const summary = aggregateScores([
    { id: 'a', name: '甲', score: 80 },
    { id: 'b', name: '乙', score: 60 },
    { id: 'c', name: '丙', score: null },
  ]);
  assert.equal(summary.total, 70);
  assert.equal(summary.moves.length, 3);
  assert.equal(summary.moves[2].score, null);
  assert.equal(aggregateScores([]).total, null);
});
