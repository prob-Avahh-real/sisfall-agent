// 康复训练：动作库 + 会话状态机 + 定时纯函数 + 语音命令匹配。
//
// 动作库是 PD 最小集（见 core/pd-profile.js）：围绕 患者行动最小集 的四类
// 行动（行走/转身/坐站转移/站立重心），每个动作带 evidence 字段（依据），
// 理念来自 NICE NG71 的 PD 特异性物理治疗、MDS 循证综述的 cueing 策略与
// LSVT-BIG 的幅度驱动理念。动作是安全的活动练习，不是治疗方案。
//
// 设计要点
// - 训练会**故意制造姿态波动**（大步行进、重心转移），所以 agent 在训练
//   模式下暂缓"注意"级视觉提示（记录为 note，供审计），但预警/危险级
//   告警绝不降级——安全边界不动（config.training.dampenCaution）。
// - 动作按阶段取库：0-1 级以站立训练为主，2 级以上以坐位/扶稳为主。
// - 定时与语音是 UI 层能力（浏览器定时器 / Web Speech API），这里只放
//   可测试的纯逻辑：时间轴状态机、isScheduleDue、isDoseDue、语音匹配。

import { DEFAULT_CONFIG } from './config.js';

export const TRAINING_LIBRARY = {
  light: [
    { id: 'big-steps', name: '大步行进', seconds: 45, kind: '步态', bpm: 90, cue: '迈大步，像跨过地上的大石块；双臂自然摆动。', safety: '选择宽阔通道，手边有支撑', evidence: 'LSVT-BIG 幅度驱动理念：大幅度动作训练' },
    { id: 'metronome-walk', name: '节拍行走', seconds: 45, kind: '步态', bpm: 100, cue: '跟着节拍左右迈步；可以先原地起步再前进。', safety: '扶稳或靠墙，地面平整', evidence: '节律听觉提示（cueing）改善 PD 步速与步幅' },
    { id: 'turn-practice', name: '大弧转身', seconds: 30, kind: '转移', bpm: 80, cue: '转身时走大弧线，先迈步再转，不要原地硬转。', safety: '手扶稳定支撑', evidence: '转身是 PD 冻结与跌倒的高发场景' },
    { id: 'sit-stand', name: '坐站转移', seconds: 40, kind: '转移', cue: '起身前先让鼻尖越过膝盖，缓慢起立再坐下。', safety: '选择稳定、无轮子的椅子', evidence: 'PD 特异性物理治疗核心：转移训练' },
    { id: 'freeze-plan', name: '冻结应对演练', seconds: 30, kind: '策略', bpm: 70, cue: '练习口诀：先停下站稳，想好一个大目标，数一二三迈出去。', safety: '练习时全程扶稳', evidence: '冻结的分步策略：cueing + 先迈步再转身' },
    { id: 'weight-shift', name: '重心转移', seconds: 40, kind: '平衡', cue: '左右缓慢转移重心，感受双脚承重的变化。', safety: '手扶稳定支撑', evidence: '平衡训练用于姿势不稳（含太极理念）' },
  ],
  supported: [
    { id: 'seated-big-arms', name: '坐位大幅摆臂', seconds: 40, kind: '热身', cue: '坐在椅上，向前后大幅摆动手臂，幅度尽量大。', safety: '椅子稳定，远离桌角', evidence: 'LSVT-BIG 幅度维持理念' },
    { id: 'seated-march', name: '坐位踏步', seconds: 40, kind: '步态', bpm: 90, cue: '坐姿交替抬腿踏步，抬得稍高一些。', safety: '靠近扶手', evidence: '坐位步态准备训练' },
    { id: 'seated-weight-shift', name: '坐位重心转移', seconds: 40, kind: '平衡', cue: '缓慢左右转移重心，动作保持从容。', safety: '必要时扶住扶手', evidence: '重心控制训练' },
    { id: 'supported-sit-stand', name: '扶稳坐站', seconds: 40, kind: '转移', cue: '双手扶稳，鼻尖越过膝盖，缓慢起立再坐下。', safety: '全程扶稳', evidence: '转移训练（带支持条件）' },
    { id: 'freeze-plan', name: '冻结应对演练', seconds: 30, kind: '策略', bpm: 70, cue: '练习口诀：先停下站稳，想好一个大目标，数一二三迈出去。', safety: '练习时扶稳', evidence: '冻结的分步策略：cueing + 先迈步再转身' },
  ],
};

/** 按阶段取动作序列（含热身，取到 exercisesPerSession 个）。 */
export function planForStage(stage = 0, config = DEFAULT_CONFIG) {
  const library = stage >= 2 ? TRAINING_LIBRARY.supported : TRAINING_LIBRARY.light;
  const count = Math.max(1, Math.min(library.length, config.training?.exercisesPerSession ?? 4));
  return library.slice(0, count).map((item) => ({ ...item }));
}

