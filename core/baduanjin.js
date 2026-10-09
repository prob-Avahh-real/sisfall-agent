// 八段锦跟练与打分：标准轨迹参考 + 实时动捕对比。
//
// 工作方式（与 v1 的独立规则评分不同，这里是轨迹对齐评分）：
//   1. MOVES 每式带一段**预加载的标准轨迹**——由 POSE_LIBRARY 的关键帧
//      姿势（归一化骨骼：原点=髋中、单位=肩宽、y 向下）按 smoothstep 插值
//      生成 referencePoseAt(move, progress)。
//   2. 实时动捕（MediaPipe 33 点）经 normalizeSkeleton 变换到同一归一化
//      空间（含画幅宽高比校正与肩宽缩放）。
//   3. comparePoses 逐关节计算加权距离 → 0-100 分与逐关节偏差状态；
//      matchScore 在 ±时滞窗口内搜索最佳对齐（容忍跟练人的反应延迟）。
//   4. UI 在同一坐标锚点上叠加绘制两个火柴人（蓝色细线=标准参考，
//      彩色=跟练人），偏差大的关节染灰、接近染黄、达标染绿。
//
// 诚实声明：标准轨迹是**程序化编排的示意动作**，不是真人动捕数据；后续
// 可替换为真实动捕序列（数据结构兼容：关节坐标帧序列即可）。
// 定位（core/pd-profile.js）：train 范围内的传统功法练习，打分为练习反馈，
// 不是医疗评估，不声称疗效。

import { DEFAULT_CONFIG } from './config.js';

export const LANDMARK_INDEX = {
  nose: 0,
  shoulderL: 11, shoulderR: 12,
  elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16,
  hipL: 23, hipR: 24,
  kneeL: 25, kneeR: 26,
  ankleL: 27, ankleR: 28,
};

/** 参与对比的关节与权重（腕/肘重一点——动作幅度主要看上肢）。 */
export const JOINT_LIST = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
export const JOINT_WEIGHTS = { 15: 2, 16: 2, 13: 1.5, 14: 1.5 };
export const SCORE_CONFIG = {
  tolerance: 0.55, // 加权平均距离达到此值记 0 分（单位与归一化空间一致=肩宽）
  okDistance: 0.18, // 单关节偏差 ≤ 此值 → 达标
  nearDistance: 0.35, // ≤ 此值 → 接近
};

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const smoothstep = (p) => p * p * (3 - 2 * p);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function point(landmarks, index) {
  const p = landmarks?.[index];
  if (!p) return null;
  const x = finite(p.x);
  const y = finite(p.y);
  return x == null || y == null ? null : { x, y };
}

// ---------------------------------------------------------------------------
// 标准姿势库（归一化：原点=髋中点，单位=肩宽，y 向下为正）。
const STAND = {
  0: [0, -1.9],
  11: [-0.5, -1.3], 12: [0.5, -1.3],
  13: [-0.55, -0.75], 14: [0.55, -0.75],
  15: [-0.6, -0.2], 16: [0.6, -0.2],
  23: [-0.45, 0], 24: [0.45, 0],
  25: [-0.45, 0.9], 26: [0.45, 0.9],
  27: [-0.45, 1.8], 28: [0.45, 1.8],
};

const asPoints = (source) => Object.fromEntries(Object.entries(source).map(([k, v]) => [k, { x: v[0], y: v[1] }]));

/** 逐点镜像（x 取反），用于左右交替式。 */
function mirror(pose) {
  return Object.fromEntries(Object.entries(pose).map(([k, v]) => [k, { x: -v.x, y: v.y }]));
}

export const POSE_LIBRARY = (() => {
  const stand = asPoints(STAND);
  const merged = (overrides) => {
    const base = asPoints(STAND);
    for (const [k, v] of Object.entries(overrides)) base[k] = { x: v[0], y: v[1] };
    return base;
  };
  const cross = merged({
    13: [-0.35, -1.05], 14: [0.35, -1.05],
    15: [-0.12, -1.2], 16: [0.12, -1.2],
  });
  const up = merged({
    13: [-0.4, -1.75], 14: [0.4, -1.75],
    15: [-0.22, -2.15], 16: [0.22, -2.15],
  });
  const openLeft = merged({
    13: [-0.7, -1.3], 14: [0.55, -1.35],
    15: [-1.35, -1.3], 16: [0.35, -1.25],
  });
  const oneUpLeft = merged({
    13: [-0.45, -1.7], 14: [0.55, -1.0],
    15: [-0.3, -2.1], 16: [0.55, -0.55],
  });
  const bendKnees = merged({
    0: [0, -1.35],
    11: [-0.5, -0.95], 12: [0.5, -0.95],
    13: [-0.6, -0.45], 14: [0.6, -0.45],
    15: [-0.55, 0.15], 16: [0.55, 0.15],
  });
  const bendKneesLeft = Object.fromEntries(Object.entries(bendKnees).map(([k, v]) => [k, { x: v.x - 0.15, y: v.y }]));
  const reach = merged({
    0: [0, -1.05],
    11: [-0.48, -0.75], 12: [0.48, -0.75],
    13: [-0.5, -0.2], 14: [0.5, -0.2],
    15: [-0.35, 0.75], 16: [0.35, 0.75],
  });
  const punchRight = merged({
    13: [-0.55, -1.0], 14: [0.75, -1.1],
    15: [-0.35, -1.2], 16: [1.25, -1.05],
  });
  const rise = Object.fromEntries(Object.entries(stand).map(([k, v]) => [k, { x: v.x, y: v.y - 0.1 }]));
  return {
    stand,
    cross,
    up,
    openLeft,
    openRight: mirror(openLeft),
    oneUpLeft,
    oneUpRight: mirror(oneUpLeft),
    bendKnees,
    bendKneesLeft,
    bendKneesRight: mirror(bendKneesLeft),
    reach,
    punchRight,
    punchLeft: mirror(punchRight),
    rise,
  };
})();

