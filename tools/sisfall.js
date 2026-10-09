// SisFall-format adapter (M3): parses the public SisFall dataset files
// (University of Antioquia; request access per their terms) into raw IMU
// samples and labeled observation windows, so the training pipeline can run on
// real data when it is available locally.
//
// File specifics (documented, parameterizable):
//   - each line: ax;ay;az;gx;gy;gz;  (semicolon-separated, trailing separator)
//   - sampled at 200 Hz
//   - accelerometer: ADXL345 at ±16 g -> g = raw / 256
//   - gyroscope:     ITG3200 at ±2000 dps -> dps = raw / 14.375
//   - filenames carry subject + activity, e.g. SA01-F01-05_1.txt (F = fall,
//     D = daily activity). Real-data validation happens on the user's machine;
//     this module is exercised in CI with a synthetic fixture.
//
// Usage with real data: place extracted files under data/sisfall/ and run
// `npm run train -- --sisfall data/sisfall`.

import { ImuMapper } from '../sources/imu.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import { buildWindowVector } from '../core/learned.js';

export const SISFALL_DEFAULTS = { hz: 200, accelScale: 256, gyroScale: 14.375 };

/** Activity from a SisFall filename, e.g. "SA01-F01-05_1.txt" -> { subject: 'SA01', activity: 'F01', kind: 'fall' }. */
export function classifySisFallFile(filename) {
  const subject = /(S[AE]\d+)/.exec(filename)?.[1] ?? 'unknown';
  const activity = /[-_]([FD]\d+)/.exec(filename)?.[1] ?? null;
  const kind = activity?.startsWith('F') ? 'fall' : activity?.startsWith('D') ? 'adl' : null;
  return { subject, activity, kind };
}

/**
 * Parse one SisFall file body.
 * @returns {{ subject, activity, kind, samples, skippedLines }}
 */
export function parseSisFallFile(filename, text, options = {}) {
  const { hz, accelScale, gyroScale } = { ...SISFALL_DEFAULTS, ...options };
  const { subject, activity, kind } = classifySisFallFile(filename);
  const samples = [];
  let skippedLines = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(';').filter((part) => part.trim() !== '');
    if (parts.length < 6) {
      skippedLines += 1;
      continue;
    }
    const [ax, ay, az, gx, gy, gz] = parts.slice(0, 6).map((part) => Number.parseFloat(part));
    if ([ax, ay, az, gx, gy, gz].some((value) => !Number.isFinite(value))) {
      skippedLines += 1;
      continue;
    }
    samples.push({
      t: samples.length / hz,
      ax: ax / accelScale,
      ay: ay / accelScale,
      az: az / accelScale,
      gx: gx / gyroScale,
      gy: gy / gyroScale,
      gz: gz / gyroScale,
    });
  }
  return { subject, activity, kind, samples, skippedLines };
}

/** Run parsed samples through the real IMU mapper into canonical observations. */
export function sisfallObservations(parsed, config = DEFAULT_CONFIG) {
  const mapper = new ImuMapper(config);
  const observations = [];
  for (const sample of parsed.samples) {
    const observation = mapper.map(sample);
    if (observation) observations.push(observation);
  }
  return observations;
}

/**
 * Labeled windows from one SisFall recording.
 * Fall files: positives are windows around the impact (peak downward-motion
 * proxy), from `padding.pre` seconds before to `padding.post` after. ADL files:
 * everything is negative. The first window is emitted once a full window of
 * frames exists after mapper warmup.
 *
 * @returns {Array<{ runId, tEnd, label, vector }>}
 */
export function sisfallWindows(parsed, { config = DEFAULT_CONFIG, windowSec = 1, hopSec = 0.5, padding } = {}) {
  const observations = sisfallObservations(parsed, config);
  if (observations.length < 2) return [];

  let dangerStart = Infinity;
  let dangerEnd = -Infinity;
  if (parsed.kind === 'fall') {
    const impact = observations.reduce(
      (best, o, index) => {
        const magnitude = Math.abs(o.features?.hipDropSpeed ?? 0);
        return magnitude > best.magnitude ? { magnitude, index } : best;
      },
      { magnitude: -1, index: 0 }
    );
    const impactT = observations[impact.index].t;
    dangerStart = impactT - (padding?.pre ?? 0.8);
    dangerEnd = impactT + (padding?.post ?? 1.0);
  }

  const runId = `${parsed.subject}-${parsed.activity}-${parsed.samples.length}`;
  const windows = [];
  const frameBuffer = [];
  let lastEnd = -Infinity;
  for (const observation of observations) {
    frameBuffer.push({ t: observation.t, features: observation.features, coverage: observation.coverage });
    while (frameBuffer.length && frameBuffer[0].t < observation.t - windowSec) frameBuffer.shift();
    if (observation.t - frameBuffer[0].t < windowSec - hopSec) continue;
    if (observation.t - lastEnd < hopSec) continue;
    const vector = buildWindowVector(frameBuffer, { minSpanSec: windowSec - hopSec, windowSec });
    if (!vector) continue;
    const label = parsed.kind === 'fall' && observation.t >= dangerStart && observation.t <= dangerEnd ? 1 : 0;
    windows.push({ runId, tEnd: observation.t, label, vector });
    lastEnd = observation.t;
  }
  return windows;
}
