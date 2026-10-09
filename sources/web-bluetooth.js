// BLE band source: subscribes to GATT notifications carrying packed
// accelerometer samples (default packet: 3 × int16 little-endian, g = raw /
// accelScale — the common firmware layout for FFE0/FFE1-style UART modules)
// and feeds them through the real ImuMapper.
//
// Browser support: Web Bluetooth exists in Chrome/Edge (desktop + Android).
// Safari and iOS do not implement it — vendor watch ecosystems (watchOS /
// WearOS) need companion apps; that is out of scope for this adapter (README).
//
// Injectable seams for tests: pass a fake `bluetooth` object and a custom
// `now`; `handleNotification` can be driven directly with fake events.

import { ImuMapper } from './imu.js';
import { DEFAULT_CONFIG } from '../core/config.js';

/** Parse one packed accel packet. @returns {ax, ay, az} in g, or null when truncated. */
export function parseImuPacket(dataView, { scale = 4096, offset = 0 } = {}) {
  if (!dataView || dataView.byteLength - offset < 6) return null;
  return {
    ax: dataView.getInt16(offset, true) / scale,
    ay: dataView.getInt16(offset + 2, true) / scale,
    az: dataView.getInt16(offset + 4, true) / scale,
  };
}

export class BleImuSource {
  constructor({
    config = DEFAULT_CONFIG,
    mapper = null,
    onObservation = null,
    onStatus = null,
    now = () => performance.now() / 1000,
    bluetooth = globalThis.navigator?.bluetooth,
  } = {}) {
    this.cfg = config.device.ble;
    this.mapper = mapper ?? new ImuMapper(config);
    this.onObservation = onObservation;
    this.onStatus = onStatus;
    this.now = now;
    this.bluetooth = bluetooth;
    this.device = null;
    this.characteristic = null;
    this.stats = { packets: 0, observations: 0, badPackets: 0, warming: 0 };
    this._onNotify = (event) => this.handleNotification(event);
  }

  /** Request a device, subscribe to the configured GATT characteristic. */
  async connect() {
    if (!this.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser (use Chrome/Edge on desktop or Android)');
    }
    this.onStatus?.('Requesting BLE device…');
    const device = await this.bluetooth.requestDevice({
      filters: [{ services: [this.cfg.serviceUuid] }],
      optionalServices: [this.cfg.serviceUuid],
    });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(this.cfg.serviceUuid);
    const characteristic = await service.getCharacteristic(this.cfg.characteristicUuid);
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', this._onNotify);
    this.device = device;
    this.characteristic = characteristic;
    this.onStatus?.('Connected — streaming IMU samples');
    return device;
  }

  /** Unsubscribe and disconnect. Safe to call when not connected. */
  stop() {
    try {
      this.characteristic?.removeEventListener('characteristicvaluechanged', this._onNotify);
      this.device?.gatt?.disconnect?.();
    } catch {
      // teardown must never throw
    }
    this.characteristic = null;
    this.device = null;
  }

  /** Process one GATT notification. Exposed for tests. */
  handleNotification(event) {
    this.stats.packets += 1;
    const sample = parseImuPacket(event?.target?.value, { scale: this.cfg.accelScale });
    if (!sample) {
      this.stats.badPackets += 1;
      return null;
    }
    const observation = this.mapper.map({ t: this.now(), ...sample });
    if (!observation) {
      this.stats.warming += 1;
      return null;
    }
    this.stats.observations += 1;
    if (this.onObservation) this.onObservation(observation);
    return observation;
  }
}
