import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImuPacket, BleImuSource } from '../sources/web-bluetooth.js';

function packet(ax, ay, az, scale = 4096) {
  const dataView = new DataView(new ArrayBuffer(6));
  dataView.setInt16(0, Math.round(ax * scale), true);
  dataView.setInt16(2, Math.round(ay * scale), true);
  dataView.setInt16(4, Math.round(az * scale), true);
  return dataView;
}

test('parseImuPacket decodes int16 LE samples to g units', () => {
  assert.deepEqual(parseImuPacket(packet(1, -0.5, 0)), { ax: 1, ay: -0.5, az: 0 });
});

test('parseImuPacket respects a custom scale and rejects truncated data', () => {
  assert.equal(parseImuPacket(packet(1, 0, 0, 8192), { scale: 8192 }).ax, 1);
  assert.equal(parseImuPacket(new DataView(new ArrayBuffer(4))), null);
  assert.equal(parseImuPacket(null), null);
});

test('notification flow feeds the real mapper end to end', () => {
  let t = 0;
  const observations = [];
  const source = new BleImuSource({ now: () => (t += 1 / 50), onObservation: (o) => observations.push(o), bluetooth: {} });
  const fakeEvent = () => ({ target: { value: packet(0, 1, 0) } }); // upright
  let last = null;
  for (let i = 0; i < 40; i += 1) last = source.handleNotification(fakeEvent());
  assert.ok(last, 'mapper warmed through BLE packets');
  assert.equal(source.stats.badPackets, 0);
  assert.ok(observations.length > 0);
  assert.equal(last.coverage.kneeAsymmetry, 'unavailable');
  assert.equal(last.coverage.torsoLean, 'measured');
});

test('bad packets are counted, not emitted', () => {
  const source = new BleImuSource({ bluetooth: {} });
  assert.equal(source.handleNotification({ target: { value: new DataView(new ArrayBuffer(3)) } }), null);
  assert.equal(source.handleNotification({ target: { value: null } }), null);
  assert.equal(source.stats.badPackets, 2);
  assert.equal(source.stats.packets, 2);
});

test('connect() uses the configured GATT UUIDs and subscribes to notifications', async () => {
  const calls = [];
  const characteristic = {
    addEventListener: (type) => calls.push(['listen', type]),
    removeEventListener: () => {},
    startNotifications: async () => calls.push(['start']),
  };
  const bluetooth = {
    requestDevice: async (options) => {
      calls.push(['request', options.filters[0].services[0]]);
      return {
        gatt: {
          connect: async () => ({
            getPrimaryService: async (uuid) => {
              calls.push(['service', uuid]);
              return {
                getCharacteristic: async (cuuid) => {
                  calls.push(['char', cuuid]);
                  return characteristic;
                },
              };
            },
          }),
        },
      };
    },
  };
  const source = new BleImuSource({ bluetooth });
  const device = await source.connect();
  assert.ok(device);
  const uuids = calls.filter(([kind]) => kind === 'service' || kind === 'char').map(([, value]) => value);
  assert.ok(uuids.length === 2 && uuids.every((uuid) => uuid.startsWith('0000ffe')), uuids.join(','));
  assert.ok(calls.some(([kind]) => kind === 'start'));
  assert.ok(calls.some(([kind, value]) => kind === 'listen' && value === 'characteristicvaluechanged'));
  source.stop();
  assert.equal(source.characteristic, null);
});

test('connect() without Web Bluetooth rejects with a clear error', async () => {
  const source = new BleImuSource({ bluetooth: null });
  await assert.rejects(() => source.connect(), /不支持 Web 蓝牙/);
});
