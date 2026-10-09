// Phone motion source: wraps DeviceMotionEvent (accelerometer incl. gravity)
// into the canonical observation stream through the real ImuMapper.
//
// Units: DeviceMotionEvent reports m/s²; the mapper expects g, so values are
// divided by 9.81. accelerationIncludingGravity is REQUIRED — it embeds the
// gravity vector the mapper's lean estimate depends on. Devices/browsers that
// only provide gravity-free `acceleration` are counted as unsupported rather
// than silently mis-scored (coverage honesty, root AGENTS rule).
//
// Injectable seams for tests: pass any EventTarget-like `target`, a custom
// `now`, and a mapper. In the browser, start(window) is all that is needed.
// iOS Safari 13+ requires requestPermission() from a user gesture — call the
// exported helpers from a click handler before constructing the source.

import { ImuMapper } from './imu.js';
import { DEFAULT_CONFIG } from '../core/config.js';

export function motionPermissionRequired(scope = globalThis) {
  return (
    typeof scope.DeviceMotionEvent !== 'undefined' &&
    typeof scope.DeviceMotionEvent.requestPermission === 'function'
  );
}

/** @returns {'granted'|'denied'|'prompt'} — 'granted' when no permission gate exists. */
export async function requestMotionPermission(scope = globalThis) {
  if (!motionPermissionRequired(scope)) return 'granted';
  return scope.DeviceMotionEvent.requestPermission();
}

export class DevicemotionSource {
  constructor({
    mapper = new ImuMapper(DEFAULT_CONFIG),
    onObservation = null,
    now = () => performance.now() / 1000,
  } = {}) {
    this.mapper = mapper;
    this.onObservation = onObservation;
    this.now = now;
    this.stats = { samples: 0, observations: 0, unsupported: 0, warming: 0 };
    this._target = null;
    this._handler = (event) => this.handleEvent(event);
  }

  start(target = globalThis) {
    this.stop();
    this._target = target;
    target.addEventListener('devicemotion', this._handler);
  }

  stop() {
    if (this._target) {
      this._target.removeEventListener('devicemotion', this._handler);
      this._target = null;
    }
  }

  /**
   * Process one DeviceMotionEvent. Exposed for tests.
   * @returns an observation, or null while unsupported / warming up.
   */
  handleEvent(event, t = this.now()) {
    this.stats.samples += 1;
    const accel = event?.accelerationIncludingGravity;
    if (!accel || accel.x == null || accel.y == null || accel.z == null) {
      this.stats.unsupported += 1;
      return null;
    }
    const observation = this.mapper.map({
      t,
      ax: accel.x / 9.81,
      ay: accel.y / 9.81,
      az: accel.z / 9.81,
    });
    if (!observation) {
      this.stats.warming += 1; // mapper still capturing its upright reference
      return null;
    }
    this.stats.observations += 1;
    if (this.onObservation) this.onObservation(observation);
    return observation;
  }
}