/**
 * 八段锦 8 式：每式带名称/口令/依据与标准轨迹关键帧（at∈[0,1] → pose 名）。
 */
export const BADUANJIN_MOVES = [
  {
    id: 'tuotian',
    name: '双手托天理三焦',
    cue: '双手交叉上托，掌心向上，抬头看手。',
    evidence: '传统功法（八段锦）：中老年平衡与柔韧练习的常见推荐；标准轨迹为示意编排',
    keyframes: [
      { at: 0, pose: 'stand' },
      { at: 0.2, pose: 'cross' },
      { at: 0.5, pose: 'up' },
      { at: 0.78, pose: 'up' },
      { at: 1, pose: 'stand' },
    ],
  },
  {
    id: 'kaigong',
    name: '左右开弓似射雕',
    cue: '马步下蹲，一手推弓一手拉弓，左右交替。',
    evidence: '传统功法（八段锦）：上肢对拉开合练习；标准轨迹为示意编排',
    keyframes: [
      { at: 0, pose: 'stand' },
      { at: 0.25, pose: 'openLeft' },
      { at: 0.5, pose: 'openRight' },
      { at: 0.75, pose: 'openLeft' },
      { at: 1, pose: 'stand' },
    ],
  },
  {
    id: 'danju',
    name: '调理脾胃须单举',
    cue: '一手上举下撑，一手下按，左右交替。',
    evidence: '传统功法（八段锦）：单侧上举下按的肩带协调练习；标准轨迹为示意编排',
    keyframes: [
      { at: 0, pose: 'stand' },
      { at: 0.25, pose: 'oneUpLeft' },
      { at: 0.5, pose: 'oneUpRight' },
      { at: 0.75, pose: 'oneUpLeft' },
      { at: 1, pose: 'stand' },
    ],
  },
  {
    id: 'houchou',
    name: '五劳七伤往后瞧',
    cue: '双臂下垂，缓缓转头向后看（正面视角以躯干端正为准）。',
    evidence: '传统功法（八段锦）：颈部活动为主；正面摄像头不评转头，标准轨迹为静立端正',
    keyframes: [
      { at: 0, pose: 'stand' },
      { at: 0.5, pose: 'stand' },
      { at: 1, pose: 'stand' },
    ],
  },
  {
    id: 'yaotou',
    name: '摇头摆尾去心火',
    cue: '马步俯身，头与髋左右缓慢摆动。',
    evidence: '传统功法（八段锦）：俯身与髋部摆动的协调练习；标准轨迹为示意编排',
    keyframes: [
      { at: 0, pose: 'stand' },
      { at: 0.25, pose: 'bendKneesLeft' },
      { at: 0.5, pose: 'bendKneesRight' },
      { at: 0.75, pose: 'bendKneesLeft' },
      { at: 1, pose: 'stand' },
    ],
  },
  {
    id: 'panzu',
    name: '两手攀足固肾腰',
    cue: '缓慢俯身，双手沿腿下探（量力而行，不强求触地）。',
    evidence: '传统功法（八段锦）：前屈柔韧练习，口令强调量力而行；标准轨迹为示意编排',
    keyframes: [
      { at: 0, pose: 'stand' },
      { at: 0.4, pose: 'reach' },
      { at: 0.7, pose: 'reach' },
      { at: 1, pose: 'stand' },
    ],
  },
  {
    id: 'cuanquan',
    name: '攒拳怒目增气力',
    cue: '马步冲拳，拳从腰间打出，左右交替。',
    evidence: '传统功法（八段锦）：马步与出拳的上肢力量练习；标准轨迹为示意编排',
    keyframes: [
      { at: 0, pose: 'stand' },
      { at: 0.25, pose: 'punchRight' },
      { at: 0.5, pose: 'punchLeft' },
      { at: 0.75, pose: 'punchRight' },
      { at: 1, pose: 'stand' },
    ],
  },
  {
    id: 'qidian',
    name: '背后七颠百病消',
    cue: '并步直立，脚跟提起轻放，全身放松。',
    evidence: '传统功法（八段锦）：直立与足踝轻振动的收式放松；标准轨迹为示意编排',
    keyframes: [
      { at: 0, pose: 'stand' },
      { at: 0.15, pose: 'rise' },
      { at: 0.3, pose: 'stand' },
      { at: 0.45, pose: 'rise' },
      { at: 0.6, pose: 'stand' },
      { at: 0.75, pose: 'rise' },
      { at: 1, pose: 'stand' },
    ],
  },
];

