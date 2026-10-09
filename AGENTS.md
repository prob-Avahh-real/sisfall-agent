# AGENTS.md — steadystep-agent

Project-scoped rules for assistants working on SteadyStep. Root `AGENTS.md`
applies on top; this file records purpose, targets, and invariants specific here.

## Purpose

Fall-prevention agent: predicts dangerous postures from movement data (camera
pose / IMU), fuses non-motion symptom check-ins, stages risk longitudinally, and
emits stage-matched care advice. Prototype, not a medical device.

## Targets (用途决定 Target, root rule 5)

- **Debug surface**: browser app (`npm start`, port 4173). Development harness.
- **M2 target**: phone (IMU via DeviceMotion or Capacitor) — the realistic
  wearable form factor for this use case.
- **M4 target**: embedded wearable (ESP32+IMU pre-impact detector sharing
  `config.js` thresholds). `na/optional` until M2 lands.
- No cloud service target: journals and video stay local by design.

## Commands

```bash
npm test          # must stay green; deterministic scenarios only
npm run demo      # node scripts/demo.js [scenario]
npm start         # dev server
node --test --experimental-test-coverage   # coverage snapshot
```

## Invariants (do not break)

1. **core/ is pure**: no DOM, browser APIs, wall clock, or network. Journal
   timestamps use the observation clock (`t`) so replays are deterministic.
2. **All numbers live in `core/config.js`** — no magic thresholds in logic
   files. New tuning knobs go to config with a comment.
3. **Coverage honesty**: sources declare `measured | proxy | unavailable` per
   feature. Never fake a feature; never score unavailable features silently.
4. **Explainability**: every action carries `reason`; every staging result
   carries `drivers` + `evidence`; symptom contribution stays auditable
   (raw score vs boost vs effective score).
5. **Edge-triggered actions**: policy transitions fire once; persistence
   re-issues on `reminderIntervalSec`. Audio respects `audioCooldownSec`.
6. **Tests gate behavior**: scenario E2E tests in `test/agent.test.js` encode
   the product promises — prediction lead before the danger band, silence on
   stable walks, symptom-fusion control runs, staging floors. If a change
   breaks one, stop and fix or explicitly renegotiate the promise (comment in
   the test), don't loosen silently.
7. **Scene changes are strategy-table changes**: new symptom = config + label +
   chip; new stage = `care.js` content; new source = `sources/` adapter.
   The agent loop does not grow special cases.

## Where to change what

- thresholds/weights/timings -> `core/config.js`
- risk formula / coverage math -> `core/risk.js`
- state machine / escalation -> `core/policy.js`
- prediction gates -> `core/predictor.js`
- symptom model -> `core/symptoms.js`
- staging evidence/weights -> `core/staging.js` (config) / `staging.js`
- advice content -> `core/care.js`
- new data source -> `sources/<name>.js` + scenario in `sources/sim.js`
- UI only renders `step` objects from the agent; no logic in `app.js`

## Known limitations / next ratchets

- IMU mapping gains (`config.imu`) are heuristics; add a field-data calibration
  test when M3 data exists.
- `baseline.deviation()` mutates hold counters (documented); call it once per
  frame as the agent does.
- UI has no automated tests (logic lives in tested core; keep it that way).
- Learned risk model (M3) must plug in behind `predictor`/`risk` interfaces
  with the same coverage + explainability contracts.
