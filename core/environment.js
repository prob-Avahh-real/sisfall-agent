// 环境推断：传感器辅助判断"地面湿滑/有障碍"，但不做物体识别的虚假承诺。
//
// 传感器能观察到的是**微事件**——下坠代理快速冲高后迅速回落、没有持续下坠
// ——这正是一次"滑了一下/被绊一下但自己稳住了"的特征。这是候选信号而不是
// 结论，所以智能体的做法是**主动询问**用户（每场会话最多几次、带冷却），
// 而不是替用户下判断。用户的回答才是环境的真实来源：
//
//   回答"是" -> 环境风险确认 `confirmedHoldSec`；走灵敏度通道缩短预警提前量
//               （与症状同一通道，min() 合并）；分数本身永不因此灌水。
//   回答"否" -> 驳回；`dismissHoldSec` 静默期内不再询问。
//
// 界面上的勾选框已移除：`context.obstacle` 显式通道仍保留（测试/演示/回放
// 可直接注入），网页端由"推断 + 用户回答"驱动。全部阈值在
// config.environment.inference。

import { DEFAULT_CONFIG } from './config.js';

export class EnvironmentInference {
  constructor(config = DEFAULT_CONFIG) {
    this.cfg = config.risk.environment;
    this.holdScale = this.cfg.horizonScale?.obstacle ?? 0.8;
    this.reset();
  }

  reset() {
    this.lastT = 0;
    this._spike = null; // 进行中的下坠尖峰 { peakAt, peak }
    this._events = []; // 近期微事件 { t, peak }
    this._pending = null; // 待答询问 { askedAt, eventT, id }
    this._askedFor = null; // 已为哪个事件问过（防重复）
    this._asksUsed = 0;
    this._lastAskedAt = -Infinity;
    this._suppressUntil = -Infinity;
    this._confirmed = null; // { since, expiresAt }
    this._lastEvent = null;
  }

  /** 逐帧喂入特征流；微事件检测在这里。 */
  update({ t, features = {} }) {
    this.lastT = t;
    const cfg = this.cfg.inference;
    const drop = Number.isFinite(features.hipDropSpeed) ? features.hipDropSpeed : 0;

    if (!this._spike) {
      if (drop >= cfg.slipDropThreshold) this._spike = { peakAt: t, peak: drop };
    } else {
      if (drop > this._spike.peak) {
        this._spike.peak = drop;
        this._spike.peakAt = t;
      }
      const recovered =
        drop < cfg.slipRecoveryDrop && t - this._spike.peakAt >= cfg.slipRecoverWithinSec;
      const sustained = t - this._spike.peakAt > cfg.slipRecoverWithinSec + 2.5; // 持续下坠，不是微事件
      if (recovered) {
        const last = this._events[this._events.length - 1];
        if (!last || t - last.t >= cfg.eventDebounceSec) {
          const event = { t: this._spike.peakAt, peak: this._spike.peak };
          this._events.push(event);
          if (this._events.length > 20) this._events.shift();
          this._lastEvent = event;
        }
        this._spike = null;
      } else if (sustained) {
        this._spike = null;
      }
    }

    if (this._pending && t - this._pending.askedAt > cfg.askTimeoutSec) this._pending = null; // 未答超时
    while (this._events.length && this._events[0].t < t - 90) this._events.shift();
  }

  /** 当前待答询问（含可解释的触发原因），或 null。 */
  pendingQuestion(t = this.lastT) {
    if (!this._pending) return null;
    const ago = Math.max(0, Math.round(t - this._pending.eventT));
    return {
      id: this._pending.id,
      askedAt: this._pending.askedAt,
      text: '刚才是否遇到地面湿滑或有障碍物？',
      detail: `检测到一次快速失衡后自行恢复（${ago} 秒前）`,
    };
  }

  /** 现在是否该主动询问（新鲜事件、非急性状态、冷却已过）。调用即登记待答。 */
  shouldAsk(t = this.lastT, state = 'stable') {
    const cfg = this.cfg.inference;
    if (this._pending) return false;
    if (this._asksUsed >= cfg.maxAsksPerSession) return false;
    if (t - this._lastAskedAt < cfg.askCooldownSec) return false;
    if (t < this._suppressUntil) return false;
    if (state === 'imminent' || state === 'danger') return false; // 先处理急性状态
    const event = this._events[this._events.length - 1];
    if (!event) return false;
    if (t - event.t < cfg.slipRecoverWithinSec + 1) return false; // 给恢复留时间
    if (t - event.t > 60) return false; // 事件过期
    if (this._askedFor === event.t) return false; // 已为该事件问过
    this._pending = { askedAt: t, eventT: event.t, id: `env-${Math.round(event.t * 1000)}` };
    this._askedFor = event.t;
    this._asksUsed += 1;
    this._lastAskedAt = t;
    return true;
  }

  /** 用户回答。yes=true 确认环境风险一段时间；false 驳回并静默。 */
  answer({ t = this.lastT, yes = false } = {}) {
    const cfg = this.cfg.inference;
    this._pending = null;
    if (yes) {
      this._confirmed = { since: t, expiresAt: t + cfg.confirmedHoldSec };
    } else {
      this._suppressUntil = t + cfg.dismissHoldSec;
    }
    return this.snapshot(t);
  }

  activeAt(t = this.lastT) {
    return !!(this._confirmed && t < this._confirmed.expiresAt);
  }

  /** 灵敏度倍率（1 = 正常；确认环境风险时缩短预警提前量）。 */
  sensitivityScale(t = this.lastT) {
    return this.activeAt(t) ? this.holdScale : 1;
  }

  snapshot(t = this.lastT) {
    const active = this.activeAt(t);
    return {
      active,
      confirmed: active
        ? { since: this._confirmed.since, expiresAt: this._confirmed.expiresAt, slippery: true, obstacle: true }
        : null,
      pendingQuestion: this.pendingQuestion(t),
      lastEvent: this._lastEvent,
      asksUsed: this._asksUsed,
    };
  }
}
