# SteadyStep — fall-risk posture agent

An agent that watches movement (camera pose or wearable IMU), **predicts dangerous
postures before they become falls**, factors in non-motion symptoms you report
(dizziness, fatigue, poor sleep, ...), classifies the pattern into a **risk stage**,
and produces **stage-matched care advice** — all locally, nothing uploaded.

This is a prototype, not a medical device. See "Safety" below.

## Quick start

```bash
npm test                                   # 69 tests, deterministic scenarios
npm run demo                               # near-fall scenario, full agent timeline
node scripts/demo.js dizzy-walk            # symptom-fusion scenario
node scripts/demo.js wobble-shift          # unusual-for-you detection
npm start                                  # web UI at http://localhost:4173
```

The web UI has two modes: **camera** (MediaPipe pose, needs first-load internet to
fetch the model) and **scenarios** (offline simulation). Check-in chips in the
right panel report symptoms during a live session.

## Architecture

```
app.js, index.html, styles.css   thin web adapter: sources -> agent -> DOM/audio
core/                            pure logic, no DOM, no browser APIs, no wall clock
  config.js        every threshold, weight, and timing (single source of truth)
  features.js      canonical feature schema + coverage contract
  risk.js          instant posture risk 0-100, coverage-aware, explainable drivers
  baseline.js      personal baseline: what "normal for you" looks like
  predictor.js     short-horizon forecast: trend fit, time-to-danger, staggering
  policy.js        state machine + escalation (hysteresis, cooldowns, reminders)
  symptoms.js      non-motion symptom domain (decay, boosts, horizon extension)
  staging.js       longitudinal classification into stages 0-3 with evidence
  care.js          stage -> advice strategy table (activity/environment/clinical)
  journal.js       bounded audit trail (observation clock, replay-deterministic)
  agent.js         the loop: ingest() binds everything above together
sources/                         adapters, all emitting canonical observations
  pose.js          MediaPipe landmarks -> features (all measured)
  imu.js           raw accel (g) -> features (lean measured; drop/lateral proxy)
  sim.js           deterministic seeded scenarios + interleaved check-ins
scripts/demo.js                  terminal demo
test/                            unit + end-to-end scenario suite
```

Data flow per frame: `observation -> baseline.update -> assessRisk ->
symptom fusion (effective score) -> forecast -> policy decision -> staging ->
journal -> step (for the UI to render and act on)`.

## Core concepts

**Coverage honesty.** Every feature carries `measured | proxy | unavailable`.
Proxies are discounted in scoring, unavailable features redistribute their weight —
the score never silently degrades when a sensor cannot observe something. The IMU
path, for example, cannot see knee asymmetry; it says so.

**Personal baseline.** Warmup (Welford, ~6 s) learns per-person feature means and
variances; after that the normal drifts on a minutes-scale EWMA. `deviation()`
compares a ~1 s smoothed signal against the personal normal and requires a
*sustained* departure to flag "unusual for you" — a separate early-warning channel
from absolute risk.

**Prediction.** The forecast fits the recent effective-score trend, projects
time-to-danger, and watches lateral-offset burstiness for staggering. It gates on
rise rate, fit confidence, and a score floor so trivial wobble never forecasts.
`horizonScale > 1` (from active symptoms) warns earlier.

**Symptom domain.** Check-ins decay exponentially per symptom (dizziness 10 min,
fatigue 1 h, poor sleep 6 h, ...). While active they raise the effective score
(capped) and extend forecast horizons. The journal records raw score, boost, and
effective score separately, so symptom contributions stay auditable.

**Staging + care.** A rolling evidence window (episodes, time-in-band, gait
variability CV, symptom load) classifies stages 0–3; fresh dizziness floors the
stage (symptomFloors). `carePlan()` maps the stage to advice and flags escalation
for stage 3. `provisional` is time-based (< 40 s of evidence).

## How to extend

**Add a source** (e.g., smartwatch BLE): 1) write `sources/<name>.js` exporting a
function/class that returns `{t, features, coverage}`; 2) add a scenario to
`sources/sim.js` for it if it needs one; 3) wire it in `app.js`. Core untouched.

**Add a feature**: 1) `FEATURE_KEYS` + label in `core/features.js`; 2) weight +
scale in `config.risk`; 3) emit it (with honest coverage) from sources that can;
4) add a driver-aware instruction if it needs one (`core/policy.js`). Agent,
forecast, staging need no changes.

**Add a symptom**: 1) entry in `SYMPTOM_LABELS` + `SYMPTOM_KEYS` + advice text in
`core/symptoms.js`; 2) config numbers (half-life, boost, horizon). 3) chip in
`index.html`. That's it.

**Add a stage or change advice**: edit `STAGE_DEFINITIONS` in `core/care.js`
(content, not logic).

## Config

All defaults live in `core/config.js`. Key knobs: `risk.thresholds` (42/72),
`risk.coverageWeight`, `baseline.warmupFrames` / `ewmaAlpha` / `deviationFloor`,
`forecast.minRiseRate` / `minConfidence` / `scoreFloor` / horizons,
`policy.*` (exit lines, cooldowns, reminder cadence),
`symptoms.*` (half-lives, boosts, horizonScale, building-boost cap),
`staging.*` (weights, thresholds, symptomFloors),
`imu.*` (mapping heuristics — tune against field data in M3).

## Demo scenarios

`stable` (60 s walk) · `wobble` (90 s unsteady) · `wobble-shift` (sudden gait
change) · `dizzy-walk` (moderate walk + dizziness check-in at t=5) ·
`near-fall` (18 s, predicted ~0.8 s before the danger band) · `imu-near-fall`
(16 s, raw accel through the real IMU mapper).

## Safety & privacy

Prototype only — not a validated medical device or emergency service. Risk
thresholds are heuristic and need clinical validation, representative training
data, bias testing, calibration, and regulatory assessment before real-world care
use. Stage advice is generic guidance, not medical advice; stage 3 "escalation"
means *recommend contacting a professional*, nothing automatic.

Privacy: camera frames stay in the browser (MediaPipe is fetched from a CDN on
first use; no frames or journals are transmitted). The journal is in-memory only.
This is a dev server (`python3 -m http.server`) — not a deployment story.

## Milestones

- **M0** ✅ web risk demo (MediaPipe, heuristic score)
- **M1** ✅ agent core: sources, baseline, forecast, policy, symptoms, staging,
  care plans, 10 test suites, terminal demo, rewired UI
- **M2** real device time: phone IMU (DeviceMotion/Capacitor) as a live source,
  latency + battery budget, BLE watch path
- **M3** data + validation: SisFall/MobiFall-class training data for the learned
  risk model, false-alarm/alarm-latency targets, clinical review of thresholds
  and staging
- **M4** wearable target: embedded pre-impact detector (e.g., ESP32 + IMU)
  sharing this config's thresholds; caregiver notification path
