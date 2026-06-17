# Notebooks

Optional analysis notebooks only — **never required for runtime behavior**
(blueprint constraint).

Intended use: load `experiments/results/*.json` and `experiments/logs/*.jsonl`,
produce the score-over-time plots, strategy comparison tables, and
PDDL-vs-BFS planner summaries (`pddl_plan`, `pddl_delivery_plan`,
`pddl_failure`) for the report (section 07_experiments).

Example data already exists: the `live-smoke*` validation runs in
`experiments/results/` and `experiments/logs/` (see
`experiments/README.md` for what they show), so the first notebook can
be built and tested right away.

The grouping/aggregation step is already implemented and tested in
`src/metrics/aggregate.js` (used by `scripts/aggregate-results.js`), which
can emit a CSV with `--csv path` — load that directly instead of
re-implementing the stats:

```bash
node scripts/aggregate-results.js --scenario 26c1 --csv experiments/results/baseline_c1.csv
```

Suggested first notebook (`analysis.ipynb`):

1. Load every result JSON into a dataframe (strategy, scenario, finalScore, counters),
   or read the CSV produced by `aggregate-results.js --csv`.
2. Group by (scenario, strategy), aggregate mean/std of final score over ≥5 runs
   (matches `aggregateResults`).
3. Plot score timelines per strategy on the same scenario (from each result's `scoreTimeline`).
4. Export the comparison table for `report/sections/07_experiments.tex`.
