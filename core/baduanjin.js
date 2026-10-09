// 八段锦跟练与打分：8 式动作库、每式 2-3 个可解释的评分要素、时间轴会话、
// 关节反馈（供火柴人染色）。正面摄像头可观测的几何特征优先——例如
// "往后瞧"一式依赖转头，正面视角不可靠，因此该式的评分侧重躯干端正。
//
// 定位（见 core/pd-profile.js）：属于 train（训练引导）范围内的传统功法
// 练习——八段锦常见于中老年平衡与柔韧维持的康复实践；打分是**练习反馈**
// （幅度/对称/稳定），不是医疗评估，不声称疗效。
//
// 评分全部基于 33 点骨骼（MediaPipe 索引）的可解释规则，逐帧输出 0-100，
// 与本项目"规则可审计"的口径一致；接口对合成 landmarks 开放，便于测试。

import { DEFAULT_CONFIG } from './config.js';

export const LANDMARK_INDEX = {
  nose: 0,
  shoulderL: 11, shoulderR: 12,
  elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16,
  hipL: 23, hipR: 24,
};

const clamp01 = (value) => Math.min(1, Math.max(0, value));
/** value 从 from（记 0 分）线性到 to（记 1 分），越界自动钳制。 */
const ramp = (value, from, to) => clamp01((value - from) / (to - from));
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function point(landmarks, index) {
  const p = landmarks?.[index];
  if (!p) return null;
  const x = finite(p.x);
  const y = finite(p.y);
  return x == null || y == null ? null : { x, y };
}

