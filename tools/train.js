#!/usr/bin/env node
// Training pipeline (M3): pure-JS logistic regression over window vectors from
// core/learned.js. Deterministic: batch gradient descent from zeros, fixed
// sample order, no wall clock or RNG.
//
// The train/validation split is by RUN, not by window — windows from the same
// recording never leak across the split (the classic episode-leakage trap).
//
// CLI:
//   node tools/train.js                      # synthetic corpus (default)
//   node tools/train.js --sisfall data/sisfall   # real SisFall files
// Outputs: models/risk-v1.json + models/risk-v1.js

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSyntheticCorpus } from './corpus.js';
import { parseSisFallFile, sisfallWindows } from './sisfall.js';
import { VECTOR_KEYS } from '../core/learned.js';

export const TRAIN_DEFAULTS = { iterations: 600, learningRate: 0.5, l2: 0.001, trainRatio: 0.7 };

const sigmoid = (x) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function vectorValues(vector) {
  return vector.keys.map((key) => {
    const index = VECTOR_KEYS.indexOf(key);
    return index === -1 ? 0 : vector.values[VECTOR_KEYS.indexOf(key)];
  });
}

function standardize(rows) {
  const dims = VECTOR_KEYS.length;
  const mean = new Array(dims).fill(0);
  const std = new Array(dims).fill(1);
  for (const row of rows) for (let d = 0; d < dims; d += 1) mean[d] += row[d] / rows.length;
  for (const row of rows) for (let d = 0; d < dims; d += 1) std[d] += (row[d] - mean[d]) ** 2 / rows.length;
  for (let d = 0; d < dims; d += 1) std[d] = Math.sqrt(std[d]) || 1;
  return { mean, std };
}

/** Rank-based AUC with tie handling. */
export function auc(pairs) {
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  let rankSum = 0;
  let nPos = 0;
  let nNeg = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j += 1;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      if (sorted[k].y === 1) {
        rankSum += averageRank;
        nPos += 1;
      } else {
        nNeg += 1;
      }
    }
    i = j + 1;
  }
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Best-F1 threshold sweep over candidate probabilities. */
export function bestF1Threshold(pairs) {
  const candidates = [...new Set(pairs.map((pair) => pair.p))].sort((a, b) => a - b);
  let best = { threshold: 0.5, f1: 0, precision: 0, recall: 0 };
  for (const threshold of candidates) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const pair of pairs) {
      const predictedPositive = pair.p >= threshold;
      if (predictedPositive && pair.y === 1) tp += 1;
      else if (predictedPositive && pair.y === 0) fp += 1;
      else if (!predictedPositive && pair.y === 1) fn += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    if (f1 > best.f1) best = { threshold, f1, precision, recall };
  }
  return best;
}

/**
 * @param {object} corpus { samples: [{runId, label, vector}], meta }
 * @returns {{ artifact, metrics }}
 */
