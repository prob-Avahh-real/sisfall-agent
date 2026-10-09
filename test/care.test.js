import test from 'node:test';
import assert from 'node:assert/strict';
import { carePlan, STAGE_DEFINITIONS } from '../core/care.js';

test('every stage has a label, summary, and advice', () => {
  for (const d of STAGE_DEFINITIONS) {
    assert.ok(d.label && d.summary);
    assert.ok(d.advice.length >= 2);
    for (const item of d.advice) assert.ok(item.kind && item.text.length > 10);
  }
});

test('stage 3 escalates; lower stages do not', () => {
  assert.equal(carePlan({ stage: 3, provisional: false }).escalation, true);
  assert.equal(carePlan({ stage: 1 }).escalation, false);
  assert.equal(carePlan({ stage: 0 }).reviewInDays, 7);
});

test('symptom addon is appended with rationale', () => {
  const plan = carePlan({ stage: 1 }, { symptoms: { top: 'dizziness', topLabel: 'Dizziness' } });
  assert.ok(plan.advice.some((a) => (a.rationale ?? '').includes('Dizziness')));
});

test('recent near-fall adds trigger-removal advice below stage 2', () => {
  const plan = carePlan({ stage: 1 }, { episodeCount: 1 });
  assert.ok(plan.advice.some((a) => a.text.includes('near-fall')));
  const higher = carePlan({ stage: 2 }, { episodeCount: 1 });
  assert.ok(!higher.advice.some((a) => a.text.includes('near-fall')));
});

test('plan carries through staging drivers and provisional flag', () => {
  const plan = carePlan({ stage: 2, provisional: true, drivers: ['High gait variability'] });
  assert.equal(plan.provisional, true);
  assert.deepEqual(plan.drivers, ['High gait variability']);
});