function angleBend(joint, a, b) {
  if (!joint || !a || !b) return 180;
  const v1 = { x: a.x - joint.x, y: a.y - joint.y };
  const v2 = { x: b.x - joint.x, y: b.y - joint.y };
  const n1 = Math.hypot(v1.x, v1.y);
  const n2 = Math.hypot(v2.x, v2.y);
  if (n1 < 1e-9 || n2 < 1e-9) return 180;
  const cos = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (n1 * n2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * 提取一帧的评分特征（归一化图像坐标，y 向下增大）。
 * 相对高度以躯干长度为单位：>0 表示高于肩/头。
 * @returns {object|null} landmarks 不完整时返回 null
 */
export function extractBaduanjinFeatures(landmarks) {
  const nose = point(landmarks, LANDMARK_INDEX.nose);
  const sl = point(landmarks, LANDMARK_INDEX.shoulderL);
  const sr = point(landmarks, LANDMARK_INDEX.shoulderR);
  const el = point(landmarks, LANDMARK_INDEX.elbowL);
  const er = point(landmarks, LANDMARK_INDEX.elbowR);
  const wl = point(landmarks, LANDMARK_INDEX.wristL);
  const wr = point(landmarks, LANDMARK_INDEX.wristR);
  const hl = point(landmarks, LANDMARK_INDEX.hipL);
  const hr = point(landmarks, LANDMARK_INDEX.hipR);
  if (!sl || !sr || !wl || !wr || !hl || !hr) return null;

  const shoulderMid = { x: (sl.x + sr.x) / 2, y: (sl.y + sr.y) / 2 };
  const hipMid = { x: (hl.x + hr.x) / 2, y: (hl.y + hr.y) / 2 };
  const torso = Math.max(1e-6, hipMid.y - shoulderMid.y);
  const headY = nose ? nose.y : shoulderMid.y - torso * 0.55;

  return {
    shoulderMid,
    hipMid,
    torso,
    wristAboveShoulderL: (shoulderMid.y - wl.y) / torso,
    wristAboveShoulderR: (shoulderMid.y - wr.y) / torso,
    wristAboveHeadL: (headY - wl.y) / torso,
    wristAboveHeadR: (headY - wr.y) / torso,
    wristBelowHipL: (wl.y - hipMid.y) / torso,
    wristBelowHipR: (wr.y - hipMid.y) / torso,
    handsSymmetryY: 1 - Math.min(1, Math.abs(wl.y - wr.y) / (torso * 0.35)),
    handsWidth: Math.abs(wl.x - wr.x) / torso,
    torsoLean: Math.abs(shoulderMid.x - hipMid.x) / torso,
    elbowBendL: angleBend(el, sl, wl),
    elbowBendR: angleBend(er, sr, wr),
  };
}

/**
 * 八段锦 8 式。evaluators 逐式 2-3 项，test(features) -> 0..1 的合格度；
 * joints 列出该项关联的骨骼点（供火柴人染色）。
 */
export const BADUANJIN_MOVES = [
  {
    id: 'tuotian',
    name: '双手托天理三焦',
    cue: '双手交叉上托，掌心向上，抬头看手。',
    evidence: '传统功法（八段锦）：中老年平衡与柔韧练习的常见推荐；本模块提供跟练与幅度反馈',
    evaluators: [
      { id: 'raise', label: '双手托至头上', joints: [15, 16], test: (f) => ramp(Math.max(f.wristAboveHeadL, f.wristAboveHeadR), 0, 0.15) },
      { id: 'symmetry', label: '双手齐平', joints: [15, 16], test: (f) => f.handsSymmetryY },
      { id: 'upright', label: '躯干端正', joints: [11, 12], test: (f) => 1 - ramp(f.torsoLean, 0.08, 0.25) },
    ],
  },
  {
    id: 'kaigong',
    name: '左右开弓似射雕',
    cue: '马步下蹲，一手拉弓一手推弓，左右交替。',
    evidence: '传统功法（八段锦）：下肢开步与上肢对拉练习；评分为幅度与对称反馈',
    evaluators: [
      { id: 'wide', label: '双手拉开幅度', joints: [15, 16], test: (f) => ramp(f.handsWidth, 0.5, 1.4) },
      { id: 'height', label: '手在肩胸高度', joints: [13, 14], test: (f) => 1 - ramp(Math.abs((f.wristAboveShoulderL + f.wristAboveShoulderR) / 2), 0.25, 0.8) },
      { id: 'symmetry', label: '左右对称用力', joints: [11, 12], test: (f) => 1 - ramp(Math.abs(f.wristAboveShoulderL - f.wristAboveShoulderR), 0.2, 0.8) },
    ],
  },
  {
    id: 'danju',
    name: '调理脾胃须单举',
    cue: '一手上举下撑，一手下按，左右交替。',
    evidence: '传统功法（八段锦）：单侧上举下按，练习肩带与躯干协调',
    evaluators: [
      { id: 'one-up', label: '一侧手举过头', joints: [15, 16], test: (f) => ramp(Math.max(f.wristAboveHeadL, f.wristAboveHeadR), -0.1, 0.2) },
      { id: 'one-down', label: '另一侧手下按', joints: [15, 16], test: (f) => ramp(Math.max(f.wristBelowHipL, f.wristBelowHipR), -0.2, 0.3) },
    ],
  },
  {
    id: 'houchou',
    name: '五劳七伤往后瞧',
    cue: '双臂下垂，缓缓转头向后看（正面视角以躯干端正为准）。',
    evidence: '传统功法（八段锦）：颈部活动为主；正面摄像头不评转头，侧重躯干稳定',
    evaluators: [
      { id: 'upright', label: '躯干端正稳定', joints: [11, 12, 23, 24], test: (f) => 1 - ramp(f.torsoLean, 0.06, 0.2) },
      { id: 'arms-down', label: '双臂自然下垂', joints: [15, 16], test: (f) => 1 - ramp(f.wristAboveShoulderL + f.wristAboveShoulderR, 0.1, 0.9) },
    ],
  },
  {
    id: 'yaotou',
    name: '摇头摆尾去心火',
    cue: '马步俯身，头与髋左右缓慢摆动。',
    evidence: '传统功法（八段锦）：俯身与髋部摆动的协调练习',
    evaluators: [
      { id: 'lean', label: '上身前俯', joints: [11, 12], test: (f) => ramp(f.torsoLean, 0.05, 0.2) },
      { id: 'hands', label: '双手接近膝上', joints: [15, 16], test: (f) => 1 - ramp(Math.abs((f.wristBelowHipL + f.wristBelowHipR) / 2 - 0.35), 0.2, 0.7) },
    ],
  },
  {
    id: 'panzu',
    name: '两手攀足固肾腰',
    cue: '缓慢俯身，双手沿腿下探（量力而行，不强求触地）。',
    evidence: '传统功法（八段锦）：前屈柔韧练习；口令强调量力而行',
    evaluators: [
      { id: 'bend', label: '上身充分前俯', joints: [11, 12], test: (f) => ramp(f.torsoLean, 0.15, 0.45) },
      { id: 'reach', label: '双手向下探', joints: [15, 16], test: (f) => ramp(Math.max(f.wristBelowHipL, f.wristBelowHipR), 0.1, 0.7) },
    ],
  },
  {
    id: 'cuanquan',
    name: '攒拳怒目增气力',
    cue: '马步冲拳，拳从腰间打出，左右交替。',
    evidence: '传统功法（八段锦）：马步与出拳的上肢力量练习',
    evaluators: [
      { id: 'punch', label: '出拳幅度', joints: [13, 14, 15, 16], test: (f) => ramp(f.handsWidth, 0.45, 1.3) },
      { id: 'height', label: '拳在胸腹高度', joints: [15, 16], test: (f) => 1 - ramp(Math.abs((f.wristAboveShoulderL + f.wristAboveShoulderR) / 2 + 0.15), 0.2, 0.6) },
      { id: 'upright', label: '躯干端正', joints: [11, 12], test: (f) => 1 - ramp(f.torsoLean, 0.08, 0.25) },
    ],
  },
  {
    id: 'qidian',
    name: '背后七颠百病消',
    cue: '并步直立，脚跟提起轻放，全身放松。',
    evidence: '传统功法（八段锦）：直立与足踝轻振动练习，收式放松',
    evaluators: [
      { id: 'upright', label: '身体直立', joints: [11, 12, 23, 24], test: (f) => 1 - ramp(f.torsoLean, 0.06, 0.2) },
      { id: 'arms-natural', label: '双臂自然垂放', joints: [15, 16], test: (f) => 1 - ramp(f.wristAboveShoulderL + f.wristAboveShoulderR, 0.1, 0.9) },
    ],
  },
];

/**
 * 对一帧骨骼按招式评分。
 * @returns {{ score: number|null, parts: [{id,label,ratio}], jointStates: {joint: 'ok'|'near'|'off'}, feedback: string[] }}
 */
export function scoreMove(move, landmarks) {
  const features = extractBaduanjinFeatures(landmarks);
  if (!features || !move?.evaluators?.length) {
    return { score: null, parts: [], jointStates: {}, feedback: [] };
  }
  const parts = move.evaluators.map((evaluator) => ({
    id: evaluator.id,
    label: evaluator.label,
    ratio: clamp01(evaluator.test(features)),
  }));
  const score = Math.round((parts.reduce((sum, part) => sum + part.ratio, 0) / parts.length) * 100);
  // 关节染色取"最差"状态：同一关节被多个要素引用时，暴露问题优先
  // （否则"双手齐平"的达标会盖住"手没举起来"的偏离，染色会说谎）。
  const severity = { ok: 0, near: 1, off: 2 };
  const jointStates = {};
  parts.forEach((part, i) => {
    const state = part.ratio >= 0.75 ? 'ok' : part.ratio >= 0.4 ? 'near' : 'off';
    for (const joint of move.evaluators[i].joints ?? []) {
      if (!(joint in jointStates) || severity[state] > severity[jointStates[joint]]) {
        jointStates[joint] = state;
      }
    }
  });
  return {
    score,
    parts,
    jointStates,
    feedback: parts.filter((part) => part.ratio < 0.75).map((part) => part.label),
  };
}

// ---------------------------------------------------------------------------
// 跟练会话：8 式依次进行，中间有换式间歇；结束时收势。
export class BaduanjinSession {
  constructor({ config = DEFAULT_CONFIG, now = null } = {}) {
    this.cfg = config.baduanjin ?? { moveSeconds: 30, transitionSec: 5 };
    this.startedAt = null;
    this.steps = [];
    this.totalSec = 0;
    if (now !== null) this.start(now);
  }

  start(t) {
    this.startedAt = t;
    const steps = [];
    let cursor = t;
    const push = (step, seconds) => {
      steps.push({ ...step, start: cursor, end: cursor + seconds });
      cursor += seconds;
    };
    BADUANJIN_MOVES.forEach((move, index) => {
      push({ kind: 'move', move, index }, this.cfg.moveSeconds);
      if (index < BADUANJIN_MOVES.length - 1) {
        push({ kind: 'transition', index, cue: '换式：调整呼吸，准备下一式。' }, this.cfg.transitionSec);
      }
    });
    push({ kind: 'outro', cue: '八段锦完成，放松收势。' }, 4);
    this.steps = steps;
    this.totalSec = cursor - t;
    return this.currentAt(t);
  }

  currentAt(t) {
    if (!this.startedAt || !Number.isFinite(t)) {
      return { phase: 'idle', total: BADUANJIN_MOVES.length };
    }
    const step = this.steps.find((candidate) => t < candidate.end);
    if (!step) {
      return { phase: 'done', index: BADUANJIN_MOVES.length, total: BADUANJIN_MOVES.length, remaining: 0, progress: 1, cue: '' };
    }
    return {
      phase: step.kind,
      move: step.move ?? null,
      index: step.index ?? BADUANJIN_MOVES.length,
      total: BADUANJIN_MOVES.length,
      remaining: Math.max(0, step.end - t),
      progress: Math.min(1, (t - step.start) / Math.max(1e-6, step.end - step.start)),
      cue: step.cue ?? step.move?.cue ?? '',
    };
  }
}

/** 汇总各式的平均分与总分（无有效帧的式记 null）。 */
export function aggregateScores(results = []) {
  const scored = results.filter((result) => Number.isFinite(result?.score));
  return {
    total: scored.length ? Math.round(scored.reduce((sum, result) => sum + result.score, 0) / scored.length) : null,
    moves: results.map((result) => ({ id: result.id, name: result.name, score: Number.isFinite(result?.score) ? result.score : null })),
  };
}
