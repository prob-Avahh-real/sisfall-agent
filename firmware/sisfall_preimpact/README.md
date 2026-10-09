# SisFall pre-impact band (M4)

ESP32-C3 + MPU6050 wearable that runs the SAME detection pipeline as the web
agent, on-device, with local haptics. It also exposes the accelerometer stream
over BLE in the exact format the web UI's **Connect BLE band** mode parses
(service `FFE0`, characteristic `FFE1`, 6-byte int16-LE packets, g = raw/4096)
— this firmware is the peripheral the M2 adapter was written for.

## Verification status (read this first)

| Layer | Status |
| --- | --- |
| Thresholds | GENERATED from `core/config.js` (`npm run firmware`); drift test fails on any divergence |
| Score function | Host-tested: 66 golden vectors must match `core/risk.js` within 1 point (**currently exact, delta 0**) |
| Detector behavior | Host-tested: calm walk stays stable; tilt event reaches imminent; recovery returns to stable |
| Hardware (I2C, BLE, haptics, battery) | **NOT verified** — manual checklist below |

## Bill of materials

- ESP32-C3 dev board (any variant with exposed strapping-free GPIOs)
- MPU6050 breakout (GY-521 class)
- Vibration motor or piezo buzzer (+ transistor/driver if the motor draws >20 mA)
- 3.7 V LiPo + TP4056 charge board (production battery path is out of scope here)
- Enclosure worn on the chest or carried in a front pocket

## Wiring

| Signal | ESP32-C3 |
| --- | --- |
| MPU6050 SDA | GPIO8 |
| MPU6050 SCL | GPIO9 |
| MPU6050 VCC / GND | 3V3 / GND |
| Buzzer or motor driver | GPIO3 (LEDC PWM) |

## Flashing

```bash
arduino-cli core install esp32:esp32
arduino-cli compile --fqbn esp32:esp32:esp32c3 .
arduino-cli upload  --fqbn esp32:esp32:esp32c3 -p /dev/ttyUSB0 .
```

Note: the sketch targets the Arduino-ESP32 **core 2.x** LEDC API
(`ledcSetup`/`ledcAttachPin`). On core 3.x, replace those two calls with
`ledcAttach(SF_BUZZER_PIN, 2000, 8)`.

## Manual hardware checklist

1. Flash, open the serial monitor at 115200: "SisFall band ready".
2. Hold still ~1 s (upright reference capture). Buzzer silent; serial quiet.
3. Tilt the board forward past ~50° and hold: serial prints `EVT state=2` (then
   `3`), buzzer pulses fast then goes continuous.
4. Straighten up: state returns to `0`, buzzer silent.
5. Chrome (desktop or Android): open the web UI, press **Connect BLE band**,
   pick "SisFall Band". The live badge shows `BLE · ~50 Hz`; tilt to move
   the on-screen "Body alignment".
6. Walk 60 s with the band on the chest: no false alarms (state stays 0).
7. Battery/thermal sanity: 10 min run, board stays warm-not-hot; note current
   draw for the battery budget (not yet instrumented).

## Wire protocol

- Service `0000ffe0-0000-1000-8000-00805f9b34fb`
- Characteristic `0000ffe1-0000-1000-8000-00805f9b34fb` (notify)
- Payload: 6 bytes = three int16 little-endian values (ax, ay, az), g = raw / 4096
  (firmware sends raw × 8192 LSB/g, matching the web adapter's default scale)

## Not in this milestone

- Caregiver notification: events are printed over Serial only; no transmission.
- Battery management, power modes, enclosure design.
- Firmware OTA updates.
