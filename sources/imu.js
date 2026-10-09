// IMU source: maps raw accelerometer samples (phone in a pocket, wearable on
// the chest/waist) into the canonical feature schema.
//
// Honesty about what a single IMU can observe:
//   torsoLean     'measured' — angle between the smoothed gravity vector and
//                 an "upright" reference captured during a quiet start.
//   hipDropSpeed  'proxy'    — leaky integral of downward acceleration
//                 (acceleration along the up-reference below 1 g).
//   lateralOffset 'proxy'    — smoothed magnitude of high-frequency
//                 horizontal acceleration (balance corrections), scaled by a
//                 documented heuristic gain.
//   kneeAsymmetry 'unavailable' — not observable from one IMU; the risk
//                 engine redistributes its weight.
//
// Proxy values carry coverage 'proxy' so scoring discounts them; the
// heuristics themselves are config.imu and are expected to be tuned against
// field data (milestone M3).

import { DEFAULT_CONFIG } from '../core/config.js';
import { clamp01 } from '../core/features.js';

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a) => Math.hypot(a.x, a.y, a.z);

function angleBetween(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na < 1e-9 || nb < 1e-9) return 0;
  const c = Math.min(1, Math.max(-1, dot(a, b) / (na * nb)));
  return (Math.acos(c) * 180) / Math.PI;
}

export class ImuMapper {
  constructor(config = DEFAULT_CONFIG) {
    this.cfg = { ...DEFAULT_CONFIG.imu, ...(config.imu ?? {}) };
    this.reset();
  }

  reset() {
    this.gravity = null;
    this.upRef = null;
    this.upSamples = [];
    this.dropVel = 0;
    this.lateralMag = 0;
    this.lastT = null;
  }

  get ready() {
    return this.upRef != null;
  }

  /** @param {{t:number,ax:number,ay:number,az:number,gx?:number,gy?:number,gz?:number}} sample
   *  accel in g units. Returns an observation, or null while the up-reference
   *  is still being captured. */
  map(sample) {
    const { t, ax = 0, ay = 0, az = 0 } = sample;
    const dt = this.lastT == null ? 1 / 50 : Math.max(1e-3, Math.min(0.2, t - this.lastT));
    this.lastT = t;
    const accel = { x: ax, y: ay, z: az };

    // Smoothed gravity/tilt estimate.
    if (!this.gravity) {
      this.gravity = { ...accel };
    } else {
      const alpha = 1 - Math.exp(-dt / this.cfg.gravityTau);
      this.gravity.x += alpha * (accel.x - this.gravity.x);
      this.gravity.y += alpha * (accel.y - this.gravity.y);
      this.gravity.z += alpha * (accel.z - this.gravity.z);
    }

    // Capture the upright reference during a quiet start.
    if (!this.upRef) {
      if (Math.abs(norm(accel) - 1) < 0.15) {
        this.upSamples.push(accel);
        if (this.upSamples.length >= this.cfg.upRefFrames) {
          const sum = this.upSamples.reduce((s, a) => ({ x: s.x + a.x, y: s.y + a.y, z: s.z + a.z }), { x: 0, y: 0, z: 0 });
          const n = this.upSamples.length;
          const nn = Math.hypot(sum.x, sum.y, sum.z) || 1;
          this.upRef = { x: sum.x / nn, y: sum.y / nn, z: sum.z / nn };
        }
      } else {
        this.upSamples = [];
      }
      return null;
    }

    const torsoLean = angleBetween(this.gravity, this.upRef);

    // Downward drop proxy: smoothed acceleration along the up-reference below
    // 1 g means the body is accelerating downward (sitting, buckling, falling).
    const along = dot(this.gravity, this.upRef) - 1;
    this.dropVel += (Math.max(0, -along) * this.cfg.dropGain - this.dropVel * this.cfg.dropDecay) * dt;

    // Lateral proxy: high-frequency horizontal residual (balance corrections).
    const hp = { x: accel.x - this.gravity.x, y: accel.y - this.gravity.y, z: accel.z - this.gravity.z };
    const hpUp = dot(hp, this.upRef);
    const hpHoriz = Math.hypot(hp.x - hpUp * this.upRef.x, hp.y - hpUp * this.upRef.y, hp.z - hpUp * this.upRef.z);
    const alphaL = 1 - Math.exp(-dt / this.cfg.lateralTau);
    this.lateralMag += alphaL * (hpHoriz - this.lateralMag);

    return {
      t,
      features: {
        torsoLean,
        lateralOffset: this.lateralMag / this.cfg.lateralGain,
        hipDropSpeed: clamp01(this.dropVel),
        kneeAsymmetry: 0,
      },
      coverage: {
        torsoLean: 'measured',
        lateralOffset: 'proxy',
        hipDropSpeed: 'proxy',
        kneeAsymmetry: 'unavailable',
      },
    };
  }
}
