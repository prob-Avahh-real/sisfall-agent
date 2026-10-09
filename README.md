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

The web UI has four input modes: **camera** (MediaPipe pose, needs first-load
internet to fetch the model), **scenarios** (offline simulation), **phone motion**
(DeviceMotion — front pocket or chest-mounted) and **BLE band** (Web Bluetooth to
an open-GATT IMU band). Check-in chips in the right panel report symptoms during
a live session. Device modes show effective sample rate and p95 processing
latency live against the budget in `config.device` (`maxIngestP95Ms: 5`).

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
  devicemotion.js  phone DeviceMotion events -> mapper (iOS permission helpers)
  web-bluetooth.js BLE GATT notifications -> mapper (packet parser, fake-able)
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

## Device sources (M2)

**Phone motion (`sources/devicemotion.js`)** — wraps `DeviceMotionEvent`
(`accelerationIncludingGravity`, m/s² → g) through the real IMU mapper. iOS 13+
requires a user-gesture permission request; the UI handles it on button press.
Devices that provide only gravity-free `acceleration` are reported as
unsupported rather than silently mis-scored. The mapper self-calibrates its
upright reference from the first quiet seconds.

**BLE band (`sources/web-bluetooth.js`)** — subscribes to GATT notifications.
Default packet: 6 bytes, 3 × int16 little-endian accelerometer, g = raw / 4096
(matches common FFE0/FFE1 UART modules). Default UUIDs are that module family —
override `config.device.ble.*` with your band's real UUIDs (find them with
nRF Connect). Browser support: Chrome/Edge (desktop + Android); Safari/iOS do
not implement Web Bluetooth. Vendor watches (watchOS/WearOS) need companion
apps — out of scope for this adapter.

**Budgets.** `config.device`: `targetHz 50` design rate, `renderThrottleMs 66`
(DOM refresh cap — alarm actions are never throttled), `maxIngestP95Ms 5`
(one-time UI warning when exceeded). The live badge shows `Hz · p95 ms` while a
device source runs. The phone browser page must stay in the foreground —
background operation needs the Capacitor/native path or the M4 wearable. Per
sample the cost is one listener callback with O(1) processing; no extra timers
beyond the render throttle; no network.

### Manual device test checklist (not CI-coverable)

1. iPhone/Android: open the UI, press **Use phone motion sensor**, grant motion
   permission. Badge should settle around 50–60 Hz with p95 well under 5 ms.
2. Hold the phone upright ~2 s (mapper warms), then tilt forward steadily:
   "Body alignment" rises; a strong tilt escalates the agent state.
3. Walk 60 s with the phone in a front pocket: baseline warmup completes (~6 s),
   no alarms during a normal walk.
4. Shake the phone briefly mid-walk: instability signals appear, then clear.
5. Chrome (desktop or Android): with a compatible FFE0/FFE1 module powered on,
   press **Connect BLE band** → chooser → connect → notifications stream (badge
   shows `BLE · Hz`). Use the module's real UUIDs in config if they differ.

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
- **M2** 🔄 core delivered: phone IMU (DeviceMotion) + BLE band adapters with
  latency/battery instrumentation and unit tests; on-device behavior pending the
  manual checklist above; native/background path (Capacitor) and vendor-watch
  companion apps remain open
- **M3** data + validation: SisFall/MobiFall-class training data for the learned
  risk model, false-alarm/alarm-latency targets, clinical review of thresholds
  and staging
- **M4** wearable target: embedded pre-impact detector (e.g., ESP32 + IMU)
  sharing this config's thresholds; caregiver notification path
