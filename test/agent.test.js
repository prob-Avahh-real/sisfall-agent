import test from 'node:test';
import assert from 'node:assert/strict';
import { SisFallAgent } from '../core/agent.js';
import { runScenario, interleave } from '../sources/sim.js';

function runScenarioWithAgent(name, agent = new SisFallAgent()) {
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
    .find((a) => a.reason === '与您平时不同');
  assert.ok(deviationEntry, 'deviation nudge fired after the shift');
  assert.ok(deviationEntry.t >= 30, `nudge at ${deviationEntry.t}s after the shift at 30s`);
  assert.ok(!transitions.some((tr) => ['danger', 'imminent'].includes(tr.to)));
});

test('dizziness check-in fuses into risk; identical walk stays silent without it', () => {
  const withSymptoms = runScenarioWithAgent('dizzy-walk');

  // Control: same observations, no check-in.
  const controlAgent = new SisFallAgent();
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
    .filter((a) => (a.reason ?? '').includes('症状背景'));
  assert.ok(symptomActions.length >= 1);
  assert.ok(/发晕/.test(symptomActions[0].text));

  // Check-in journaled; staging applies the dizziness floor.
  assert.equal(withSymptoms.agent.journal.byType('checkin').length, 1);
  const staged = withSymptoms.agent.stage();
  assert.ok(staged.stage >= 1);
  assert.equal(staged.floorApplied, 'dizziness');
});

test('恢复后的滑绊微事件触发环境询问；回答只走灵敏度、不灌分数', () => {
  const { agent, steps } = runScenarioWithAgent('near-fall');
  const question = steps.flatMap((s) => s.actions).find((a) => a.kind === 'question');
  assert.ok(question, '主动询问应在滑绊恢复后出现');
  assert.ok(question.text.includes('湿滑'));

  const before = agent.lastT;
  const result = agent.ingestEnvironmentAnswer({ t: before, yes: true });
  assert.equal(result.active, true);
  const next = agent.ingest({
    t: before + 0.1,
    features: { torsoLean: 3, lateralOffset: 0.1, hipDropSpeed: 0.05, kneeAsymmetry: 0 },
  });
  assert.equal(next.environment.inferred.active, true);
  assert.ok(next.environment.horizonScale <= 0.8 + 1e-9, `horizonScale ${next.environment.horizonScale}`);
  assert.ok(next.effective.score < 10, '姿态平稳时分数不被环境因素灌水');
  assert.ok(agent.journal.byType('environment').length >= 1);
});

test('康复训练：开始/结束入 journal，摘要含训练期分数', () => {
  const agent = new SisFallAgent();
  const { observations } = runScenario('stable', { seed: 1 });
  for (const observation of observations.slice(0, 160)) agent.ingest(observation);
  const started = agent.startTraining(agent.lastT, { source: 'test' });
  assert.equal(started.ok, true);
  assert.ok(started.plan.length >= 1);
  agent.ingest(observations[160]);
  const summary = agent.finishTraining(agent.lastT, { completed: false });
  assert.equal(summary.completed, false);
  assert.equal(summary.source, 'test');
  assert.ok(Number.isFinite(summary.meanScore));
  const trainingRecords = agent.journal.byType('training');
  assert.ok(trainingRecords.some((record) => record.action === 'start'));
  assert.ok(trainingRecords.some((record) => record.action === 'stopped'));
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
