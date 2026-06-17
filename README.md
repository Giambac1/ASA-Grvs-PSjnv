# asa-deliveroo-agent

Autonomous agents for the [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js)
game — exam project for the Autonomous Software Agents course (UniTn).

**Goal:** a clean, extensible infrastructure where game strategies can be
added, selected, tested and compared easily, built around the professor's
lab BDI architecture (beliefs → options/desires → intentions → plans →
intention revision), with an LLM layer for high-level mission
interpretation and a meaningful (optional-at-runtime) PDDL integration.

## How the structure maps to the exam requirements

| Exam requirement | Where |
|---|---|
| Agent A: BDI agent (Challenge 1) | `src/main-bdi.js` + `src/core/` |
| Sense / revise beliefs | `src/core/BeliefBase.js` (decay projection, negative evidence, timestamps) |
| Revise intentions | `src/core/IntentionRevision.js` (replace policy + hysteresis) |
| Game strategy, swappable | `src/strategies/` (4 strategies + registry) |
| Agent B: LLM agent (Challenge 2) | `src/main-llm.js` + `src/llm/` |
| Atomic requests / strategy adaptation | `src/llm/MissionInterpreter.js` (LLM or deterministic fallback) |
| A ↔ B coordination | `src/communication/` (structured `asa-team-v1` protocol) |
| Meaningful PDDL | `src/planning/PddlPlanner.js` + `pddlDomain.js` (PDDL plan serves the `go_to` intention, BFS fallback) |
| Deterministic movement | `src/planning/GridGraph.js` (digraph, arrow tiles) + `PathPlanner.js` (BFS) |
| Experiments / evidence | `src/metrics/`, `scripts/run-experiment.js`, `experiments/` |
| 10-page LaTeX report | `report/` (skeleton with per-section content plans) |

A study guide (in Italian) covering the whole architecture, the current
state and the evolution roadmap lives in `report/DocumentoStudio1.tex`
(+ compiled PDF) — start there to understand and extend the codebase.

## Architecture in one diagram

```
            socket events (map, config, you, sensing, msg)
                              │
                       ┌──────▼──────┐
                       │ BeliefBase  │  map graph, me, parcels, agents,
                       └──────┬──────┘  config, mission, teammate, claims
                              │
        OptionGenerator (what is possible)
                              │
        Strategy (what is preferable — swappable)        ← LLM adapts this
                              │                            via mission state
        IntentionRevision (commit / revise, hysteresis)
                              │
        PlanLibrary (how): GoPickUp, DeliverCarried, GoToMissionTarget,
                           Explore, Wait, PddlGoTo → FollowPathGoTo (BFS)
                              │
        ActionExecutor (serialized move/pickup/putdown, red-light gate)
```

The LLM (Agent B) never moves the agent. It interprets mission messages
into structured missions, applies them to beliefs (goals, forbidden
tiles, delivery policies, movement gate) and forwards them to Agent A.

## Setup

Requires Node ≥ 22 and a running Deliveroo.js server (local or course).

```bash
cd asa-deliveroo-agent
npm install
cp .env.example .env      # then edit
```

On Windows PowerShell, use `npm.cmd` and `Copy-Item`:

```powershell
cd asa-deliveroo-agent
npm.cmd install
Copy-Item .env.example .env   # then edit
```

Environment variables (see `.env.example` for the full commented list):

- `HOST` — server URL; `NAME` — agent name on first connection;
- `TOKEN` — JWT identity. Leave empty the first time: the server issues a
  token, which the agent prints and logs — save it in `.env` so restarts
  re-attach to the same in-game agent;
- `STRATEGY` — strategy id (see below); `RUN_LABEL` — scenario label for logs;
- `TEAMMATE_NAME` — the other agent's name (team handshake filter);
- `PDDL_ENABLED`, `PDDL_DELIVERY_ENABLED`, `PDDL_MAX_TILES`,
  `PDDL_TIMEOUT_MS`, `PDDL_MIN_PATH_LENGTH`,
  `PDDL_AVOID_WHILE_CARRYING`, `PAAS_HOST`, `PAAS_PATH` — PDDL toggles,
  safety bounds and solver;
- `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LLM_MODEL` — LLM provider
  (optional; without it Agent B uses deterministic mission parsing).

## Running

