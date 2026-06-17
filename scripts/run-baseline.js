import { parseArgs } from 'node:util';
import { startBdiAgent } from '../src/main-bdi.js';
import { startLlmAgent } from '../src/main-llm.js';

/**
 * Baseline campaign runner (Challenge 1, Phase 1 step 2).
 *
 * Runs every strategy several times against the map CURRENTLY loaded on the
 * server, then exits. Each run uses a FRESH in-game identity (unique name,
 * empty token) so scores start at 0 and never bleed across runs/strategies.
 *
 * The map is server-side: start the server on the target map first, e.g.
 *   cd ../Deliveroo.js/backend && GAME_NAME=26c1_1 npm start
 * then run this against it:
 *   node scripts/run-baseline.js --label 26c1_1 --duration 120 --runs 5
 *
 * Restrict the strategy set or shorten runs while iterating:
 *   node scripts/run-baseline.js --label 26c1_1 --strategies reward-distance,delivery-threshold --runs 3
 *
 * Afterwards summarize with:  node scripts/aggregate-results.js --scenario 26c1
 */
const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'baseline' }, // map/scenario name -> result.scenario
    duration: { type: 'string', default: '120' }, // seconds per run
    runs: { type: 'string', default: '5' }, // runs per strategy
    strategies: {
      type: 'string',
      default: 'greedy-nearest,reward-distance,delivery-threshold,mission-aware',
    },
    agent: { type: 'string', default: 'bdi' }, // 'bdi' | 'llm'
    host: { type: 'string' },
  },
});

const durationMs = Number(values.duration) * 1000;
const runs = Number(values.runs);
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  console.error('--duration must be a positive number of seconds');
  process.exit(1);
}
if (!Number.isInteger(runs) || runs <= 0) {
  console.error('--runs must be a positive integer');
  process.exit(1);
}

const strategies = values.strategies.split(',').map((s) => s.trim()).filter(Boolean);
const start = values.agent === 'llm' ? startLlmAgent : startBdiAgent;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(
  `Baseline "${values.label}": agent=${values.agent}, strategies=[${strategies.join(', ')}], ` +
    `runs=${runs}, duration=${values.duration}s each ` +
    `(~${Math.round((strategies.length * runs * (durationMs + 2000)) / 60000)} min total)`,
);

for (const strategy of strategies) {
  for (let i = 1; i <= runs; i += 1) {
    const runName = `bl-${values.label}-${strategy}-r${i}-${Date.now().toString(36)}`;
    const overrides = {
      strategy,
      token: '', // force a fresh identity (no token reuse from .env)
      name: runName,
      log: { label: values.label }, // result.scenario = map; result.strategy = strategy
    };
    if (values.host) overrides.host = values.host;

    console.log(`\n=== ${values.label} | ${strategy} | run ${i}/${runs} (${runName}) ===`);
    let runtime;
    try {
      runtime = await start(overrides);
    } catch (error) {
      console.error(`  run failed to start: ${error?.message ?? error}`);
      continue;
    }

    await sleep(durationMs);
    const summary = runtime.metrics.summary();
    runtime.stop();
    console.log(
      `  finalScore=${summary.finalScore} ` +
        `delivered=${summary.counters.parcelsDelivered} ` +
        `intentionChanges=${summary.counters.intentionChanges} ` +
        `failedActions=${summary.counters.failedActions}`,
    );
    await sleep(1500); // let the disconnect settle before the next identity
  }
}

console.log('\nBaseline campaign complete.');
console.log(`Aggregate with:  node scripts/aggregate-results.js --scenario ${values.label}`);
process.exit(0);
