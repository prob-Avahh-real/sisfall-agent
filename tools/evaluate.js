// Metrics harness (M3): false-alarm counts and alarm latency across seeded
// scenario runs, measured through the FULL agent loop. The targets derived
// from this harness are enforced in test/metrics.test.js; the CLI prints the
// same numbers for humans. Deterministic: seeded scenarios, no wall clock.

import { SisFallAgent } from '../core/agent.js';
import { runScenario, interleave } from '../sources/sim.js';

/** One scenario run through the agent; collects alarm + latency facts. */
export function evaluateRun(name, seed, { model = null, config } = {}) {
  const agent = new SisFallAgent({ config, model });
  const { observations, checkins } = runScenario(name, { seed });
  const result = {
    name,
    seed,
    audioActions: 0,
    highActions: 0,
    cautionActions: 0,
    acuteEntered: false,
    firstWarningT: null,
    firstAcuteT: null,
    rawDangerT: null,
    alarmed: null,
    leadSec: null,
    missed: false,
  };

  for (const event of interleave(observations, checkins)) {
    if (event.kind === 'checkin') {
      agent.ingestCheckin(event.checkin);
      continue;
    }
    const step = agent.ingest(event.observation);
    if (step.state === 'imminent' || step.state === 'danger') {
      result.acuteEntered = true;
      if (result.firstAcuteT == null) result.firstAcuteT = step.t;
    }
    for (const action of step.actions) {
      if (action.kind === 'audio') result.audioActions += 1;
      if (action.urgency === 'high' && result.firstWarningT == null) result.firstWarningT = step.t;
      if (action.urgency === 'medium') result.cautionActions += 1;
    }
    if (step.risk.score >= 72 && result.rawDangerT == null) result.rawDangerT = step.t;
  }

  if (result.rawDangerT != null) {
    result.alarmed = result.firstWarningT != null && result.firstWarningT <= result.rawDangerT;
    result.leadSec = result.alarmed ? result.rawDangerT - result.firstWarningT : null;
    result.missed = !result.alarmed;
  }
  return result;
}

/** Grid over scenarios × seeds; returns per-run facts + per-scenario summary. */
export function evaluateScenarios({
  seeds = [1, 2, 3, 4, 5, 6],
  scenarios = ['stable', 'wobble', 'near-fall'],
  model = null,
  config,
} = {}) {
  const runs = [];
  for (const name of scenarios) {
    for (const seed of seeds) runs.push(evaluateRun(name, seed, { model, config }));
  }

  const summary = {};
  for (const name of scenarios) {
    const scenarioRuns = runs.filter((run) => run.name === name);
    const alarmable = scenarioRuns.filter((run) => run.rawDangerT != null);
    const alarmed = alarmable.filter((run) => run.alarmed);
    const leads = alarmed.map((run) => run.leadSec);
    summary[name] = {
      runs: scenarioRuns.length,
      audioActions: scenarioRuns.reduce((sum, run) => sum + run.audioActions, 0),
      highActions: scenarioRuns.reduce((sum, run) => sum + run.highActions, 0),
      cautionActions: scenarioRuns.reduce((sum, run) => sum + run.cautionActions, 0),
      acuteRuns: scenarioRuns.filter((run) => run.acuteEntered).length,
      dangerRuns: alarmable.length,
      alarmedRuns: alarmed.length,
      missedRuns: alarmable.filter((run) => run.missed).length,
      meanLeadSec: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null,
      minLeadSec: leads.length ? Math.min(...leads) : null,
    };
  }
  return { runs, summary };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { summary } = evaluateScenarios();
  for (const [name, stats] of Object.entries(summary)) {
    const lead = stats.meanLeadSec == null ? '–' : `${stats.meanLeadSec.toFixed(2)} s (min ${stats.minLeadSec.toFixed(2)} s)`;
    console.log(
      `${name.padEnd(10)} runs=${stats.runs}  audio=${stats.audioActions}  acute=${stats.acuteRuns}  danger-runs=${stats.dangerRuns}  alarmed=${stats.alarmedRuns}  missed=${stats.missedRuns}  mean-lead=${lead}`
    );
  }
}