export function trainModel(corpus, options = {}) {
  const cfg = { ...TRAIN_DEFAULTS, ...options };
  const runIds = [...new Set(corpus.samples.map((sample) => sample.runId))].sort();
  const trainRuns = new Set(runIds.filter((id) => fnv1a(id) % 100 < cfg.trainRatio * 100));
  const train = corpus.samples.filter((sample) => trainRuns.has(sample.runId));
  const validation = corpus.samples.filter((sample) => !trainRuns.has(sample.runId));
  if (!train.length || !validation.length) {
    throw new Error(`Split produced an empty side (train ${train.length}, val ${validation.length})`);
  }

  const dims = VECTOR_KEYS.length;
  const trainX = train.map((sample) => vectorValues(sample.vector));
  const trainY = train.map((sample) => sample.label);
  const { mean, std } = standardize(trainX);
  const zTrain = trainX.map((row) => row.map((value, d) => (value - mean[d]) / std[d]));

  const weights = new Array(dims).fill(0);
  let bias = 0;
  for (let iter = 0; iter < cfg.iterations; iter += 1) {
    const gradW = new Array(dims).fill(0);
    let gradB = 0;
    for (let i = 0; i < zTrain.length; i += 1) {
      let logit = bias;
      for (let d = 0; d < dims; d += 1) logit += weights[d] * zTrain[i][d];
      const error = sigmoid(logit) - trainY[i];
      for (let d = 0; d < dims; d += 1) gradW[d] += (error * zTrain[i][d]) / zTrain.length;
      gradB += error / zTrain.length;
    }
    for (let d = 0; d < dims; d += 1) weights[d] -= cfg.learningRate * (gradW[d] + 2 * cfg.l2 * weights[d]);
    bias -= cfg.learningRate * gradB;
  }

  const predict = (vector) => {
    const values = vectorValues(vector);
    let logit = bias;
    for (let d = 0; d < dims; d += 1) logit += weights[d] * ((values[d] - mean[d]) / std[d]);
    return sigmoid(logit);
  };

  const validationPairs = validation.map((sample) => ({ p: predict(sample.vector), y: sample.label }));
  const aucScore = auc(validationPairs);
  const best = bestF1Threshold(validationPairs);

  const artifact = {
    version: 'risk-v1',
    trainedOn: corpus.meta ?? { source: 'unknown' },
    createdAtClock: 'training-run (deterministic; see git)',
    seed: options.seed ?? 42,
    vectorKeys: VECTOR_KEYS,
    weights,
    bias,
    mean,
    std,
    threshold: best.threshold,
    metrics: {
      auc: aucScore,
      f1: best.f1,
      precision: best.precision,
      recall: best.recall,
      nTrain: train.length,
      nValidation: validation.length,
      positives: corpus.samples.filter((sample) => sample.label === 1).length,
    },
    limitations:
      'Trained on synthetic pipeline-validation data unless provenance says sisfall. Not clinically validated.',
  };
  return { artifact, metrics: artifact.metrics };
}

/** Build a corpus from a directory of SisFall .txt files. */
export async function corpusFromSisFallDir(dir) {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.txt')).sort();
  if (!entries.length) {
    throw new Error(`No .txt files found in ${dir}. See data/README.md for how to obtain SisFall.`);
  }
  const samples = [];
  for (const name of entries) {
    const text = await readFile(path.join(dir, name), 'utf8');
    const parsed = parseSisFallFile(name, text);
    samples.push(...sisfallWindows(parsed));
  }
  return {
    samples,
    meta: {
      source: 'sisfall',
      dir,
      files: entries.length,
      sampleCount: samples.length,
      positives: samples.filter((sample) => sample.label === 1).length,
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const sisfallIndex = args.indexOf('--sisfall');
  const seedIndex = args.indexOf('--seed');
  const seed = seedIndex !== -1 ? Number(args[seedIndex + 1]) : 42;

  const corpus = sisfallIndex !== -1 ? await corpusFromSisFallDir(args[sisfallIndex + 1]) : buildSyntheticCorpus();
  const { artifact, metrics } = trainModel(corpus, { seed });

  await mkdir('models', { recursive: true });
  await writeFile('models/risk-v1.json', `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(
    'models/risk-v1.js',
    `// Generated by tools/train.js — do not edit by hand.\n// Provenance: ${JSON.stringify(artifact.trainedOn)}\nexport default ${JSON.stringify(artifact)};\n`
  );

  console.log(`trained on: ${corpus.meta.source} (${metrics.nTrain} train / ${metrics.nValidation} val windows, ${metrics.positives} positives)`);
  console.log(`validation AUC: ${metrics.auc.toFixed(3)} · F1 ${metrics.f1.toFixed(3)} (precision ${metrics.precision.toFixed(3)}, recall ${metrics.recall.toFixed(3)}) at threshold ${artifact.threshold.toFixed(3)}`);
  console.log('wrote models/risk-v1.json + models/risk-v1.js');
  if (metrics.auc < 0.85) {
    console.error(`AUC ${metrics.auc.toFixed(3)} below the 0.85 ratchet — investigate before shipping this artifact.`);
    process.exit(1);
  }
}
