# Real datasets (M3)

The training pipeline ships with a deterministic synthetic corpus
(`tools/corpus.js`) for pipeline validation. **Real-world performance must be
measured on real data** — that is what this directory is for. No dataset files
are committed to this repo.

## SisFall (recommended, integrated)

Public fall-detection dataset from the Universidad de Antioquia (Sucerquia,
López & Vargas-Bonilla). Request access per the dataset's own terms — it is not
a click-through download; follow the instructions in the dataset paper or the
authors' page.

Once you have the extracted `.txt` files:

```bash
mkdir -p data/sisfall
# place files like SA01-F01-05_1.txt into data/sisfall/
npm run train -- --sisfall data/sisfall
```

Format assumptions live in `tools/sisfall.js` (semicolon-separated
`ax;ay;az;gx;gy;gz`, 200 Hz, ADXL345 ±16 g → g = raw/256). If your copy differs,
adjust the parser constants there — the fixture test will tell you.

Label convention used by our pipeline: fall files (`F*`) contribute positive
windows around the detected impact (0.8 s before → 1.0 s after); daily-activity
files (`D*`) are negatives. This is a coarse pre-impact labeling — refine it
(behavioral annotations, per-trial impact annotations) before drawing
conclusions.

## Alternatives

- **MobiFall** (Technical University of Crete) — smartphone accelerometer/gyro,
  fall + ADL annotations. Needs its own parser (~same shape as `tools/sisfall.js`).
- **UMAFall** — wearable + smartphone channels; useful for multi-sensor fusion
  experiments later.

## What we would report after real-data training

1. Validation AUC / F1 with run-wise splits (already computed by `npm run train`).
2. False alarms per hour from the long ADL recordings (`tools/evaluate.js`
   logic applies once ADL runs are converted to observation streams).
3. Alarm latency distribution vs. the 42/72 rule bands on the same data — the
   comparison that justifies (or corrects) the heuristic thresholds.

Until those numbers exist, the model artifact's metadata says
`trainedOn.source = synthetic-v1` and the review packet carries the same caveat.
