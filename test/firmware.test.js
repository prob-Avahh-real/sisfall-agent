import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../core/config.js';
import { generateFirmware } from '../tools/gen-firmware.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIRMWARE_DIR = path.join(ROOT, 'firmware/sisfall_preimpact');

test('generated firmware config matches core/config.js (drift guard)', () => {
  const header = readFileSync(path.join(FIRMWARE_DIR, 'config.h'), 'utf8');
  const num = (name) => {
    const match = new RegExp(`#define ${name} ([0-9.]+)f?`).exec(header);
    assert.ok(match, `missing define ${name}`);
    return Number.parseFloat(match[1]);
  };
  const cfg = DEFAULT_CONFIG;

  assert.equal(num('SF_TARGET_HZ'), cfg.device.targetHz);
  assert.equal(num('SF_UP_REF_FRAMES'), cfg.imu.upRefFrames);
  assert.equal(num('SF_GRAVITY_TAU'), cfg.imu.gravityTau);
  assert.equal(num('SF_DROP_GAIN'), cfg.imu.dropGain);
  assert.equal(num('SF_DROP_DECAY'), cfg.imu.dropDecay);
  assert.equal(num('SF_LATERAL_TAU'), cfg.imu.lateralTau);
  assert.equal(num('SF_LATERAL_GAIN'), cfg.imu.lateralGain);

  assert.equal(num('SF_WEIGHT_TORSO'), cfg.risk.weights.torsoLean);
  assert.equal(num('SF_WEIGHT_OFFSET'), cfg.risk.weights.lateralOffset);
  assert.equal(num('SF_WEIGHT_DROP'), cfg.risk.weights.hipDropSpeed);
  assert.equal(num('SF_WEIGHT_ASYM'), cfg.risk.weights.kneeAsymmetry);

  assert.equal(num('SF_SCALE_TORSO_START'), cfg.risk.scales.torsoLean.start);
  assert.equal(num('SF_SCALE_TORSO_FULL'), cfg.risk.scales.torsoLean.full);
  assert.equal(num('SF_SCALE_OFFSET_START'), cfg.risk.scales.lateralOffset.start);
  assert.equal(num('SF_SCALE_OFFSET_FULL'), cfg.risk.scales.lateralOffset.full);
  assert.equal(num('SF_SCALE_DROP_START'), cfg.risk.scales.hipDropSpeed.start);
  assert.equal(num('SF_SCALE_DROP_FULL'), cfg.risk.scales.hipDropSpeed.full);
  assert.equal(num('SF_SCALE_ASYM_START'), cfg.risk.scales.kneeAsymmetry.start);
  assert.equal(num('SF_SCALE_ASYM_FULL'), cfg.risk.scales.kneeAsymmetry.full);

  assert.equal(num('SF_COVERAGE_MEASURED'), cfg.risk.coverageWeight.measured);
  assert.equal(num('SF_COVERAGE_PROXY'), cfg.risk.coverageWeight.proxy);
  assert.equal(num('SF_COVERAGE_UNAVAILABLE'), cfg.risk.coverageWeight.unavailable);

  assert.equal(num('SF_THRESHOLD_CAUTION'), cfg.risk.thresholds.caution);
  assert.equal(num('SF_THRESHOLD_DANGER'), cfg.risk.thresholds.danger);
  assert.equal(num('SF_MIN_RISE_RATE'), cfg.forecast.minRiseRate);
  assert.equal(num('SF_SCORE_FLOOR'), cfg.forecast.scoreFloor);
  assert.equal(num('SF_IMMINENT_HORIZON_SEC'), cfg.forecast.imminentHorizonSec);
  assert.equal(num('SF_EVENT_COOLDOWN_SEC'), cfg.policy.audioCooldownSec);
  // Trend window converts frames to TIME (0.8 s at the 15 Hz reference rate).
  assert.equal(num('SF_SLOPE_WINDOW'), Math.round((cfg.forecast.windowFrames / 15) * cfg.device.targetHz));
});

test('firmware artifacts regenerate byte-identically', () => {
  const generated = generateFirmware();
  for (const [file, content] of Object.entries(generated)) {
    assert.equal(
      readFileSync(path.join(ROOT, file), 'utf8'),
      content,
      `${file} drifted — run npm run firmware`
    );
  }
});

test('host detector test compiles and passes (skipped without a C compiler)', (t) => {
  const compiler = ['cc', 'clang', 'gcc'].find((candidate) => spawnSync(candidate, ['--version']).status === 0);
  if (!compiler) {
    t.skip('no C compiler available');
    return;
  }
  const bin = path.join(mkdtempSync(path.join(tmpdir(), 'sisfall-host-')), 'host_test');
  execFileSync(
    compiler,
    [
      '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
      '-I', FIRMWARE_DIR,
      '-I', path.join(FIRMWARE_DIR, 'test'),
      path.join(FIRMWARE_DIR, 'detector.c'),
      path.join(FIRMWARE_DIR, 'test', 'detector_host_test.c'),
      '-lm', '-o', bin,
    ],
    { stdio: 'pipe' }
  );
  const run = spawnSync(bin, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, `host test failed:\n${run.stdout}\n${run.stderr}`);
  assert.ok(run.stdout.includes('HOST TEST OK'), run.stdout);
  assert.ok(run.stdout.includes('score parity'), run.stdout);
});
