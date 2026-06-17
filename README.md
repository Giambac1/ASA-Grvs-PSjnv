# ASA-Grvs-PSjnv

Autonomous Software Agents exam project for the Deliveroo.js environment.

Authors:

- Matteo Gervasi, Student ID 265428
- Teona Pop Stojanova, Student ID 265750

This repository contains:

- Agent A: a BDI agent for Challenge 1.
- Agent B: an LLM-assisted agent for Challenge 2.
- Shared BDI infrastructure, strategies, planning, metrics, communication, and PDDL integration.
- Curated experimental evidence. The final report PDF can be added before submission if required by the course instructions.

## Requirements

- Node.js >= 22
- npm
- A running Deliveroo.js server for local or online runs
- Optional VPN access for the course LLM gateway and mission-agent tests

Install dependencies:

```bash
npm install
```

On Windows PowerShell:

```powershell
npm.cmd install
```

Create a local environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` for the target server and agent identity.

Important variables:

| Variable | Meaning |
|---|---|
| `HOST` | Deliveroo.js server URL, local or course server |
| `TOKEN` | JWT identity token; leave empty for a fresh identity |
| `NAME` | Agent name used when no token is provided |
| `TEAMMATE_NAME` | Expected teammate name for coordination |
| `STRATEGY` | Strategy id, for example `greedy-nearest` or `mission-aware` |
| `PDDL_ENABLED` | Enables PDDL movement planning |
| `PDDL_DELIVERY_ENABLED` | Enables full PDDL pickup-and-delivery planning |
| `LITELLM_BASE_URL` / `LITELLM_API_KEY` | LLM endpoint configuration |

## Quick Check

Run the offline smoke test:

```bash
npm test
```

On Windows PowerShell:

```powershell
npm.cmd test
```

The smoke test does not require a Deliveroo.js server. It checks graph construction, pathfinding, belief revision, strategy selection, mission parsing, PDDL problem generation, PDDL delivery guards, coordination utilities, handover logic, and logging robustness.

## Running the Agents

Agent A, BDI:

```bash
node scripts/run-bdi.js --strategy greedy-nearest --label challenge1
```

Agent B, LLM-assisted:

```bash
node scripts/run-llm.js --name agentB --strategy mission-aware --label challenge2
```

Timed single-agent run:

```bash
node scripts/run-experiment.js --strategy greedy-nearest --duration 120 --label test-run
```

The map is selected by the Deliveroo.js server, not by the agent. For a local server, start the course backend separately.

Example on Windows PowerShell:

```powershell
cd ..\Deliveroo.js\backend
$env:GAME_NAME='26c1_3'
npm.cmd start
```

Then, in this repository:

```powershell
node scripts/run-experiment.js --strategy greedy-nearest --duration 120 --label 26c1_3
```

## Strategies

The strategy can be selected with `STRATEGY=<id>` in `.env` or with `--strategy <id>`.

| Strategy | Description |
|---|---|
| `greedy-nearest` | Selects the nearest reachable parcel and delivers when no useful pickup remains |
| `reward-distance` | Scores parcels by projected delivered value minus travel and decay cost |
| `reward-distance-total` | Scores pickups by considering the projected value of the whole carried load |
| `delivery-threshold` | Batches parcels until a count or value threshold before delivery |
| `mission-aware` | Extends reward-distance with Challenge 2 mission constraints |

In the Challenge 1 baseline campaign, `greedy-nearest` was the strongest practical strategy: it won outright on six maps and was effectively tied within noise on the remaining two.

## Project Structure

```text
src/
  communication/   Team protocol and message handling
  core/            Beliefs, options, intentions, plans, agent loop
  llm/             Mission interpretation and LLM tooling
  metrics/         Runtime counters, logs, aggregation
  planning/        Grid graph, BFS path planning, PDDL integration
  strategies/      Swappable strategy implementations
  utils/           Shared utility functions

