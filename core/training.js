// 康复训练：动作库 + 会话状态机 + 定时计划纯函数 + 语音命令匹配。
//
// 设计要点
// - 训练会**故意制造姿态波动**（单腿站立、重心转移），所以 agent 在训练
//   模式下暂缓"注意"级视觉提示（记录为 note，供审计），但预警/危险级
//   告警绝不降级——安全边界不动（config.training.dampenCaution）。
// - 动作按跌倒风险等级取库：0-1 级以站立训练为主，2-3 级以坐位/扶稳为主。
// - 定时与语音是 UI 层能力（浏览器定时器 / Web Speech API），这里只放
//   可测试的纯逻辑：时间轴状态机、isScheduleDue、matchVoiceCommand。
// - 真实系统级提醒（页面关闭仍生效）需要 Capacitor 通知权限，属后续里程碑。

import { DEFAULT_CONFIG } from './config.js';

export const TRAINING_LIBRARY = {
  light: [
    { id: 'march', name: '原地踏步', seconds: 60, kind: '热身', cue: '扶好椅背，缓慢抬膝踏步。', safety: '手扶稳定支撑' },
    { id: 'tandem', name: '脚跟对脚尖站立', seconds: 30, kind: '平衡', cue: '脚跟贴脚尖站直，目视前方。', safety: '靠墙或扶椅' },
    { id: 'single-leg', name: '单腿站立', seconds: 20, kind: '平衡', cue: '扶稳后抬起一只脚，保持均匀呼吸。', safety: '全程扶稳' },
    { id: 'sit-stand', name: '坐到站', seconds: 40, kind: '力量', cue: '缓慢起立再坐下，膝盖对准脚尖。', safety: '选择稳定、无轮子的椅子' },
    { id: 'calf-raise', name: '提踵', seconds: 30, kind: '力量', cue: '踮起脚尖停一秒，再缓慢落下。', safety: '手扶支撑' },
  ],
  supported: [
    { id: 'seated-march', name: '坐位抬腿踏步', seconds: 45, kind: '热身', cue: '坐在椅上交替抬腿踏步。', safety: '椅子稳定、靠近扶手' },
    { id: 'seated-shift', name: '坐位重心转移', seconds: 40, kind: '平衡', cue: '左右缓慢转移重心，动作放慢。', safety: '必要时扶住扶手' },
    { id: 'sit-stand', name: '扶稳坐到站', seconds: 40, kind: '力量', cue: '双手扶稳，缓慢起立再坐下。', safety: '全程扶稳' },
    { id: 'side-step', name: '扶椅侧向迈步', seconds: 40, kind: '步态', cue: '扶住椅背，向侧方缓慢迈步。', safety: '扶稳、地面干燥' },
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