```bash
# Offline smoke test — no server, no network, no installed SDK needed
npm test

# Agent A (BDI)
node scripts/run-bdi.js --strategy reward-distance --label 26c1_3

# Agent B (LLM) — typically in a second terminal with a different NAME/TOKEN
node scripts/run-llm.js --name agentB --strategy mission-aware

# Timed experiment that writes a result summary and exits
node scripts/run-experiment.js --strategy greedy-nearest --duration 180 --label 26c1_1
```

The map is selected **server-side** when starting Deliveroo.js; the agent
just connects. In `Deliveroo.js/backend`:

```bash
GAME_NAME=26c1_3 npm start                       # macOS / Linux (bash)
```
```powershell
$env:GAME_NAME='26c1_3'; npm.cmd start           # Windows PowerShell
```

To benchmark a whole map — every strategy, several fresh-identity runs
each — and summarize the results into a comparison table (these run the
same on every OS):

```bash
node scripts/run-baseline.js --label 26c1_3 --duration 120 --runs 5
node scripts/aggregate-results.js --scenario 26c1   # markdown table (+ --csv path)
```

To run the whole multi-map campaign unattended (it starts/stops the
server itself for each map, one failing map does not abort the rest, and
it prints a succeeded/failed summary at the end), stop any manual server
first, then:

```bash
node scripts/run-campaign.js --campaign baseline-v1 --maps 26c1_2,26c1_3,26c1_4,26c1_5,26c1_6,26c1_7,26c1_8 --duration 120 --runs 5
```

Challenge 2 end-to-end smoke tests can also be orchestrated from one
terminal. The runner starts/stops the Deliveroo.js server, Agent B and
the matching mission agent for each supported scenario, then writes a
compact manifest and per-process logs under `experiments/c2-suite/`.
Before running it, put the mission-agent admin token in
`../DeliverooAgent.js/.env` (`HOST=http://localhost:8080` and
`ADMIN_TOKEN=<god-token>`), keep the VPN connected for the LLM gateway,
and stop any manual server:

```bash
node scripts/run-c2-suite.js --campaign c2-smoke-v1 --dry-run
node scripts/run-c2-suite.js --campaign c2-smoke-v1 --scenarios 26c2_3,26c2_1,26c2_2,26c2_5,26c2_7
node scripts/summarize-c2-suite.js --campaign c2-smoke-v1
```

The first suite covers single-agent Agent B behavior. Team scenarios
(`26c2_8`, `26c2_10`) are intentionally left out until the two-agent
coordination run is tested separately.

For a two-agent team run, start A and B from the same `.env` but give each
the **other's** name via `--teammate` (a shared `.env` cannot hold both
teammate names). Keep `TOKEN` empty so each gets a fresh identity:

```bash
# terminal 1: Agent A (picker)
node scripts/run-bdi.js --name agentA --teammate agentB --strategy mission-aware --label 26c2_8-A
# terminal 2: Agent B (deliverer)
node scripts/run-llm.js --name agentB --teammate agentA --strategy mission-aware --label 26c2_8-B
```

They discover each other via a `hello` shout (logged as
`teammate_discovered`) and then exchange position heartbeats, claims and
mission updates. Roles for the `one_pickup_another_deliver` handover
(26c2_8) are explicit: **agentA picks up, agentB delivers**.

The go-to-and-wait mission (26c2_10) has no mission agent in the course
repo, so a local god-observer fixture reproduces its documented rule
(reward when both agents stay within the radius together). Run it after
the two agents, with `ADMIN_TOKEN` in `.env`:

```bash
# server: node index.js -g ../DeliverooAgent.js/missionAgents/challenge2/26c2_10.json
# then the two agents (as above), then:
node scripts/fixtures/goto-wait-mission.js   # local TEST HARNESS, not an official mission agent
```

## Selecting a strategy

`STRATEGY=<id>` in `.env` or `--strategy <id>` on any script:

| id | Idea |
|---|---|
| `greedy-nearest` | Chase the nearest parcel; deliver when nothing is reachable. Baseline. |
| `reward-distance` | Maximize projected *delivered* value: reward − decay × distance, per carried parcel. |
| `reward-distance-total` | Like reward-distance, but scores a pickup by the *whole load's* delivered value (pickup = reward-distance pickup + carried value), so pickup and deliver are on the same scale and it hoards instead of small-batching. Post-hoc variant evaluated against the baseline. |
| `delivery-threshold` | Like reward-distance, but batch pickups until N parcels / value threshold, then deliver. |
| `mission-aware` | reward-distance + obeys mission state (bonus goals, delivery policies). Agent B default. |

