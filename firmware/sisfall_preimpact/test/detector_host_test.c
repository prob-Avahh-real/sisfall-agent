// Host test for the wearable pre-impact detector (M4).
//
// 1) Score parity: sf_score must match core/risk.js golden vectors within one
//    point (the vectors are generated from the actual JS implementation).
// 2) Behavioral sequence: a calm synthetic walk stays below imminent; a
//    simulated tilt event reaches imminent/danger; the detector recovers to
//    stable afterwards.
//
// Build & run (from firmware/sisfall_preimpact):
//   cc -std=c11 -Wall -Wextra -Werror -O2 -I. -Itest detector.c test/detector_host_test.c -lm -o host_test && ./host_test
//
// This is the verification boundary: on-device behavior (I2C timing, BLE,
// haptics) still needs the README manual checklist.

#include <math.h>
#include <stdio.h>
#include "detector.h"
#include "config.h"
#include "golden_vectors.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static int failures = 0;

#define CHECK(cond, ...)                 \
  do {                                   \
    if (!(cond)) {                       \
      printf("FAIL: ");                  \
      printf(__VA_ARGS__);               \
      printf("\n");                      \
      failures += 1;                     \
    }                                    \
  } while (0)

static float smoothstep(float p) {
  if (p < 0.0f) p = 0.0f;
  if (p > 1.0f) p = 1.0f;
  return p * p * (3.0f - 2.0f * p);
}

int main(void) {
  const float hz = SF_TARGET_HZ;
  const float step = 1.0f / hz;

  // 1) Golden score parity.
  int worst = 0;
  for (int i = 0; i < SF_GOLDEN_COUNT; ++i) {
    sf_features_t f;
    f.torso_lean = SF_GOLDEN_INPUT[i][0];
    f.lateral_offset = SF_GOLDEN_INPUT[i][1];
    f.hip_drop = SF_GOLDEN_INPUT[i][2];
    f.knee_asym = SF_GOLDEN_INPUT[i][3];
    const int got = (int)lroundf(sf_score(&f));
    int delta = got - SF_GOLDEN_EXPECTED[i];
    if (delta < 0) delta = -delta;
    if (delta > worst) worst = delta;
    CHECK(delta <= 1, "golden %d: got %d expected %d", i, got, SF_GOLDEN_EXPECTED[i]);
  }
  printf("score parity: %d vectors, worst delta %d\n", SF_GOLDEN_COUNT, worst);

  // 2) Calm walk stays below imminent.
  sf_detector_t d;
  sf_detector_init(&d);
  float t = 0.0f;
  uint8_t maxWalkState = 0;
  for (int i = 0; i < (int)(10.0f * hz); ++i, t += step) {
    const float motion = 0.12f * sinf(2.0f * (float)M_PI * 1.1f * t);
    const sf_result_t r = sf_detector_update(&d, t, motion * 0.35f, 1.0f + motion, 0.0f);
    if (r.state > maxWalkState) maxWalkState = r.state;
  }
  CHECK(maxWalkState <= SF_CAUTION, "walk reached state %u", (unsigned)maxWalkState);
  printf("walk: max state %u\n", (unsigned)maxWalkState);

  // 3) Tilt event: ramp 55° over 1.8 s, hold 0.6 s, recover 1.6 s.
  const float ramp = 1.8f;
  const float hold = 0.6f;
  const float recover = 1.6f;
  uint8_t maxEventState = 0;
  int sawImminent = 0;
  for (float dt = 0.0f; dt < ramp; dt += step, t += step) {
    const float p = smoothstep(dt / ramp);
    const float theta = p * 55.0f * (float)M_PI / 180.0f;
    const float lateral = 0.3f * p * sinf(2.0f * (float)M_PI * 2.2f * t);
    const sf_result_t r = sf_detector_update(&d, t, sinf(theta) + lateral, cosf(theta), 0.0f);
    if (r.state > maxEventState) maxEventState = r.state;
    if (r.state >= SF_IMMINENT) sawImminent = 1;
  }
  for (float dt = 0.0f; dt < hold; dt += step, t += step) {
    const float theta = 55.0f * (float)M_PI / 180.0f;
    const float lateral = 0.3f * sinf(2.0f * (float)M_PI * 2.2f * t);
    const sf_result_t r = sf_detector_update(&d, t, sinf(theta) + lateral, cosf(theta), 0.0f);
    if (r.state > maxEventState) maxEventState = r.state;
    if (r.state >= SF_IMMINENT) sawImminent = 1;
  }
  for (float dt = 0.0f; dt < recover; dt += step, t += step) {
    const float p = 1.0f - smoothstep(dt / recover);
    const float theta = p * 55.0f * (float)M_PI / 180.0f;
    sf_detector_update(&d, t, sinf(theta), cosf(theta), 0.0f);
  }
  CHECK(sawImminent, "tilt event never reached imminent (max state %u)", (unsigned)maxEventState);

  // Settle 4 s and expect a return to stable.
  for (float dt = 0.0f; dt < 4.0f; dt += step, t += step) {
    const float motion = 0.1f * sinf(2.0f * (float)M_PI * 1.1f * t);
    sf_detector_update(&d, t, motion * 0.35f, 1.0f + motion, 0.0f);
  }
  CHECK(d.state == SF_STABLE, "did not recover to stable (state %u)", (unsigned)d.state);
  printf("tilt event: max state %u, recovered to stable\n", (unsigned)maxEventState);

  if (failures > 0) {
    printf("HOST TEST FAILED: %d failure(s)\n", failures);
    return 1;
  }
  printf("HOST TEST OK\n");
  return 0;
}
