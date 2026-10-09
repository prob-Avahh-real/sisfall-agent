import test from 'node:test';
import assert from 'node:assert/strict';
import { SteadyStepAgent } from '../core/agent.js';
import { runScenario, interleave } from '../sources/sim.js';

function runScenarioWithAgent(name, agent = new SteadyStepAgent()) {
  const { observations, checkins } = runScenario(name);
  const steps = [];
  const transitions = [];
  let prev = null;
  for (const event of interleave(observations, checkins)) {
    if (event.kind === 'checkin') {
      agent.ingestCheckin(event.checkin);
      continue;
    }
    const step = agent.ingest(event.observation);
    if (step.state !== prev) {
      transitions.push({ t: step.t, from: prev, to: step.state, raw: step.risk.score, effective: step.effective.score });
    }
    prev = step.state;
    steps.push(step);
  }
  return { agent, steps, transitions };
}

test('near-fall: predicted before the posture is dangerous (raw score < 72 at entry)', () => {
  const { steps, transitions } = runScenarioWithAgent('near-fall');
  const dangerCross = steps.find((s) => s.risk.score >= 72);
  assert.ok(dangerCross, 'raw score crosses the danger band');

  const imminentEntry = transitions.find((tr) => tr.to === 'imminent');
  assert.ok(imminentEntry, 'imminent state entered');
  assert.ok(imminentEntry.effective < 72, `effective ${imminentEntry.effective} < 72 at imminent entry`);
  assert.ok(
    imminentEntry.t < dangerCross.t - 0.3,
    `prediction lead: imminent at ${imminentEntry.t}s vs danger at ${dangerCross.t}s`
  );
});

test('near-fall: one acute episode, then recovery back to stable', () => {
  const { agent, transitions } = runScenarioWithAgent('near-fall');
  const summary = agent.summary();
  assert.equal(summary.episodes.length, 1);
  assert.ok(summary.episodes[0].maxScore >= 72);
  assert.ok(transitions.some((tr) => tr.to === 'recovering'));
  assert.equal(transitions[transitions.length - 1].to, 'stable');
  const actions = agent.journal.byType('action');
  assert.ok(actions.some((a) => a.kind === 'audio' && a.urgency === 'high'));
});

test('stable walk: silent over 60 seconds and staged steady', () => {
  const { agent, transitions } = runScenarioWithAgent('stable');
  assert.ok(!transitions.some((tr) => ['caution', 'danger', 'imminent'].includes(tr.to)));
  const summary = agent.summary();
  assert.equal(summary.actionCounts.audio ?? 0, 0);
  assert.equal(agent.stage().stage, 0);
  assert.equal(agent.stage().provisional, false);
});

test('unsteady walk: guarded stage, no false alarms above caution', () => {
  const { agent, transitions } = runScenarioWithAgent('wobble');
  assert.ok(!transitions.some((tr) => ['danger', 'imminent'].includes(tr.to)));
  assert.equal(agent.summary().actionCounts.audio ?? 0, 0);
  assert.equal(agent.stage().stage, 1);
});

test('sudden gait change: caught as unusual-for-you without acute escalation', () => {
  const { agent, transitions } = runScenarioWithAgent('wobble-shift');
  const deviationEntry = agent.journal
    .byType('action')
    .find((a) => a.reason === 'Unusual for you');
  assert.ok(deviationEntry, 'deviation nudge fired after the shift');
  assert.ok(deviationEntry.t >= 30, `nudge at ${deviationEntry.t}s after the shift at 30s`);
  assert.ok(!transitions.some((tr) => ['danger', 'imminent'].includes(tr.to)));
});

test('dizziness check-in fuses into risk; identical walk stays silent without it', () => {
  const withSymptoms = runScenarioWithAgent('dizzy-walk');

  // Control: same observations, no check-in.
  const controlAgent = new SteadyStepAgent();
  const controlTransitions = [];
  let prev = null;
  for (const observation of runScenario('dizzy-walk').observations) {
    const step = controlAgent.ingest(observation);
    if (step.state !== prev) controlTransitions.push({ t: step.t, to: step.state, raw: step.risk.score });
    prev = step.state;
  }
  assert.ok(
    !controlTransitions.some((tr) => ['caution', 'danger', 'imminent'].includes(tr.to)),
    `control stayed silent: ${JSON.stringify(controlTransitions)}`
  );

  // Fused: caution entered while the RAW posture score was below the caution band.
  const fusedCaution = withSymptoms.transitions.find((tr) => tr.to === 'caution');
  assert.ok(fusedCaution, 'caution fired with the symptom boost');
  assert.ok(fusedCaution.raw < 42, `raw ${fusedCaution.raw} < 42 at fused entry`);
  assert.ok(!withSymptoms.transitions.some((tr) => ['danger', 'imminent'].includes(tr.to)));

  const symptomActions = withSymptoms.agent.journal
    .byType('action')
    .filter((a) => (a.reason ?? '').includes('Symptom context'));
  assert.ok(symptomActions.length >= 1);
  assert.ok(/dizziness/i.test(symptomActions[0].text));

  // Check-in journaled; staging applies the dizziness floor.
  assert.equal(withSymptoms.agent.journal.byType('checkin').length, 1);
  const staged = withSymptoms.agent.stage();
  assert.ok(staged.stage >= 1);
  assert.equal(staged.floorApplied, 'dizziness');
});

test('IMU near-fall reaches at least caution via the real mapper, coverage honest', () => {
  const { agent, steps } = runScenarioWithAgent('imu-near-fall');
  assert.ok(steps.some((s) => ['caution', 'danger', 'imminent'].includes(s.state)), 'escalated');
  for (const s of steps) assert.ok(Number.isFinite(s.risk.score));
  const last = steps[steps.length - 1];
  assert.equal(last.coverage.kneeAsymmetry, 'unavailable');
  assert.ok(agent.stage().stage >= 1);
});

test('journal records calibration, staging, episodes, and actions with reasons', () => {
  const { agent } = runScenarioWithAgent('near-fall');
  const journal = agent.journal;
  assert.ok(journal.byType('calibration').length >= 1);
  assert.ok(journal.byType('stage').length >= 1);
  assert.equal(journal.byType('episode').length, 1);
  const actions = journal.byType('action');
  assert.ok(actions.length >= 2);
  for (const a of actions) assert.ok(typeof a.text === 'string' && a.text.length > 0);
});

test('carePlan matches the staged classification and always has advice', () => {
  const { agent } = runScenarioWithAgent('near-fall');
  const plan = agent.carePlan();
  assert.equal(plan.stage, agent.stage().stage);
  assert.ok(plan.advice.length >= 2);
  assert.ok(plan.reviewInDays >= 1);
});
