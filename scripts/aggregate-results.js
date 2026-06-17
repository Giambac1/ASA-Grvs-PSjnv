import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { aggregateResults } from '../src/metrics/aggregate.js';

/**
 * Summarize experiment result JSONs into a strategy-comparison table.
 *
 *   node scripts/aggregate-results.js                       # all results
 *   node scripts/aggregate-results.js --scenario 26c1       # only maps matching "26c1"
 *   node scripts/aggregate-results.js --scenario 26c1 --csv results/baseline.csv
 *
 * Prints a markdown table (drop straight into report/sections/07_experiments.tex
 * or a notebook) and optionally writes a CSV for plotting.
 */
const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'experiments/results' },
    scenario: { type: 'string' }, // substring filter on result.scenario
    csv: { type: 'string' }, // optional output CSV path
  },
});

const files = readdirSync(values.dir).filter((f) => f.endsWith('.json'));
const records = [];
for (const f of files) {
  try {
    const r = JSON.parse(readFileSync(join(values.dir, f), 'utf-8'));
    if (values.scenario && !String(r.scenario ?? '').includes(values.scenario)) continue;
    records.push(r);
  } catch {
    /* skip unreadable/partial files */
  }
}

const rows = aggregateResults(records);
if (rows.length === 0) {
  console.log(`No matching result files in ${values.dir}` + (values.scenario ? ` (scenario ~ "${values.scenario}")` : ''));
  process.exit(0);
}

const f1 = (x) => x.toFixed(1);
console.log(`\nAggregated ${records.length} run(s) into ${rows.length} (scenario, strategy) group(s):\n`);
console.log('| Scenario | Strategy | Runs | Score mean | Score std | Min | Max | Delivered mean |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(
    `| ${r.scenario} | ${r.strategy} | ${r.n} | ${f1(r.scoreMean)} | ${f1(r.scoreStd)} | ` +
      `${r.scoreMin} | ${r.scoreMax} | ${f1(r.deliveredMean)} |`,
  );
}

if (values.csv) {
  const header = 'scenario,strategy,runs,score_mean,score_std,score_min,score_max,delivered_mean,intention_changes_mean\n';
  const body = rows
    .map((r) => [r.scenario, r.strategy, r.n, r.scoreMean, r.scoreStd, r.scoreMin, r.scoreMax, r.deliveredMean, r.intentionChangesMean].join(','))
    .join('\n');
  writeFileSync(values.csv, header + body + '\n');
  console.log(`\nCSV written to: ${values.csv}`);
}