Retrospective benchmark (no runtime default was changed after the fact):
in the Challenge 1 evaluation (8 maps × 4 strategies × 5 runs)
`greedy-nearest` emerges as the strongest baseline — it wins or ties on all
maps because it hoards and delivers in big batches (~7.6 parcels/delivery)
while the value-aware strategies small-batch (~2), maximizing throughput on
these parcel-rich maps. Run it with `--strategy greedy-nearest`. Details and
the falsified "batching-wins" hypothesis are in
`experiments/RESULTS-baseline-v1.md`.

## Adding a new strategy

1. Create `src/strategies/MyStrategy.js`:

```js
import { StrategyBase } from './StrategyBase.js';

export class MyStrategy extends StrategyBase {
  static id = 'my-strategy';
  utility(option, beliefs, helpers) {
    if (option.type === 'go_pick_up') {
      return /* your score */;
    }
    return super.utility(option, beliefs, helpers);
  }
}
```

2. Register it in `src/strategies/index.js` (import + add to the list).
3. Run with `--strategy my-strategy`. Nothing else changes — generation,
   intention revision, planning and execution are infrastructure.

Override `selectOption(options, beliefs, helpers)` instead of `utility`
for non-utility-based logic. `helpers` gives exact path distances
(`distanceTo`, `deliveryDistanceFrom`) and the decay-per-move cost.

## Logs and experiments

Every run writes a JSON-lines log to `experiments/logs/` (events: scores,
pickups, deliveries, intention changes, plan failures, planner calls, LLM
interpretations, protocol messages) and — when stopped via
`run-experiment.js` — a summary JSON to `experiments/results/`. See
`experiments/README.md` for the comparison methodology. Notebooks in
`notebooks/` are for offline analysis only.

## What is implemented now

- Full BDI skeleton: belief revision (decay projection, negative
  evidence), option generation, utility-based strategies, intention
  revision with hysteresis, plan library with fallback, serialized
  action execution with failed-move handling and soft-blocking.
- Belief reconciliation against server quirks: ack id normalization
  (`normalizeIdList`) plus fallbacks (`markTilePickedUp`,
  `clearCarried`) when acks carry no usable ids or contradict the carry
  belief — added after live testing exposed a phantom-carry loop.
- Close-safe shutdown logging: the run logger swallows the async
  write-after-end stream error and is idempotent, and a stopped intention
  reports cancellation (not a plan failure) — so tearing an agent down
  mid-plan (e.g. between baseline runs) never crashes the process.
- Offline smoke test (`npm test`, no server/network needed) covering
  the graph, pathfinding, belief revision, strategies, mission parsing,
  PDDL problem generation and ack normalization.
- **Validated live** (2026-06-11, local server, `empty_10` map, 60 s):
  `reward-distance` scored 800 with 30 parcels delivered (raw run
  outputs are git-ignored; see `experiments/README.md` for the numbers).
- Deterministic pathfinding on the directed map graph (arrow tiles
  supported from day one; delivery distances via reversed multi-source BFS).
- Four working example strategies and a strategy registry.
- Mission interpretation: LLM path (schema-validated JSON) and a
  deterministic fallback covering the Challenge 2 mission catalog,
  including JSON coordinate lists, instant red/green-light handling,
  arithmetic Q&A and value-threshold wording such as `lower or equal to`
  / `Threshold is`.
- Mission execution guards: Agent B waits briefly before `deliver_at`
  putdown so the mission observer can see the target delivery, and
  `deliver_exactly_n` suppresses premature deliveries until the required
  batch size is carried, including a final pre-putdown guard for missions
  that arrive while a delivery intention is already in progress.
  Forbidden-tile updates invalidate stale paths before the next move, and
  `deliver_less_value_than` only puts down a selected parcel subset when
  its projected total value is under the mission cap.
- Latency-critical safety: prohibitions (forbidden `go_to`/`deliver_at`)
  and red/green light are pre-applied deterministically the instant the
  message arrives, before the LLM round-trip, then reconciled by the
  authoritative LLM result. Closes a live-observed window where a slow
  interpretation (8.7 s) let the agent cross a forbidden tile.
