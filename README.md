# SisFall — fall-risk posture agent

An agent that watches movement (camera pose or wearable IMU), **predicts dangerous
postures before they become falls**, factors in non-motion symptoms you report
(dizziness, fatigue, poor sleep, ...), classifies the pattern into a **risk stage**,
and produces **stage-matched care advice** — all locally, nothing uploaded.

This is a prototype, not a medical device. See "Safety" below.

> Name note: **SisFall** the project is independent of the public **SisFall
> dataset** (Universidad de Antioquia) it can optionally train on.
> Dataset-facing files — `tools/sisfall.js`, `data/sisfall/`, the `--sisfall`
> flag, model provenance — keep the dataset's name.

## Quick start

```bash
npm test                                   # 96 tests, deterministic scenarios
npm run demo                               # near-fall scenario, full agent timeline
node scripts/demo.js near-fall --model     # learned scorer instead of rules
node scripts/demo.js dizzy-walk            # symptom-fusion scenario
npm start                                  # web UI at http://localhost:4173
npm run train                              # train + export models/risk-v1 (AUC ratchet 0.85)
npm run evaluate                           # false-alarm + alarm-latency summary
npm run review                             # regenerate the clinical review packet
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

Sensor APIs require a **secure context**: `http://localhost` works on desktop
browsers, but to test from a phone you need HTTPS (local cert, or a tunnel) —
plain `http://<lan-ip>` will not deliver motion events on iOS Safari or Android
Chrome.

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

## Learned risk model (M3)

The rule scorer stays the default; a learned logistic-regression window scorer
plugs in behind the same contract via the agent constructor
(`new SisFallAgent({ model })`; see `node scripts/demo.js near-fall --model`).

- `core/learned.js` — ONE window vectorizer shared by training and runtime
  (lean/offset/drop/asymmetry max·mean·rate over ~1 s). Unavailable features
  contribute neutrally (standardized 0 = personal average), proxies are
  discounted, and drivers list the top positive contributions.
- `tools/corpus.js` — deterministic synthetic corpus (walk / near-fall / hard
  fall) through the REAL IMU mapper. Labels start where an envelope is
  feature-visible, not where it starts on paper; fixing that label noise was
  worth +0.19 validation AUC during development.
- `npm run train` — pure-JS logistic regression, run-wise train/validation
  split (no window leakage), AUC/F1 and best-F1 threshold; refuses to emit an
  artifact below the 0.85 AUC ratchet. Writes `models/risk-v1.{js,json}` with
  provenance and limitations baked in.
- Real data: `data/README.md` — SisFall adapter (`tools/sisfall.js`) plus
  `npm run train -- --sisfall data/sisfall`. The committed artifact says
  `trainedOn.source = synthetic-v1` and is pipeline validation, not clinical
  evidence.
- Metrics ratchets (`test/metrics.test.js`): zero audio alarms across 6 seeded
  stable + 6 wobble runs; every near-fall alarmed before the danger band with
  mean lead ≥ 0.4 s (currently 0.76 s, min 0.73 s).

Honesty clause: real-world performance, per-hour false-alarm rates, and
threshold justification require the SisFall-class run — those numbers are
pending, and `npm run review` regenerates the packet that tracks that gap.

## Wearable firmware (M4)

`firmware/sisfall_preimpact/` — an ESP32-C3 + MPU6050 pre-impact band that
runs the SAME pipeline on-device: `config.h` is GENERATED from
`core/config.js`, a pure-C detector mirrors the web feature/score/forecast
logic, escalation drives local haptics, and the BLE accel stream is exactly
what the web "Connect BLE band" mode subscribes to (FFE0/FFE1, 6-byte
int16-LE packets).

Verification boundaries, stated plainly:

- `npm run firmware` regenerates `config.h` + golden vectors from the shared
  sources; `test/firmware.test.js` fails on any drift (per-value and
  byte-identical regeneration).
- `detector.c` is host-compiled with `-Werror` and run in CI where a C compiler
  exists: 66 golden vectors must match `core/risk.js` within 1 point
  (currently exact — worst delta 0), plus walk/tilt/recover behavior checks.
- NOT hardware-verified: I2C timing, BLE pairing, haptics, battery. The manual
  checklist lives in `firmware/sisfall_preimpact/README.md`.
- Caregiver notification is a follow-up: events are logged over Serial; nothing
  is transmitted off-device yet.

## PD scope & boundaries (指南对齐)

This agent is scoped to Parkinson's disease (PD) by design; every feature maps
to the **minimal action set** in `core/pd-profile.js` — the single source of
truth, enforced by `test/pd-scope.test.js`.

Guideline anchors (paraphrased): NICE NG71 — early referral to PD-experienced
physiotherapy and PD-specific physiotherapy for balance/motor problems
(1.7.2/1.7.3), plus the linked falls/vitamin D guidance; MDS physiotherapy EBM
review (Keus et al., 2015) — gait, balance, transfers, cueing for freezing;
AAN — exercise/physiotherapy as low-risk management options; 《中国帕金森病治疗
指南（第四版, 2020）》— 康复与运动治疗是全程管理的组成部分.

- **Patient action minimal set**: walking, turning, sit-to-stand, stance and
  weight transfer. The agent observes and nudges around these four, nothing else.
- **Agent action minimal set**: assess & forecast, cueing prompts, staged
  training guidance, medication *time* reminders, session journal.
