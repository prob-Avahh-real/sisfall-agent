# AGENTS.md — sisfall-agent

Project-scoped rules for assistants working on SisFall. Root `AGENTS.md`
applies on top; this file records purpose, targets, and invariants specific here.

## Purpose

Fall-prevention agent: predicts dangerous postures from movement data (camera
pose / IMU), fuses non-motion symptom check-ins, stages risk longitudinally, and
emits stage-matched care advice. Prototype, not a medical device.
Naming: the project name (SisFall) is independent of the external SisFall
dataset; dataset-facing paths (`tools/sisfall.js`, `data/sisfall/`, the
`--sisfall` flag) keep the dataset's name — do not rename those.

## Targets (用途决定 Target, root rule 5)

- **Debug surface**: browser app (`npm start`, port 4173). Development harness.
- **M2 target**: phone (IMU via DeviceMotion or Capacitor) — the realistic
  wearable form factor for this use case. Status: DeviceMotion + Web Bluetooth
  band adapters delivered and unit-tested; on-device behavior is verified only
  via the README manual checklist (CI cannot cover radios).
- **M4 target**: embedded wearable (ESP32+MPU6050 pre-impact band). Status:
  firmware scaffold delivered with a GENERATED config (`npm run firmware`) and
  a host-tested pure-C detector; on-hardware verification is manual-only
  (firmware README checklist).
- No cloud service target: journals and video stay local by design.

## Commands

```bash
npm test          # must stay green; deterministic scenarios only
npm run demo      # node scripts/demo.js [scenario] [--model]
npm start         # dev server
npm run train     # retrain + re-export models/risk-v1 (AUC ratchet 0.85)
npm run evaluate  # false-alarm + alarm-latency summary
npm run review    # regenerate reports/review-packet.md
npm run firmware  # regenerate firmware config.h + golden vectors
node --test --experimental-test-coverage   # coverage snapshot
```

## Invariants (do not break)

1. **core/ is pure**: no DOM, browser APIs, wall clock, or network. Journal
   timestamps use the observation clock (`t`) so replays are deterministic.
   Browser sources (`devicemotion`, `web-bluetooth`) may touch browser APIs only
   behind injectable seams (constructor-injected `now`, `bluetooth`, target
   objects) and must stay unit-testable in plain Node — see the fake-event and
   fake-GATT tests.
2. **All numbers live in `core/config.js`** — no magic thresholds in logic
   files. New tuning knobs go to config with a comment. Firmware `config.h` is
   GENERATED from it (`npm run firmware`) — never hand-edit generated firmware
   files; the drift tests fail if they diverge.
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
8. **Model artifacts carry provenance**: `npm run train` splits by run (never
   by window), refuses AUC < 0.85, and writes provenance + limitations into
   `models/risk-v1.{js,json}`. Never hand-edit artifacts; never quote model
   metrics without the `trainedOn.source` context (`synthetic-v1` is pipeline
   validation, not clinical evidence).

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
- Device radio paths (motion permission, BLE pairing, real sample rates) are
  hardware/OS dependent and not CI-coverable; keep the README manual device
  checklist in sync when touching those sources.
- The committed model is trained on the synthetic pipeline-validation corpus;
  real-data numbers await a SisFall run (`data/README.md`). The review packet
  carries the same caveat — keep it that way until real numbers exist.
- Model-based scoring is wired behind the risk contract ({ model } ctor
  option); any future model upgrade must keep neutral-z coverage handling and
  driver explainability (invariant 8).
