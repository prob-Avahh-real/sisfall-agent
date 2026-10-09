// 八段锦跟练模块（core/baduanjin.js）的测试：标准轨迹、归一化、对比打分、
// 时滞匹配、时间轴与聚合。通过"把标准姿势渲染为图像 landmarks"来构造
// 可精确校验的合成输入（数学上可逆，评分必须还原为 100 分）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BADUANJIN_MOVES,
  POSE_LIBRARY,
  BaduanjinSession,
  referencePoseAt,
  normalizeSkeleton,
  comparePoses,
  matchScore,
  aggregateScores,
} from '../core/baduanjin.js';
import { DEFAULT_CONFIG } from '../core/config.js';

// 工具：归一化姿势 → 图像 landmarks（hipMid=(0.5,0.6)、肩宽=0.2）
const SCALE = 0.2;
const ORIGIN = { x: 0.5, y: 0.6 };
function landmarksFromPose(pose) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5 }));
  for (const [index, p] of Object.entries(pose)) {
    points[Number(index)] = { x: ORIGIN.x + p.x * SCALE, y: ORIGIN.y + p.y * SCALE };
  }
  return points;
}

test('8 式结构：名称/口令/依据/关键帧姿势全部有效', () => {
  assert.equal(BADUANJIN_MOVES.length, 8);
  for (const move of BADUANJIN_MOVES) {
    assert.ok(move.id && move.name && move.cue && move.evidence, move.id);
    assert.ok(move.keyframes.length >= 2, move.id);
    assert.equal(move.keyframes[0].at, 0);
    assert.equal(move.keyframes[move.keyframes.length - 1].at, 1);
    for (const frame of move.keyframes) {
      assert.ok(POSE_LIBRARY[frame.pose], `${move.id} 引用了未知姿势 ${frame.pose}`);
    }
  }
});

test('标准轨迹：关键帧处等于姿势本身，中间平滑插值', () => {
  const tuotian = BADUANJIN_MOVES.find((move) => move.id === 'tuotian');
  const atUp = referencePoseAt(tuotian, 0.5);
  assert.ok(Math.abs(atUp[15].y - POSE_LIBRARY.up[15].y) < 1e-9);
  const atStart = referencePoseAt(tuotian, 0);
  assert.ok(Math.abs(atStart[15].y - POSE_LIBRARY.stand[15].y) < 1e-9);
  const mid = referencePoseAt(tuotian, 0.35); // cross(0.2) → up(0.5) 之间
  assert.ok(mid[15].y < POSE_LIBRARY.cross[15].y && mid[15].y > POSE_LIBRARY.up[15].y, `插值 ${mid[15].y}`);
  assert.equal(referencePoseAt({ keyframes: [] }, 0.5), null);
});

test('归一化：平移缩放的骨骼可精确还原回标准空间', () => {
  const normalized = normalizeSkeleton(landmarksFromPose(POSE_LIBRARY.stand), 1);
  assert.ok(normalized);
  for (const [index, expected] of Object.entries(POSE_LIBRARY.stand)) {
    const got = normalized.points[Number(index)];
    assert.ok(Math.abs(got.x - expected.x) < 1e-6 && Math.abs(got.y - expected.y) < 1e-6, `关节 ${index}`);
  }
  assert.equal(normalizeSkeleton([{}, {}]), null);
});

test('对比打分：标准姿势满分；偏离姿势低分并暴露偏离关节', () => {
  const exact = comparePoses(POSE_LIBRARY.up, POSE_LIBRARY.up);
  assert.equal(exact.score, 100);
  assert.ok(Object.values(exact.jointStates).every((state) => state === 'ok'));

  const mismatched = comparePoses(POSE_LIBRARY.up, POSE_LIBRARY.stand); // 手没举起来
  assert.ok(mismatched.score <= 60, `偏离 ${mismatched.score}`);
  assert.equal(mismatched.jointStates[15], 'off');
});

test('matchScore：时滞窗口容忍提前/滞后，未做动作仍低分', () => {
  const tuotian = BADUANJIN_MOVES.find((move) => move.id === 'tuotian');
  const upPose = landmarksFromPose(POSE_LIBRARY.up);
  const onTime = matchScore(tuotian, upPose, 0.5, { aspect: 1 });
  assert.ok(onTime.score >= 90, `准时 ${onTime.score}`);
  const early = matchScore(tuotian, upPose, 0.35, { aspect: 1 });
  assert.ok(early.score >= 85, `提前 ${early.score}`);
  const notYet = matchScore(tuotian, landmarksFromPose(POSE_LIBRARY.stand), 0.5, { aspect: 1 });
  assert.ok(notYet.score <= 60, `没做 ${notYet.score}`);
  assert.ok(onTime.reference && onTime.scale > 0 && onTime.origin, '返回参考骨架与坐标锚');
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