- Team protocol: discovery (logged `teammate_discovered`), position
  heartbeat, claims, mission updates, acks; validated tool registry for
  LLM tool-loop experiments.
- Handover (26c2_8, level 3 in progress): explicit roles (Agent A picks
  up, Agent B delivers), a map-derived deterministic rendezvous both
  agents agree on without negotiating, and a coordinate-first handover
  belief (the drop is located by coordinates; the parcel id is only a
  hint). Picker side is **implemented and validated live**: once carrying,
  Agent A brings the parcel to the rendezvous, drops it on that
  non-delivery tile, steps off to free it, and signals the drop to the
  teammate (logged `handover_deposit`) — **only after it has actually
  vacated the tile** (else `handover-exit-blocked`, no signal, so the
  deliverer is never sent to a tile the picker still blocks). It never
  re-grabs its own drop. The deliverer (Agent B) fetches the drop by
  coordinates (`handover_collect`) and delivers it via the normal delivery
  path, so a different agent does the final delivery. **Validated live
  end-to-end on 26c2_8**: the god mission agent awarded the
  "picked up by one agent, delivered by another" bonus repeatedly across
  successive handover cycles.
- Go-to-and-wait (26c2_10, level 3): both agents go to the neighbourhood
  of the target (radius from "within distance N"; the centre may be a
  wall), each to a distinct reachable tile, then wait for the teammate via
  position heartbeats and hold together. **Validated live end-to-end** with
  a local god-observer fixture (`scripts/fixtures/goto-wait-mission.js`,
  since the course repo has no mission agent for this scenario): both
  reached distinct tiles within distance 3 of (19,5) and the fixture
  awarded the 500 pt bonus.
- PDDL: domain + problem generation from beliefs, online solver wrapper,
  registered as an alternative `go_to` plan when `PDDL_ENABLED=true`.
  The domain also models single-parcel `pickup`/`putdown`, and
  `PddlPlanner.buildDeliveryProblem(...)` can emit full collect-and-deliver
  problems for BFS-vs-PDDL experiments. When both `PDDL_ENABLED=true` and
  `PDDL_DELIVERY_ENABLED=true`, the plan library tries this full PDDL
  pickup-and-deliver plan before the normal BDI pickup plan, with fallback
  on failure. This delivery plan is mission-safe: it defers to the dedicated
  BDI mission plans whenever a delivery/positional mission constraint is
  active, and its putdown reuses the same compliant-subset selection as
  `DeliverCarried`, so it never drops a non-compliant batch — it is off by
  default for performance, not correctness. PDDL calls are bounded by `PDDL_MAX_TILES` and
  `PDDL_TIMEOUT_MS`, and `PddlGoTo` is gated by
  `PDDL_MIN_PATH_LENGTH` / `PDDL_AVOID_WHILE_CARRYING`, so short paths
  and urgent delivery paths go straight to BFS.
- Challenge 2 suite tooling: `scripts/run-c2-suite.js` orchestrates
  supported single-agent Agent B scenarios end to end, and
  `scripts/summarize-c2-suite.js` prints a compact copyable evidence block.
- Metrics, structured run logs, experiment runner, report skeleton.
- Baseline harness: `scripts/run-baseline.js` (every strategy × N
  fresh-identity runs against the loaded map) and
  `scripts/aggregate-results.js` (group results by scenario × strategy,
  mean/std/min/max score and delivered, markdown table + optional CSV).
- Unattended multi-map campaign runner `scripts/run-campaign.js`: starts
  and stops the Deliveroo.js server per map, runs the baseline on each,
  is resilient per map (one failing map does not abort the rest) and
  prints a succeeded/failed summary, then aggregates.

## What remains for future phases

1. **Tuning & validation on Challenge 1** — run all 8 maps, tune
   `deliverBias`, thresholds, hysteresis; add opponent-aware utilities
   (drop contested parcels when an opponent is closer).
2. **PDDL depth** — run and measure full collect-and-deliver PDDL
   task plans against BDI+BFS on live maps; keep it disabled by default
   unless latency is acceptable. Tune `PDDL_TIMEOUT_MS` per scenario when
   collecting PDDL evidence, and tune `PDDL_MIN_PATH_LENGTH` to trade
   PDDL evidence against live reactivity.
