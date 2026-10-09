// SisFall pre-impact band — ESP32-C3 + MPU6050 (M4).
//
// On-device pre-impact detection with local haptics. The accelerometer stream
// is exposed over BLE exactly as the web sidebar expects (service FFE0,
// characteristic FFE1, 6-byte int16-LE packets at ~50 Hz) — this firmware IS
// the peripheral that sources/web-bluetooth.js connects to, closing the loop
// between M4 hardware and the M2 web adapter.
//
// NOT hardware-verified. config.h + test/golden_vectors.h are generated from
// core/config.js and core/risk.js (npm run firmware); detector.c mirrors the
// web pipeline and is host-tested against those golden vectors.
//
// Wiring (ESP32-C3): MPU6050 SDA->GPIO8, SCL->GPIO9, VCC 3V3, GND;
// buzzer/haptic driver on GPIO3 (LEDC PWM).
//
// Flash:  arduino-cli compile --fqbn esp32:esp32:esp32c3 .
//         arduino-cli upload  --fqbn esp32:esp32:esp32c3 -p /dev/ttyUSB0 .
// (Requires the esp32 core: arduino-cli core install esp32:esp32. See README.)

#include <Arduino.h>
#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "config.h"
#include "detector.h"

#define SF_I2C_SDA 8
#define SF_I2C_SCL 9
#define SF_BUZZER_PIN 3

#define MPU6050_ADDR 0x68
#define MPU6050_ACCEL_SCALE 8192.0f // ±4 g range: 8192 LSB per g
#define MPU6050_ACCEL_REG 0x3B

static const char* SF_SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
static const char* SF_ACCEL_CHAR_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";

static sf_detector_t detector;
static BLECharacteristic* accelCharacteristic = nullptr;
static bool bleSubscribed = false;
static unsigned long sampleIndex = 0;
static uint8_t lastBuzzedState = 0xFF;

class AccelCallbacks : public BLECharacteristicCallbacks {
  void onSubscribe(BLECharacteristic* characteristic, bool notify) override {
    (void)characteristic;
    bleSubscribed = notify;
  }
};

static void mpuInit() {
  Wire.begin(SF_I2C_SDA, SF_I2C_SCL);
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x6B); // PWR_MGMT_1
  Wire.write(0x00); // wake
  Wire.endTransmission();
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x1C); // ACCEL_CONFIG
  Wire.write(0x08); // ±4 g
  Wire.endTransmission();
}

static bool mpuReadAccel(float out[3]) {
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(MPU6050_ACCEL_REG);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU6050_ADDR, 6) != 6) return false;
  int16_t raw[3];
  for (int i = 0; i < 3; ++i) {
    const uint8_t hi = Wire.read();
    const uint8_t lo = Wire.read();
    raw[i] = (int16_t)((hi << 8) | lo); // MPU6050 registers are big-endian
  }
  for (int i = 0; i < 3; ++i) out[i] = (float)raw[i] / MPU6050_ACCEL_SCALE;
  return true;
}

// Non-blocking haptic patterns: stable silent; caution one short pulse every
// 4 s; imminent two pulses per second; danger continuous.
static void updateHaptics(uint8_t state, unsigned long nowMs) {
  if (state != lastBuzzedState) lastBuzzedState = state;
  switch (state) {
    case SF_STABLE: ledcWrite(0, 0); break;
    case SF_CAUTION: ledcWrite(0, (nowMs % 4000UL) < 120UL ? 128 : 0); break;
    case SF_IMMINENT: ledcWrite(0, (nowMs % 500UL) < 160UL ? 200 : 0); break;
    default: ledcWrite(0, 255); break; // SF_DANGER
  }
}

static void setupBle() {
  BLEDevice::init("SisFall Band");
  BLEServer* server = BLEDevice::createServer();
  BLEService* service = server->createService(SF_SERVICE_UUID);
  accelCharacteristic = service->createCharacteristic(
      SF_ACCEL_CHAR_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
  accelCharacteristic->addDescriptor(new BLE2902());
  accelCharacteristic->setCallbacks(new AccelCallbacks());
  service->start();
  server->getAdvertising()->addServiceUUID(SF_SERVICE_UUID);
  server->getAdvertising()->start();
}

void setup() {
  Serial.begin(115200);
  ledcSetup(0, 2000, 8);
  ledcAttachPin(SF_BUZZER_PIN, 0);
  mpuInit();
  sf_detector_init(&detector);
  setupBle();
  Serial.println("SisFall band ready");
}

void loop() {
  static unsigned long lastSampleUs = 0;
  const unsigned long intervalUs = (unsigned long)(1000000.0f / SF_TARGET_HZ);
  const unsigned long nowUs = micros();
  if (nowUs - lastSampleUs < intervalUs) return;
  lastSampleUs = nowUs;

  float accel[3];
  if (!mpuReadAccel(accel)) return;

  const float t = (float)nowUs / 1000000.0f;
  const sf_result_t result = sf_detector_update(&detector, t, accel[0], accel[1], accel[2]);
  updateHaptics(result.state, millis());

  if (result.ready && result.changed) {
    // Serial-only event log; caregiver notification is a follow-up milestone.
    Serial.printf("EVT state=%u score=%.1f slope=%.1f ttd=%.2f\n",
                  (unsigned)result.state, result.score, result.slope, result.time_to_danger);
  }

  if (result.ready && bleSubscribed && accelCharacteristic) {
    // 6-byte int16 LE packet — the exact format sources/web-bluetooth.js parses.
    int16_t packet[3];
    for (int i = 0; i < 3; ++i) packet[i] = (int16_t)lroundf(accel[i] * MPU6050_ACCEL_SCALE);
    accelCharacteristic->setValue((uint8_t*)packet, sizeof(packet));
    accelCharacteristic->notify();
  }

  sampleIndex += 1;
}
