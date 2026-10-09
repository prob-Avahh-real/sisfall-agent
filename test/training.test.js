import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSyntheticCorpus, syntheticRawRun, windowsFromRun } from '../tools/corpus.js';
import { trainModel } from '../tools/train.js';
import { LearnedRiskModel } from '../core/learned.js';

const corpus = buildSyntheticCorpus({ seeds: [1, 2, 3, 4, 5, 6, 7, 8] });

test('corpus is deterministic and contains both classes', () => {
  const again = buildSyntheticCorpus({ seeds: [1, 2, 3] });
  const same = buildSyntheticCorpus({ seeds: [1, 2, 3] });
  assert.equal(again.samples.length, same.samples.length);
  assert.deepEqual(again.samples[0].vector.values, same.samples[0].vector.values);
  assert.ok(corpus.samples.some((sample) => sample.label === 1));
  assert.ok(corpus.samples.some((sample) => sample.label === 0));
  assert.equal(corpus.meta.source, 'synthetic-v1');
});

test('training reaches the AUC/F1 ratchets on the run-wise holdout', () => {
  const { artifact, metrics } = trainModel(corpus);
  assert.ok(metrics.auc >= 0.85, `AUC ${metrics.auc}`);
  assert.ok(metrics.f1 >= 0.75, `F1 ${metrics.f1}`);
  assert.equal(artifact.weights.length, 7);
  assert.ok(artifact.weights.every(Number.isFinite));
  assert.ok(artifact.metrics.nValidation > 0);
});

test('trained model separates unseen dangerous runs from unseen quiet walks', () => {
  const { artifact } = trainModel(corpus);
  const model = LearnedRiskModel.fromArtifact(artifact);
  const fallWindows = windowsFromRun(syntheticRawRun('fall', { seed: 21 }));
  const walkWindows = windowsFromRun(syntheticRawRun('walk', { seed: 22 }));
  const maxDanger = Math.max(...fallWindows.filter((w) => w.label === 1).map((w) => model.score(w.vector).score));
  const maxQuiet = Math.max(...walkWindows.map((w) => model.score(w.vector).score));
  assert.ok(maxDanger >= 70, `danger max ${maxDanger}`);
  assert.ok(maxQuiet <= 50, `quiet max ${maxQuiet}`);
  assert.ok(maxDanger > maxQuiet);
});