scripts/
  run-bdi.js              Start Agent A
  run-llm.js              Start Agent B
  run-experiment.js       Timed single-agent run
  run-baseline.js         Repeated strategy benchmark on the loaded map
  run-campaign.js         Multi-map campaign runner
  aggregate-results.js    Aggregate experiment JSONs
  run-c2-suite.js         Challenge 2 scenario harness
  summarize-c2-suite.js   Summarize Challenge 2 runs
  smoke-test.js           Offline smoke test suite

experiments/
  RESULTS-baseline-v1.md  Curated Challenge 1 baseline results
  RESULTS-c2-v5.md        Curated Challenge 2 validation results
  README.md               Experiment methodology notes
```

## Architecture

The two agents share the same runtime architecture:

```text
Server events
  -> BeliefBase
  -> OptionGenerator
  -> Strategy
  -> IntentionRevision
  -> PlanLibrary
  -> ActionExecutor
```

Agent B adds an LLM mission interpretation layer and team communication on top of the same infrastructure. The LLM does not directly control movement; it converts natural-language requests into structured mission state. Low-level movement remains deterministic and is handled by BFS or, when enabled and appropriate, PDDL.

## PDDL Integration

PDDL is integrated as an optional planning component.

Implemented capabilities:

- generation of PDDL movement problems from current beliefs;
- online solver invocation through the PDDL client;
- parsing and execution of returned plans;
- fallback to BFS when PDDL is disabled, unsuitable, too slow, or fails;
- optional full pickup-and-delivery PDDL planning;
- mission-safe delivery guards, so PDDL delivery defers to the BDI mission plans under active mission constraints.

PDDL is disabled by default for most runtime paths because online solver latency can reduce throughput. The report discusses this trade-off and includes evidence from controlled and supplementary runs.

## Coordination

The agents use a structured `asa-team-v1` message protocol.

Implemented coordination features:

- teammate discovery;
- position heartbeat;
- parcel claims;
- mission updates;
- handover messages and acknowledgements.

The handover mission `26c2_8` was validated end-to-end: Agent A picks up and deposits the parcel at a shared rendezvous tile, while Agent B collects and delivers it.

The go-to-and-wait mission `26c2_10` was validated with a local fixture because the course repository does not include an official mission agent for that scenario.

## Experiments

The repository includes curated experimental summaries rather than raw full logs.

Main evidence:

- `experiments/RESULTS-baseline-v1.md`
  - Challenge 1 baseline campaign.
  - 8 maps.
  - 4 strategies.
  - 5 runs per map-strategy pair.
  - 120 seconds per run.
  - 160 runs total.
- `experiments/RESULTS-c2-v5.md`
  - Challenge 2 validation.
  - 8/8 tested scenarios passed.
  - 7 interpreted through the LLM path.
  - Red/green-light handled by deterministic fallback for latency-critical safety.

Raw logs and generated result JSONs are ignored by default. New runs will write to:

```text
experiments/logs/
experiments/results/
```

## Running Challenge 2 Tests

The Challenge 2 harness requires the course mission-agent repository and admin token.

Expected external layout:

```text
../Deliveroo.js/
../DeliverooAgent.js/
```

The mission-agent `.env` should contain:

```text
HOST=http://localhost:8080
ADMIN_TOKEN=<god-token>
```

Example:

```bash
node scripts/run-c2-suite.js --campaign c2-smoke-v1 --dry-run
node scripts/run-c2-suite.js --campaign c2-smoke-v1 --scenarios 26c2_3,26c2_1,26c2_2,26c2_5,26c2_7
node scripts/summarize-c2-suite.js --campaign c2-smoke-v1
```

Team scenarios require two agents and are run separately.

## Limitations

- PDDL uses an online solver, so frequent calls can be too slow for reactive play.
- PDDL is therefore gated and optional at runtime.
- LLM interpretation is used for high-level mission understanding, not for low-level movement.
- Safety-critical mission constraints are handled deterministically before waiting for the LLM.
- Raw experiment logs are not committed; curated summaries are provided instead.
- Advanced opponent modelling and automatic strategy tuning are future work.

## Notes

- `.env` is local and should not be committed.
- Use `.env.example` as the configuration template.
- `Deliveroo.js/` and `DeliverooAgent.js/` are external course repositories and are not included here.
- Run `npm test` before evaluating or modifying runtime behavior.
