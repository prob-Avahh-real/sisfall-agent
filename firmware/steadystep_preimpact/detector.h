// Pure-C pre-impact detector for the SteadyStep wearable (M4).
//
// No Arduino dependencies: compiles and runs on the host for tests (see
// test/detector_host_test.c). Mirrors the JS pipeline: gravity low-pass ->
// tilt; leaky-integrated drop proxy; high-pass lateral magnitude; the shared
// coverage-aware 0-100 score; a trend-slope forecast with the same gates.
//
// All numeric constants live in config.h, which is GENERATED from
// core/config.js by tools/gen-firmware.js — a Node drift test enforces parity,
// so the wearable can never silently diverge from the web/agent thresholds.

#ifndef STEADYSTEP_DETECTOR_H
#define STEADYSTEP_DETECTOR_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SS_FEATURE_COUNT 4
#define SS_SLOPE_CAP 64 // ring capacity for the score trend history (>= SS_SLOPE_WINDOW + margin)

enum ss_state {
  SS_STABLE = 0,
  SS_CAUTION = 1,
  SS_IMMINENT = 2,
  SS_DANGER = 3
};

typedef struct {
  float torso_lean;     // degrees from the self-calibrated upright reference
  float lateral_offset; // proxy: smoothed high-pass horizontal magnitude / gain
  float hip_drop;       // proxy: leaky-integrated downward acceleration
  float knee_asym;      // unavailable on a single IMU; kept for score parity
} ss_features_t;

typedef struct {
  float gravity[3];
  int gravity_init;
  float up[3];
  float up_sum[3];
  int up_count;
  int ready;
  float drop_vel;
  float lateral_mag;
  float last_t;
  int first;
  float ring_t[SS_SLOPE_CAP];
  float ring_s[SS_SLOPE_CAP];
  int ring_count;
  int ring_head;
  uint8_t state;
} ss_detector_t;

typedef struct {
  uint8_t ready;        // 0 until the upright reference is captured
  uint8_t state;        // ss_state
  uint8_t changed;      // state differs from the previous call
  float score;          // coverage-aware score, 0-100
  float slope;          // score trend, points per second
  float time_to_danger; // seconds; NAN when not rising toward danger
  ss_features_t features;
} ss_result_t;

/** Coverage-aware score — same formula as core/risk.js for the firmware's
 *  fixed coverage set (lean measured; drop/lateral proxy; asymmetry absent). */
float ss_score(const ss_features_t* features);

void ss_detector_init(ss_detector_t* d);

/** Feed one raw accelerometer sample (g units). Returns the evaluated state. */
ss_result_t ss_detector_update(ss_detector_t* d, float t, float ax, float ay, float az);

#ifdef __cplusplus
}
#endif

#endif
