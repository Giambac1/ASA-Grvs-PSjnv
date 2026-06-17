import { parseArgs } from 'node:util';
import { startBdiAgent } from '../src/main-bdi.js';
import { startLlmAgent } from '../src/main-llm.js';

/**
 * Timed experiment run: start one agent with a selected strategy, play
 * for a fixed duration, then write the metrics summary to
 * experiments/results/ and exit.
 *
 *   node scripts/run-experiment.js --strategy reward-distance --duration 180 --label 26c1_3
 *   node scripts/run-experiment.js --agent llm --strategy mission-aware --duration 300 --label 26c2_5
 *
 * Compare strategies by running the same scenario several times per
 * strategy (spawns are random — use >= 5 runs and compare means, like
 * the professor's benchmark harness).
 */
const { values } = parseArgs({
  options: {
    agent: { type: 'string', default: 'bdi' }, // 'bdi' | 'llm'
    strategy: { type: 'string' },
    duration: { type: 'string', default: '180' }, // seconds
    label: { type: 'string', default: 'experiment' },
    host: { type: 'string' },
    name: { type: 'string' },
    token: { type: 'string' },
  },
});

const durationMs = Number(values.duration) * 1000;
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  console.error('--duration must be a positive number of seconds');
  process.exit(1);
}

const overrides = { log: { label: values.label } };
if (values.strategy) overrides.strategy = values.strategy;
if (values.host) overrides.host = values.host;
if (values.name) overrides.name = values.name;
if (values.token) overrides.token = values.token;

const start = values.agent === 'llm' ? startLlmAgent : startBdiAgent;

console.log(`Experiment "${values.label}": agent=${values.agent}, strategy=${values.strategy ?? '(env default)'}, duration=${values.duration}s`);

const runtime = await start(overrides);

setTimeout(() => {
  const summary = runtime.metrics.summary();
  const resultFile = runtime.stop();
  console.log('--- experiment finished ---');
  console.log(`final score:        ${summary.finalScore}`);
  console.log(`parcels delivered:  ${summary.counters.parcelsDelivered}`);
  console.log(`parcels picked up:  ${summary.counters.parcelsPickedUp}`);
  console.log(`intention changes:  ${summary.counters.intentionChanges}`);
  console.log(`failed actions:     ${summary.counters.failedActions}`);
  console.log(`results written to: ${resultFile}`);
  process.exit(0);
}, durationMs);
