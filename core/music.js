// 音乐疗愈：节律提示（RAS）与呼吸引导的纯逻辑。
//
// 依据与边界：
// - 主要用途是**节律听觉提示**（Rhythmic Auditory Stimulation）辅助步态
//   ——MDS 物理治疗循证综述支持的 cueing 方向，训练库 metronome-walk 的
//   evidence 与此一致。节拍速率默认 100 BPM（可调）。
// - 呼吸引导（4-4-6：吸气-屏息-呼气）只作放松辅助，不声称疗效；模块内
//   所有用户可见文案纳入 pd-scope 合规扫描。
// - 音频由 UI 层用 Web Audio 合成（零音频文件、离线可用），本模块只负责
//   可测试的相位计算：节拍索引/相位、呼吸阶段/剩余秒。

export const MUSIC_MODES = {
  metronome: {
    id: 'metronome',
    label: '节拍提示',
    description: '跟随节拍迈步（步态节律提示）；训练中的节拍行走会自动采用动作节奏。',
  },
  breath: {
    id: 'breath',
    label: '呼吸引导',
    description: '吸气 4 秒、屏息 4 秒、呼气 6 秒的放松呼吸辅助。',
  },
};

export const BREATH_PATTERN = [4, 4, 6]; // 吸气 / 屏息 / 呼气（秒）
export const BPM_RANGE = { min: 40, max: 140 };
export const DEFAULT_BPM = 100;

export function clampBpm(bpm) {
  const value = Number(bpm);
  if (!Number.isFinite(value)) return DEFAULT_BPM;
  return Math.min(BPM_RANGE.max, Math.max(BPM_RANGE.min, Math.round(value)));
}

/** t 时刻的节拍相位：第几拍（从 0 起）与本拍已过比例（0..1）。 */
export function beatAt(t, { startedAt = 0, bpm = DEFAULT_BPM } = {}) {
  const interval = 60 / clampBpm(bpm);
  const elapsed = Math.max(0, t - startedAt);
  const index = Math.floor(elapsed / interval);
  return { index, interval, phase: (elapsed % interval) / interval };
}

/**
 * t 时刻的呼吸相位。stageIndex/cycleIndex 供 UI 做换相检测（音效与文案）。
 * @returns {{ stage: 'inhale'|'hold'|'exhale', stageIndex, progress, remaining, cycleIndex }}
 */
export function breathPhaseAt(t, { startedAt = 0, pattern = BREATH_PATTERN } = {}) {
  const cycle = pattern.reduce((sum, seconds) => sum + seconds, 0);
  const total = Math.max(0, t - startedAt);
  const elapsed = total % cycle;
  let cursor = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const end = cursor + pattern[i];
    if (elapsed < end || i === pattern.length - 1) {
      return {
        stage: ['inhale', 'hold', 'exhale'][i] ?? 'exhale',
        stageIndex: i,
        progress: Math.min(1, (elapsed - cursor) / pattern[i]),
        remaining: Math.max(0, end - elapsed),
        cycleIndex: Math.floor(total / cycle),
      };
    }
    cursor = end;
  }
  return { stage: 'exhale', stageIndex: 2, progress: 1, remaining: 0, cycleIndex: 0 };
}
