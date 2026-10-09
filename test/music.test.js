// 音乐疗愈模块（core/music.js）的测试：BPM 钳制、节拍相位、呼吸相位、模式表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_MODES, BREATH_PATTERN, DEFAULT_BPM, clampBpm, beatAt, breathPhaseAt } from '../core/music.js';

test('BPM 钳制与默认值', () => {
  assert.equal(clampBpm(100), 100);
  assert.equal(clampBpm(20), 40);
  assert.equal(clampBpm(400), 140);
  assert.equal(clampBpm('abc'), DEFAULT_BPM);
  assert.equal(clampBpm(99.6), 100);
});

test('节拍相位：索引与拍内进度计算正确', () => {
  const opts = { startedAt: 10, bpm: 120 }; // 间隔 0.5s
  assert.equal(beatAt(10, opts).index, 0);
  assert.equal(beatAt(10.24, opts).index, 0);
  assert.equal(beatAt(10.5, opts).index, 1);
  assert.equal(beatAt(11.0, opts).index, 2);
  assert.ok(Math.abs(beatAt(10.25, opts).phase - 0.5) < 1e-9);
  assert.ok(Math.abs(beatAt(10, opts).interval - 0.5) < 1e-9);
  assert.equal(beatAt(9.5, opts).index, 0); // 启动前按第 0 拍处理
});

test('呼吸相位：4-4-6 周期、换相与周期计数', () => {
  const at = (t) => breathPhaseAt(t, { startedAt: 0 });
  assert.equal(at(0.5).stage, 'inhale');
  assert.equal(at(3.9).stage, 'inhale');
  assert.equal(at(4.1).stage, 'hold');
  assert.equal(at(7.9).stage, 'hold');
  assert.equal(at(8.1).stage, 'exhale');
  assert.equal(at(13.9).stage, 'exhale');
  assert.equal(at(14.1).stage, 'inhale');
  assert.equal(at(14.1).cycleIndex, 1);
  assert.ok(Math.abs(at(2).remaining - 2) < 1e-9);
  assert.equal(BREATH_PATTERN.length, 3);
});

test('模式表结构完整（label/description 纳入 pd-scope 合规扫描）', () => {
  for (const mode of Object.values(MUSIC_MODES)) {
    assert.ok(mode.id && mode.label && mode.description, mode.id);
  }
  assert.ok(MUSIC_MODES.metronome && MUSIC_MODES.breath);
});