- **Boundaries (never crossed)**: no diagnosis (no H&Y/UPDRS scoring), no drug
  names/doses/changes, no emergency substitution (it prompts you to call for
  help; it never auto-calls), no disease-progression claims, and training is
  activity practice — not a treatment plan. All user-facing strings are scanned
  against `FORBIDDEN_TERMS` in CI.
- **Pruned to fit**: symptom check-ins reduced to the four that change immediate
  action safety (起身发晕/疲劳/睡眠不足/药效减退); anxiety, pain and similar
  belong to clinical follow-up. Generic balance exercises were replaced by
  PD-specific ones (LSVT-BIG-style big movements, metronome/rhythmic cueing,
  big-arc turning, freeze-response drill), each carrying an `evidence` field.
- **Added**: medication time reminders (a plain daily clock, set per your
  clinician's schedule) and the freeze-response drill.
- **Orthostatic (postural) symptoms**: covered as the 起身发晕 check-in (the
  highest-weighted symptom) plus graduated stand-up / transfer cues and
  trigger windows (after medication, after meals, in heat). Formal evaluation
  and management (BP measurement, medication changes, compression stockings)
  stay with clinicians — see the boundaries above.

## Environment inference & active inquiry (2026-10)

The web UI has no "obstacle / slippery floor" checkbox anymore. Instead:

- **Sensor-assisted inference**: a *slip/stub micro-event* — the drop proxy
  spiking then recovering quickly, without a sustained lowering — registers as
  a candidate (`core/environment.js`). A candidate, not a verdict: object-level
  recognition is explicitly out of scope.
- **Active inquiry, bounded**: in a settled state the agent asks once ("刚才是否
  遇到地面湿滑或有障碍物？"), at most `maxAsksPerSession` times, with cooldowns
  and a dismiss-silence window; unanswered questions expire.
- **The answer is the ground truth**: "yes" confirms the environment for
  `confirmedHoldSec` (30 min) and shortens warning horizons through the same
  sensitivity channel as symptoms (×0.8; the posture score itself is *never*
  inflated). "No" silences asking for 10 minutes.
- Explicit `context.obstacle` injection still exists for tests / replay / demos,
  but no longer adds to the score (see the calibration note below).

## Rehabilitation training

- Curated balance/strength routines per risk stage (`core/training.js`):
  stages 0-1 get standing exercises, stages 2-3 seated/supported ones.
- **Scheduled reminders**: pick a daily time in the panel (persisted in
  localStorage). While the page is open a reminder fires once per day within a
  10-minute window. System-level reminders (page closed) need the Capacitor
  milestone — prototype boundary, stated rather than faked.
- **Medication time reminders**: up to two daily times — a plain time clock set
  per your clinician's schedule. No drug names, no doses, no adjustments (see
  the PD boundaries above).
- **Music therapy module** (音乐疗愈): Web Audio synthesis — zero audio files,
  works offline. Two modes: 节拍提示 (rhythmic auditory cueing for gait, the
  RAS direction; BPM 80-120, and during training it auto-follows the exercise's
  recommended tempo, e.g. 节拍行走 at 100) and 呼吸引导 (4-4-6 breathing for
  relaxation — an assist, no efficacy claims). Mode copy is covered by the
  pd-scope compliance scan.
- **Voice**: Web Speech API. `SpeechSynthesis` reads cues (zh-CN); recognition
  (Chrome/Edge) matches "开始训练 / 停止训练"-style commands via keyword rules —
  no cloud NLU inside the app, graceful fallback to buttons when unavailable.
  Browser speech recognition may use a cloud service; the toggle is off by
  default and everything works without it.
- **Safety boundary**: during training the agent defers *caution-level* cues
  (journaled as `note` — training wobble is expected), but imminent/danger
  alarms are never dampened. The session summary (completed exercises,
  duration, peak score) lands in the journal.

## 2026-10 calibration (normal reads zero)

User feedback: the calm score hovered around ~10. Root causes fixed:

- `environment.obstacle/lowLight` were constant score add-ons (+18/+10) —
  moved to the sensitivity channel (see above).
- Feature dead zones were too loose (`torsoLean` start 8°; `hipDropSpeed` /
  `kneeAsymmetry` starting at 0) — raised to 12° / 0.5 / 0.15 / 0.05 so normal
  walking and camera-landmark jitter read as exactly zero.
- Linked floors re-tuned: `policy.deviationScoreFloor` 15 → 8; symptom-active
  caution entry `symptoms.cautionThreshold` 30.

Measured after the fix (seed 1, UI-smoothed): stable walk mean 0.0; wobble mean
0.5 (max 3); with σ3.5° injected jitter still mean 0.1; near-fall unchanged
(6/6 alarmed, mean lead 0.70 s).

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
- **M3** 🔄 pipeline delivered: shared window vectorizer, deterministic synthetic
  corpus, pure-JS training with run-wise splits and the AUC ratchet, SisFall
  adapter + acquisition guide, false-alarm/latency ratchets in CI, review
  packet generator. Real-data numbers and the clinical review itself remain
  open (external dependencies, tracked by `npm run review`).
- **M4** 🔄 core delivered: ESP32+MPU6050 pre-impact firmware with generated
  thresholds, a host-tested C detector (exact score parity + behavior checks),
  and a BLE stream compatible with the M2 web adapter. On-hardware bring-up and
  the caregiver notification path remain open.
