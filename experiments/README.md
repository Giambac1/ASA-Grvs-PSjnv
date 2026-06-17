# Experiments

Run outputs live here:

- `c2-suite/` - Challenge 2 orchestration artifacts. Each campaign gets a
  `run-summary.json` manifest plus per-scenario process logs for the server,
  Agent B wrapper and mission agent. The Agent B JSONL log itself still lives
  in `logs/` and is linked from the manifest when available.

- `logs/` — one JSON-lines file per agent per run (`<label>-<role>-<timestamp>.jsonl`).
  Every line is `{t, event, ...payload}`. Events include: `strategy_selected`,
  `score`, `pickup`, `delivery` (both with `count` and normalized `ids` —
  `ids` may be empty on server versions whose acks carry no id field),
  `intention_started/done/failed/aborted`, `plan_failed`, `pddl_plan`,
  `pddl_delivery_plan`, `pddl_failure`, `mission_interpreted`,
  `mission_preapplied`, `mission_applied`, `mission_target_reached`,
  `msg_in`, `msg_out`, and team/handover events: `teammate_discovered`,
  `handover_msg`, `handover_deposit`, `handover_collect`.
- `results/` — one JSON summary per run (final score, counters, score timeline),
  written when the agent stops (`scripts/run-experiment.js` does this automatically).

Note: raw run outputs are **git-ignored** (only the `.gitkeep`
placeholders are committed) — logs and results live only on the machine
that produced them. Keep the numbers you need for the report in the
report sources or in these READMEs.

The `live-smoke*` files (present locally if you ran the validation; not
committed) are real validation runs (2026-06-11, local server,
`empty_10`, 60 s each). They double as a before/after example of the
belief-reconciliation fix: `live-smoke` (score 173, 336 futile putdown
retries caused by phantom carry beliefs) vs `live-smoke2` (score 800,
30 deliveries, zero futile retries) — useful material for the report's
belief-revision discussion.

## Running an experiment

The map is chosen **server-side** at start time via `GAME_NAME`; the agent
just connects. So a Challenge 1 baseline is: start the server on a map, run
the agent(s) against it, repeat per map.

```bash
# 1. start the server on the target map (in the Deliveroo.js repo)
#    macOS / Linux (bash):
cd ../Deliveroo.js/backend && GAME_NAME=26c1_3 npm start
#    Windows PowerShell:
#    cd ../Deliveroo.js/backend ; $env:GAME_NAME='26c1_3'; npm.cmd start

# 2a. single timed run (same on every OS)
node scripts/run-experiment.js --strategy reward-distance --duration 180 --label 26c1_3

# 2b. full baseline for the loaded map: every strategy x N fresh-identity runs
node scripts/run-baseline.js --label 26c1_3 --duration 120 --runs 5
```

The `--label` should be the scenario name so results group naturally.
`run-baseline.js` gives each run a unique name and empty token, so scores
start at 0 and never bleed across runs or strategies.

To sweep several maps unattended, `scripts/run-campaign.js` starts/stops
the server itself for each map and runs the baseline on each (labels are
`<map>-<campaign>`). It is resilient per map — a failing map is recorded
and skipped, the rest continue — and prints a succeeded/failed summary,
then aggregates by `--scenario <campaign>`. Stop any manual server first:

```bash
node scripts/run-campaign.js --campaign baseline-v1 \
  --maps 26c1_2,26c1_3,26c1_4,26c1_5,26c1_6,26c1_7,26c1_8 --duration 120 --runs 5
```

For Agent B / Challenge 2 single-agent validation, use the suite runner
instead of pasting long terminal scrollback. It starts the server on the
scenario file (`26c2_X.json`), waits for Agent B's mission interpreter,
starts the matching mission agent, records reward/penalty evidence and
continues scenario by scenario:

```bash
node scripts/run-c2-suite.js --campaign c2-smoke-v1 --dry-run
node scripts/run-c2-suite.js --campaign c2-smoke-v1 --scenarios 26c2_3,26c2_1,26c2_2,26c2_5,26c2_7
node scripts/summarize-c2-suite.js --campaign c2-smoke-v1
```

Prerequisites: VPN connected for the LiteLLM gateway, no manual server
already running on the target port, and `../DeliverooAgent.js/.env`
containing `HOST=http://localhost:8080` plus `ADMIN_TOKEN=<god-token>` so
the mission agents can observe the whole map. The current runner covers
the supported single-agent scenarios (`26c2_1`, `26c2_2`, `26c2_3`,
`26c2_4`, `26c2_5`, `26c2_6`, `26c2_7`, `26c2_9`); team scenarios remain
manual until the two-agent coordination flow is validated.
Reward/penalty evidence is matched only against actual mission-agent
acknowledgement lines (`Rewarded ...`, `Penalized ...`), not prompt text.

## Comparing strategies

Parcel spawns are random: run **at least 5 sessions per (scenario, strategy)
pair** and compare means (this mirrors the professor's
`benchmarkAgent/multiple_run.js` pattern). Summarize all results into a
comparison table (and optional CSV for the notebooks/report):

```bash
node scripts/aggregate-results.js --scenario 26c1                 # markdown table
node scripts/aggregate-results.js --scenario 26c1 --csv experiments/results/baseline_c1.csv
```

Useful comparison metrics, all present in the result summaries:

- final score and score timeline;
- delivered / picked-up parcel counts;
- pickups lost (target disappeared before arrival);
- failed moves and failed actions (penalty proxies);
- intention changes (commitment stability vs. thrashing);
- planner calls and failures (PDDL on/off comparison);
- coordination message counts (team runs).

Analysis (tables, plots) belongs in `notebooks/` or offline scripts — never
in the agent runtime.
