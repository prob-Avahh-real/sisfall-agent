#include "detector.h"
#include "config.h"
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static float clamp01f(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }
static float norm3(const float v[3]) { return sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }
static float dot3(const float a[3], const float b[3]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

static float angle_between(const float a[3], const float b[3]) {
  float na = norm3(a);
  float nb = norm3(b);
  if (na < 1e-9f || nb < 1e-9f) return 0.0f;
  float c = dot3(a, b) / (na * nb);
  if (c > 1.0f) c = 1.0f;
  if (c < -1.0f) c = -1.0f;
  return acosf(c) * 180.0f / (float)M_PI;
}

float ss_score(const ss_features_t* f) {
  static const float weights[SS_FEATURE_COUNT] = { SS_WEIGHT_TORSO, SS_WEIGHT_OFFSET, SS_WEIGHT_DROP, SS_WEIGHT_ASYM };
  static const float starts[SS_FEATURE_COUNT] = { SS_SCALE_TORSO_START, SS_SCALE_OFFSET_START, SS_SCALE_DROP_START, SS_SCALE_ASYM_START };
  static const float fulls[SS_FEATURE_COUNT] = { SS_SCALE_TORSO_FULL, SS_SCALE_OFFSET_FULL, SS_SCALE_DROP_FULL, SS_SCALE_ASYM_FULL };
  static const float cov[SS_FEATURE_COUNT] = { SS_COVERAGE_MEASURED, SS_COVERAGE_PROXY, SS_COVERAGE_PROXY, SS_COVERAGE_UNAVAILABLE };
  const float values[SS_FEATURE_COUNT] = { f->torso_lean, f->lateral_offset, f->hip_drop, f->knee_asym };
  float num = 0.0f;
  float den = 0.0f;
  for (int i = 0; i < SS_FEATURE_COUNT; ++i) {
    float p = clamp01f((values[i] - starts[i]) / (fulls[i] - starts[i]));
    num += weights[i] * p * cov[i];
    den += weights[i] * cov[i];
  }
  return den > 0.0f ? (num / den) * 100.0f : 0.0f;
}

void ss_detector_init(ss_detector_t* d) {
  for (int i = 0; i < 3; ++i) {
    d->gravity[i] = 0.0f;
    d->up[i] = 0.0f;
    d->up_sum[i] = 0.0f;
  }
  d->gravity_init = 0;
  d->up_count = 0;
  d->ready = 0;
  d->drop_vel = 0.0f;
  d->lateral_mag = 0.0f;
  d->last_t = 0.0f;
  d->first = 1;
  d->ring_count = 0;
  d->ring_head = 0;
  d->state = SS_STABLE;
}

static void ring_push(ss_detector_t* d, float t, float s) {
  d->ring_t[d->ring_head] = t;
  d->ring_s[d->ring_head] = s;
  d->ring_head = (d->ring_head + 1) % SS_SLOPE_CAP;
  if (d->ring_count < SS_SLOPE_CAP) d->ring_count += 1;
}

static float fit_slope(const ss_detector_t* d) {
  int n = d->ring_count;
  if (n > SS_SLOPE_WINDOW) n = SS_SLOPE_WINDOW;
  if (n < 4) return 0.0f;
  float sx = 0.0f;
  float sy = 0.0f;
  float sxx = 0.0f;
  float sxy = 0.0f;
  for (int i = 0; i < n; ++i) {
    int idx = (d->ring_head - n + i + SS_SLOPE_CAP) % SS_SLOPE_CAP;
    float x = d->ring_t[idx];
    float y = d->ring_s[idx];
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  float denom = (float)n * sxx - sx * sx;
  if (fabsf(denom) < 1e-9f) return 0.0f;
  return ((float)n * sxy - sx * sy) / denom;
}

ss_result_t ss_detector_update(ss_detector_t* d, float t, float ax, float ay, float az) {
  ss_result_t r;
  r.ready = 0;
  r.state = d->state;
  r.changed = 0;
  r.score = 0.0f;
  r.slope = 0.0f;
  r.time_to_danger = NAN;
  r.features.torso_lean = 0.0f;
  r.features.lateral_offset = 0.0f;
  r.features.hip_drop = 0.0f;
  r.features.knee_asym = 0.0f;

  float dt = d->first ? (1.0f / SS_TARGET_HZ) : (t - d->last_t);
  if (dt < 0.001f) dt = 0.001f;
  if (dt > 0.2f) dt = 0.2f;
  d->last_t = t;
  d->first = 0;

  float accel[3] = { ax, ay, az };

  if (!d->gravity_init) {
    for (int i = 0; i < 3; ++i) d->gravity[i] = accel[i];
    d->gravity_init = 1;
  } else {
    float alpha = 1.0f - expf(-dt / SS_GRAVITY_TAU);
    for (int i = 0; i < 3; ++i) d->gravity[i] += alpha * (accel[i] - d->gravity[i]);
  }

  if (!d->ready) {
    if (fabsf(norm3(accel) - 1.0f) < 0.15f) {
      for (int i = 0; i < 3; ++i) d->up_sum[i] += accel[i];
      d->up_count += 1;
      if (d->up_count >= SS_UP_REF_FRAMES) {
        float n = norm3(d->up_sum);
        if (n > 1e-6f) {
          for (int i = 0; i < 3; ++i) d->up[i] = d->up_sum[i] / n;
          d->ready = 1;
        }
      }
    } else {
      d->up_count = 0;
      for (int i = 0; i < 3; ++i) d->up_sum[i] = 0.0f;
    }
    return r;
  }
  r.ready = 1;

  float torso_lean = angle_between(d->gravity, d->up);

  float along = dot3(d->gravity, d->up) - 1.0f;
  if (along < 0.0f) {
    d->drop_vel += ((-along) * SS_DROP_GAIN - d->drop_vel * SS_DROP_DECAY) * dt;
    if (d->drop_vel < 0.0f) d->drop_vel = 0.0f;
  } else {
    d->drop_vel -= d->drop_vel * SS_DROP_DECAY * dt;
    if (d->drop_vel < 0.0f) d->drop_vel = 0.0f;
  }

  float hp[3];
  for (int i = 0; i < 3; ++i) hp[i] = accel[i] - d->gravity[i];
  float hp_up = dot3(hp, d->up);
  float hp_res[3];
  for (int i = 0; i < 3; ++i) hp_res[i] = hp[i] - hp_up * d->up[i];
  float hph = norm3(hp_res);
  float alpha_l = 1.0f - expf(-dt / SS_LATERAL_TAU);
  d->lateral_mag += alpha_l * (hph - d->lateral_mag);

  ss_features_t f;
  f.torso_lean = torso_lean;
  f.lateral_offset = d->lateral_mag / SS_LATERAL_GAIN;
  f.hip_drop = clamp01f(d->drop_vel);
  f.knee_asym = 0.0f;
  r.features = f;

  float score = ss_score(&f);
  r.score = score;

  ring_push(d, t, score);
  float slope = fit_slope(d);
  r.slope = slope;

  float ttd = NAN;
  if (slope >= SS_MIN_RISE_RATE) {
    ttd = score >= SS_THRESHOLD_DANGER ? 0.0f : (SS_THRESHOLD_DANGER - score) / slope;
  }
  r.time_to_danger = ttd;

  int imminent = (slope >= SS_MIN_RISE_RATE) && (score >= SS_SCORE_FLOOR) &&
                 !isnan(ttd) && (ttd <= SS_IMMINENT_HORIZON_SEC);

  uint8_t state;
  if (score >= SS_THRESHOLD_DANGER) state = SS_DANGER;
  else if (imminent) state = SS_IMMINENT;
  else if (score >= SS_THRESHOLD_CAUTION) state = SS_CAUTION;
  else state = SS_STABLE;

  r.changed = (state != d->state) ? 1 : 0;
  d->state = state;
  r.state = state;
  return r;
}