export class TrainingSession {
  constructor({ stage = 0, config = DEFAULT_CONFIG, now = null } = {}) {
    this.cfg = config.training ?? {};
    this.stage = stage;
    this.plan = planForStage(stage, config);
    this.startedAt = null;
    this.steps = [];
    this.totalSec = 0;
    if (now !== null) this.start(now);
  }

  /** 构建时间轴：准备 ->（动作 -> 休息）× n -> 结束。 */
  start(t) {
    this.startedAt = t;
    const steps = [];
    let cursor = t;
    const push = (step, seconds) => {
      steps.push({ ...step, start: cursor, end: cursor + seconds });
      cursor += seconds;
    };
    push({ kind: 'intro', cue: '准备开始，先找好稳定的支撑。' }, this.cfg.introSec ?? 3);
    for (const exercise of this.plan) {
      push({ kind: 'exercise', exercise }, exercise.seconds);
      push({ kind: 'rest', cue: '休息一下，调整呼吸。' }, this.cfg.restSec ?? 8);
    }
    push({ kind: 'outro', cue: '训练完成，很好！' }, 3);
    this.steps = steps;
    this.totalSec = cursor - t;
    return this.currentAt(t);
  }

  /** 查询 t 时刻的进度（纯查询，无副作用）。 */
  currentAt(t) {
    if (!this.startedAt) return { phase: 'idle' };
    const step = this.steps.find((candidate) => t < candidate.end);
    if (!step) {
      return { phase: 'done', index: this.plan.length, total: this.plan.length, remaining: 0, progress: 1, cue: '' };
    }
    const index = step.exercise ? this.plan.indexOf(step.exercise) : this._completedExercises(t);
    return {
      phase: step.kind,
      exercise: step.exercise ?? null,
      index,
      total: this.plan.length,
      remaining: Math.max(0, step.end - t),
      progress: Math.min(1, (t - step.start) / Math.max(1e-6, step.end - step.start)),
      cue: step.cue ?? step.exercise?.cue ?? '',
    };
  }

  _completedExercises(t) {
    return this.steps.filter((step) => step.kind === 'exercise' && step.end <= t).length;
  }

  /** 会话摘要。completed=false 表示用户提前结束。 */
  summary({ t = this.startedAt, completed = true } = {}) {
    const done = this._completedExercises(t);
    return {
      stage: this.stage,
      completed,
      doneExercises: completed ? this.plan.length : done,
      totalExercises: this.plan.length,
      durationSec: Math.max(0, Math.round(t - this.startedAt)),
      exercises: this.plan.map((item) => item.id),
    };
  }
}

// ---------------------------------------------------------------------------
// 定时计划（纯函数）：enabled + 每日 HH:MM，到点后 10 分钟窗口内触发一次，
// 当天只触发一次（lastFired 存日期键，由 UI 层持久化）。
export function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function isScheduleDue(schedule, date, lastFiredKey = null) {
  if (!schedule?.enabled || !schedule.time) return false;
  const match = /^(\d{1,2}):(\d{2})$/.exec(schedule.time);
  if (!match) return false;
  const target = Number(match[1]) * 60 + Number(match[2]);
  const nowMin = date.getHours() * 60 + date.getMinutes();
  if (nowMin < target || nowMin > target + 10) return false;
  return lastFiredKey !== dayKey(date);
}

// ---------------------------------------------------------------------------
// 服药提醒（最小集）：每日至多几个时间点的**时间闹钟**——不含药名、剂量
// 与调整建议（那是医嘱，见 core/pd-profile.js 的行为边界）。返回到点且
// 当天尚未提醒过的第一个时间点，否则 null。
export function isDoseDue(times = [], date, lastFired = {}) {
  const key = dayKey(date);
  const nowMin = date.getHours() * 60 + date.getMinutes();
  for (const time of times) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ''));
    if (!match) continue;
    const target = Number(match[1]) * 60 + Number(match[2]);
    if (nowMin < target || nowMin > target + 10) continue;
    if (lastFired[`${key}:${time}`]) continue;
    return time;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 语音命令匹配（纯函数）：中文关键词、无云端依赖。UI 层用 Web Speech API
// 拿到转写文本，再交给这里判断；识别不可用时可完全降级为按钮操作。
const START = /(开始|启动|来|做|进行|要)[^，。！?]{0,4}训练/;
const STOP = /(停止|结束|退出|取消)[^，。！?]{0,4}训练/;
const ALIAS = /康复训练|平衡练习|练一练|锻炼一下/;

export function matchVoiceCommand(transcript = '') {
  const text = String(transcript).trim();
  if (!text) return null;
  if (STOP.test(text)) return 'stop';
  if (START.test(text) || ALIAS.test(text)) return 'start';
  return null;
}