/** 标准轨迹在 progress（0..1）处的姿势：关键帧间 smoothstep 插值。 */
export function referencePoseAt(move, progress = 0) {
  const frames = move?.keyframes;
  if (!frames?.length) return null;
  const p = clamp01(progress);
  let left = frames[0];
  let right = frames[frames.length - 1];
  for (let i = 0; i < frames.length - 1; i += 1) {
    if (p >= frames[i].at && p <= frames[i + 1].at) {
      left = frames[i];
      right = frames[i + 1];
      break;
    }
  }
  const span = Math.max(1e-6, right.at - left.at);
  const t = smoothstep(clamp01((p - left.at) / span));
  const a = POSE_LIBRARY[left.pose];
  const b = POSE_LIBRARY[right.pose];
  if (!a || !b) return null;
  const out = {};
  for (const key of Object.keys(a)) {
    const pa = a[key];
    const pb = b[key] ?? pa;
    out[key] = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
  }
  return out;
}

// ---------------------------------------------------------------------------
/** 把实时骨骼归一化到标准空间（原点=髋中、单位=肩宽，含宽高比校正）。 */
export function normalizeSkeleton(landmarks, aspect = 1) {
  const sl = point(landmarks, 11);
  const sr = point(landmarks, 12);
  const hl = point(landmarks, 23);
  const hr = point(landmarks, 24);
  if (!sl || !sr || !hl || !hr) return null;
  const scale = Math.hypot((sr.x - sl.x) * aspect, sr.y - sl.y);
  if (!(scale > 1e-6)) return null;
  const origin = { x: ((hl.x + hr.x) / 2) * aspect, y: (hl.y + hr.y) / 2 };
  const points = {};
  for (const index of JOINT_LIST) {
    const p = point(landmarks, index);
    if (!p) continue; // 局部遮挡允许缺关节
    points[index] = { x: (p.x * aspect - origin.x) / scale, y: (p.y - origin.y) / scale };
  }
  if (!points[11] || !points[15] || !points[16]) return null; // 关键关节缺失 → 该帧无效
  return { points, scale, origin };
}

/** 逐关节加权距离 → 0-100 分与逐关节偏差状态。 */
export function comparePoses(reference, userPoints) {
  if (!reference || !userPoints) return null;
  let weightSum = 0;
  let distSum = 0;
  const perJoint = {};
  for (const index of JOINT_LIST) {
    const r = reference[index];
    const u = userPoints[index];
    if (!r || !u) continue;
    const d = Math.hypot(r.x - u.x, r.y - u.y);
    const weight = JOINT_WEIGHTS[index] ?? 1;
    perJoint[index] = d;
    distSum += d * weight;
    weightSum += weight;
  }
  if (!weightSum) return null;
  const distance = distSum / weightSum;
  const score = Math.round(100 * clamp01(1 - distance / SCORE_CONFIG.tolerance));
  const jointStates = {};
  for (const [index, d] of Object.entries(perJoint)) {
    jointStates[index] = d <= SCORE_CONFIG.okDistance ? 'ok' : d <= SCORE_CONFIG.nearDistance ? 'near' : 'off';
  }
  return { distance, score, jointStates, perJoint };
}

/**
 * 与标准轨迹对比打分（含时滞容忍）：在 progress 的 ±窗口内搜索最匹配的
 * 参考帧——跟练人的动作常有滞后/提前，对齐后再比较姿势形状。
 * @returns {null|{score, distance, matchedProgress, reference, scale, origin, jointStates}}
 */
export function matchScore(move, landmarks, progress = 0, options = {}) {
  const { aspect = 1, backWindow = 0.15, aheadWindow = 0.2, samples = 8 } = options;
  const user = normalizeSkeleton(landmarks, aspect);
  if (!user) return null;
  let best = null;
  for (let i = 0; i < samples; i += 1) {
    const p = clamp01(progress - backWindow + ((backWindow + aheadWindow) * i) / (samples - 1));
    const reference = referencePoseAt(move, p);
    const compared = comparePoses(reference, user.points);
    if (compared && (!best || compared.score > best.score)) {
      best = { ...compared, matchedProgress: p, reference };
    }
  }
  if (!best) return null;
  return { ...best, scale: user.scale, origin: user.origin };
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