3. **LLM tool loop** — optionally let the LLM drive the `tools.js`
   registry for open-ended requests (lab8 07-pattern).
4. **Experiments + report** — ≥5 runs per (map, strategy), notebook
   analysis, fill the report sections.

Challenge 2 is feature-complete: levels 1–2 (single agent) and level 3
team coordination — both 26c2_8 (handover) and 26c2_10 (go-to-and-wait) —
are implemented and validated live end-to-end.

## Known assumptions

Source-grounded where possible (see `context/game_knowledge/`), to be
verified at runtime on the challenge server:

- **Capacity is not enforced** for player agents (only the intelligent
  NPC obeys it); `pickup` grabs all parcels on the tile. Challenge
  configs with `capacity: 1` are treated as advisory.
- **Own carried parcels** may or may not appear in `sensing.parcels`
  (open question 12) — pickup/putdown acks are therefore treated as the
  authoritative carry signal (`markCarried`/`markDelivered`).
- **Ack shapes vary across server versions** (verified live, including on
  the course server `deliveroojs.bears.disi.unitn.it` on 2026-06-14, where
  pickup acks also carried **no** ids): acks may contain `{id}` objects,
  plain strings, or no usable id. All ack ids go through `normalizeIdList`,
  with belief reconciliation fallbacks (`markTilePickedUp`, `clearCarried`)
  when no ids are usable or the server contradicts the carry belief — the
  fallback was confirmed necessary on the course server too.
- **Static map, partial dynamic sensing — no crate/pushable-obstacle
  modeling.** The map graph is built once from `onMap` (walls,
  delivery/spawner tiles and one-way arrows are global knowledge); parcels
  and other agents come from *partial* sensing with memory and reward
  decay. The agent does **not** model crates or movable obstacles, so maps
  with crate mechanics are out of scope. A 2026-06-14 course-server
  compatibility check confirmed connection, token issuance, map load and
  logging all work, but the live map was `crates_one_way` (9×9): the agent
  found most tiles unreachable (`unreachable`/`no-explore-target`
  dominating) and scored 0 — a **compatibility limit, not a strategy
  benchmark** (not comparable to the 26c1 baselines).
- **Mission text formats** in the deterministic fallback parser follow
  the Challenge 2 config descriptions; coordinate *ranges* like
  "(13,15)–(16,15)" are parsed as the listed endpoints only (the LLM
  path handles ranges better).
- **Red/green light state messages** are assumed to contain "red light"
  or "green light" (matching the mission agent's shouts); they are parsed
  without the LLM because gating is latency-critical.
- **Safety-critical pre-apply is conservative and not undone**: the
  deterministic pre-parse only marks a prohibition when negative keywords
  (`do not`, `never`, `avoid`, `penalized`, …) or a negative bonus are
  present, and there is no `unblock`, so a regex false-positive would keep
  a few tiles blocked until the next mission. This is intentional — for
  the known templates the regex and LLM agree, and over-blocking a few
  tiles is far cheaper than a penalty.
- **Handover roles** are derived from the runtime role: the BDI agent
  (Agent A) is the picker, the LLM agent (Agent B) is the deliverer. This
  assumes the standard A=BDI / B=LLM setup; running two agents of the same
  kind would need an explicit role override.
- **Go-to-and-wait** (26c2_10) waits for the teammate via position
  heartbeats up to `teammateWaitMs`, then both hold `holdTogetherMs`; the
  target centre may be a wall, so each agent goes to the nearest reachable
  tile within the radius (preferring not the teammate's tile). Tested with
  a local god-observer fixture (no official mission agent exists for it).
- The `tile` event (map edits mid-game) triggers a full graph rebuild —
  acceptable because it is rare and maps are small.

## Repository rules

- **Documentation follows code (mandatory):** every change to code
  behavior must update, in the same change, the affected parts of this
  README (implemented/remaining/assumptions), `scripts/smoke-test.js`,
  `experiments/README.md`, `notebooks/README.md`, and the content-plan
  comments in `report/sections/*.tex`. The full checklist lives in
  `CLAUDE.md`. A change is not complete until `npm test` passes and the
  checklist has been walked.
- `Deliveroo.js/` and `DeliverooAgent.js/` (course repos) are read-only
  references and are not part of this package.
- Comments and documentation in English; ES modules everywhere;
  strategy logic stays out of infrastructure files.
