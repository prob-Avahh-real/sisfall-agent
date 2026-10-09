#!/usr/bin/env node
// Terminal demo: run a simulated scenario (with any check-ins) through the
// full agent loop and print the timeline, the session summary, and the
// stage-based care plan.
//
//   node scripts/demo.js [stable|wobble|wobble-shift|dizzy-walk|near-fall|imu-near-fall]

import { SisFallAgent } from '../core/agent.js';
import { LearnedRiskModel } from '../core/learned.js';
import { runScenario, interleave, SCENARIOS } from '../sources/sim.js';

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const name = args[0] ?? 'near-fall';
const useModel = process.argv.includes('--model');
if (!SCENARIOS[name]) {
  console.error(`Unknown scenario "${name}". Options: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const { observations, checkins, meta } = runScenario(name);
let model = null;
if (useModel) {
  const artifact = (await import('../models/risk-v1.js')).default;
  model = LearnedRiskModel.fromArtifact(artifact);
  console.log(`model: ${artifact.version} (validation AUC ${artifact.metrics.auc.toFixed(3)}) — rules kept as ruleScore`);
}
const agent = new SisFallAgent({ model });
let lastState = null;
let lastStage = null;

for (const event of interleave(observations, checkins)) {
  if (event.kind === 'checkin') {
    const { t, symptom, severity } = event.checkin;
    const result = agent.ingestCheckin({ t, symptom, severity });
    console.log(`[${t.toFixed(2)}s] check-in: ${result.label} (level ${result.level.toFixed(2)}) -> ${result.advice}`);
    continue;
  }

  const step = agent.ingest(event.observation);
  if (step.state !== lastState) {
    lastState = step.state;
    const scoreNote =
      step.effective.boost > 0
        ? `score=${step.effective.score} (raw ${step.risk.score} + symptoms ${step.effective.boost})`
        : `score=${step.effective.score}`;
    const forecastNote =
      step.forecast.imminent && step.forecast.timeToDangerSec != null
        ? `  (danger predicted in ${step.forecast.timeToDangerSec.toFixed(1)}s)`
        : '';
    console.log(`[${step.t.toFixed(2)}s] state=${step.state}  ${scoreNote}${forecastNote}`);
  }
  if (step.stage.stage !== lastStage) {
    lastStage = step.stage.stage;
    const tag = step.stage.provisional ? 'provisional' : 'established';
    console.log(`[${step.t.toFixed(2)}s] stage=${step.stage.label} (score ${step.stage.score}, ${tag}, ${step.stage.frames} frames)`);
  }
  for (const action of step.actions) {
    console.log(`[${step.t.toFixed(2)}s]   action: ${action.kind} (${action.urgency}) -> ${action.text}  // ${action.reason}`);
  }
}

const summary = agent.summary();
console.log('---');
console.log(`scenario: ${name} (${meta.durationSec}s @ ${meta.hz}Hz) · frames: ${summary.frames} · max score: ${summary.maxScore}`);
const episodes = summary.episodes.map((e) => `${e.start.toFixed(1)}–${e.end.toFixed(1)}s (peak ${e.maxScore})`).join(', ') || 'none';
console.log(`episodes: ${episodes}`);
const actions = Object.entries(summary.actionCounts).map(([kind, count]) => `${kind}×${count}`).join(', ') || 'none';
console.log(`actions: ${actions}`);

const plan = agent.carePlan();
console.log('---');
console.log(`care plan: ${plan.label} — ${plan.headline}${plan.provisional ? ' [provisional]' : ''}`);
if (plan.drivers.length) console.log(`drivers: ${plan.drivers.join(' · ')}`);
if (plan.escalation) console.log('** ESCALATION: recommend contacting clinician / caregiver **');
for (const item of plan.advice) {
  console.log(`  [${item.kind}] ${item.text}`);
}
