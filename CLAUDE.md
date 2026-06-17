# CLAUDE.md — project rules for asa-deliveroo-agent

Exam project for the Autonomous Software Agents course (UniTn): BDI +
LLM agents for Deliveroo.js. See README.md for architecture and usage.

## MANDATORY RULE: documentation follows code

**Every change to code behavior MUST update the related documentation in
the same change.** Never leave docs describing behavior that no longer
exists. Concretely, when modifying code, check and update each of:

1. `README.md` — especially "What is implemented now", "What remains
   for future phases", and "Known assumptions" (add/remove assumptions
   as they are confirmed or refuted by testing).
2. `scripts/smoke-test.js` — add or adjust assertions covering the new
   behavior; `npm test` must pass offline (no server, no network).
3. `experiments/README.md` — if log events, metrics counters, or result
   file formats changed.
4. `notebooks/README.md` — if result/log formats changed in ways that
   affect analysis.
5. `report/sections/*.tex` — update the content-plan comments of the
   affected section so the final report writing reflects reality
   (architecture → 02, BDI/beliefs/strategies → 03, LLM → 04,
   PDDL → 05, protocol → 06, experiment data → 07).
6. JSDoc comments in the touched files — they are part of the docs.

A code change is not complete until this checklist has been walked.

## Other conventions

- Comments and documentation in English. ES modules only.
- Infrastructure vs strategy separation: strategies decide, never execute.
- Low-level movement stays deterministic; the LLM stays high-level.
- No magic constants: tunables live in `src/config.js` or strategy
  constructor options.
- Do not modify the course repos `../Deliveroo.js/` and
  `../DeliverooAgent.js/` (read-only references).
- Never trust a single server ack shape: server versions differ from the
  SDK types (verified live). Normalize via `normalizeIdList` and
  reconcile beliefs on contradiction.

## Quick commands

```bash
npm test                                   # offline smoke test (no server/network)
node scripts/run-bdi.js --strategy <id>    # Agent A against HOST
node scripts/run-llm.js --name agentB      # Agent B (LLM layer on top)
node scripts/run-experiment.js --strategy <id> --duration 60 --label <scenario>
node scripts/run-baseline.js --label 26c1_1 --duration 120 --runs 5   # all strategies vs loaded map
node scripts/aggregate-results.js --scenario 26c1                     # comparison table (+ --csv)
node scripts/run-campaign.js --campaign baseline-v1 --maps 26c1_2,26c1_3 --duration 120 --runs 5  # unattended multi-map sweep (starts/stops server per map, per-map resilient)
node scripts/run-c2-suite.js --campaign c2-smoke-v1 --dry-run          # Challenge 2 Agent B suite plan
node scripts/summarize-c2-suite.js --campaign c2-smoke-v1              # compact C2 evidence block
```

Map is server-side. bash: `cd ../Deliveroo.js/backend && GAME_NAME=26c1_1 npm start`.
PowerShell: `cd ../Deliveroo.js/backend ; $env:GAME_NAME='26c1_1'; npm.cmd start`.
