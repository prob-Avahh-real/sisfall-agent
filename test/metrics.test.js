import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScenarios } from '../tools/evaluate.js';
import { LearnedRiskModel } from '../core/learned.js';
import { SisFallAgent } from '../core/agent.js';
import { runScenario } from '../sources/sim.js';
import artifact from '../models/risk-v1.js';

test('false-alarm target: stable and wobble stay silent across seeds', () => {
  const { summary } = evaluateScenarios({ seeds: [1, 2, 3, 4, 5, 6], scenarios: ['stable', 'wobble'] });
  assert.equal(summary.stable.audioActions, 0, `stable audio ${summary.stable.audioActions}`);
  assert.equal(summary.stable.acuteRuns, 0, `stable acute ${summary.stable.acuteRuns}`);
  assert.equal(summary.wobble.audioActions, 0, `wobble audio ${summary.wobble.audioActions}`);
  assert.equal(summary.wobble.acuteRuns, 0, `wobble acute ${summary.wobble.acuteRuns}`);
});

test('alarm-latency target: every near-fall alarmed before the danger band, mean lead ≥ 0.4 s', () => {
  const { summary } = evaluateScenarios({ seeds: [1, 2, 3, 4, 5, 6], scenarios: ['near-fall'] });
  const stats = summary['near-fall'];
  assert.equal(stats.dangerRuns, 6);
  assert.equal(stats.missedRuns, 0, 'no missed near-falls');
  assert.equal(stats.alarmedRuns, 6);
  assert.ok(stats.minLeadSec > 0.15, `min lead ${stats.minLeadSec}`);
  assert.ok(stats.meanLeadSec >= 0.4, `mean lead ${stats.meanLeadSec}`);
});

test('learned-model path: near-fall alarmed, stable silent (agent integration)', () => {
  const model = LearnedRiskModel.fromArtifact(artifact);

  const nearAgent = new SisFallAgent({ model });
  let alarmed = false;
  let sawModelOverride = false;
  for (const observation of runScenario('near-fall', { seed: 1 }).observations) {
    const step = nearAgent.ingest(observation);
    if (step.risk.ruleScore != null) sawModelOverride = true;
    if (step.actions.some((action) => action.urgency === 'high')) alarmed = true;
  }
  assert.ok(sawModelOverride, 'learned model overrode the rule score');
  assert.ok(alarmed, 'learned path alarmed on the near-fall');

  const stableAgent = new SisFallAgent({ model });
  let audio = 0;
  for (const observation of runScenario('stable', { seed: 1 }).observations) {
    const step = stableAgent.ingest(observation);
    audio += step.actions.filter((action) => action.kind === 'audio').length;
  }
  assert.equal(audio, 0, 'learned path silent on a stable walk');
});
