# Challenge 2 Agent B (single-agent) results — campaign `c2-full-v5`

Committed record of the Agent B / Challenge 2 levels 1–2 validation (raw
per-scenario manifests and JSONL live in the git-ignored
`experiments/c2-suite/`; this file is the durable copy for the report).

- **Setup:** local Deliveroo.js server, one Challenge 2 map per scenario,
  loaded with `node index.js -g missionAgents/challenge2/26c2_N.json`.
  Agent B = `src/main-llm.js` (`--strategy mission-aware`). Mission agents
  from `DeliverooAgent.js/missionAgents/` connect as **god** (admin token).
- **LLM:** real course gateway `https://llm.bears.disi.unitn.it/v1`,
  model `llama-3.3-70b-lmstudio`, via VPN — so `source=llm` rows are
  genuine LLM interpretations, not the deterministic fallback.
- **Protocol:** `scripts/run-c2-suite.js` (starts/stops server + Agent B +
  mission agent per scenario), summarized by `scripts/summarize-c2-suite.js`.
  One run per scenario.
- **Date:** 2026-06-16 (run 2026-06-15 late). **Raw:**
  `experiments/c2-suite/c2-full-v5/`.

## Results (one run per scenario)

| Scenario | Mission | Source | Outcome | Evidence |
|---|---|---|---|---|
| 26c2_3 | question_answer (calc → 22) | llm | **PASS** reward | answered 22; +10000 |
| 26c2_1 | go_to bonus (19–21,19) | llm | **PASS** reward | reached (21,19); +1000 |
| 26c2_2 | deliver_at (1,1) | llm | **PASS** reward | delivered at (1,1); +1000 |
| 26c2_5 | deliver_exactly_n (3) | llm | **PASS** reward | deliveries=3; +100 |
| 26c2_7 | deliver_less_value_than (≤10) | llm | **PASS** reward | delivered total=10 ≤10; +1000 |
| 26c2_4 | go_to **forbidden** (13–16,15) | llm | **PASS** no-penalty | no penalty; score +648 |
| 26c2_6 | deliver_at **forbidden** (15–16,31–32) | llm | **PASS** no-penalty | no penalty; score +359 |
| 26c2_9 | red/green light | fallback | **PASS** no-penalty | gate via deterministic parser |

**8/8 PASS. Seven scenarios are `source=llm` (real LLM-driven
interpretation); 26c2_9 is `source=fallback` by design** — the red/green
light gate must be instantaneous and never wait for the LLM.

## Latency-safety fix — before/after (26c2_4)

26c2_4 forbids movement through (13,15)–(16,15) under a −1000 penalty. With
the LLM in the loop the interpretation takes seconds, during which the agent
keeps farming and can cross a forbidden tile before the constraint is applied.

| Run | Source | LLM latency | Pre-apply | Result |
|---|---|---|---|---|
| `c2-llm-check-v1` (pre-fix) | llm | 8664 ms | — | **penalty** at (16,15), score **−377** |
| `c2-fix-26c2_4-v1` (post-fix) | llm | 2928 ms | logged ~3 s **before** the LLM returned | **no penalty**, score **+445** |
| `c2-full-v5` (post-fix, full suite) | llm | — | yes | **no penalty**, score **+648** |

**Fix:** in `src/main-llm.js`, before the LLM round-trip, the message is
parsed deterministically and any *safety-critical* constraint
(`MissionInterpreter.isSafetyCritical`: forbidden `go_to`/`deliver_at`,
light state) is applied to beliefs immediately; the LLM result still runs
and is authoritative, reconciling idempotently (`blockTiles` /
`setForbiddenDeliveries` / light gate are Sets/flags). This closes the
latency window **while keeping the LLM the primary interpreter**
(`source=llm` preserved). Causal proof: the `mission_preapplied` log
precedes the `llm_call` completion by ~3 s.

## Key findings

1. **Agent B is genuinely LLM-driven** for levels 1–2: question answering,
   positional goals, and delivery policies are interpreted by the real
   course LLM and rewarded on the live server.
2. **Deterministic fallback is a resilience layer, not the intelligence.**
   An earlier all-fallback pass (`c2-full-v4`, every scenario
   `llm_error:"Connection error."` → gateway unreachable) still scored 8/8:
   graceful degradation when the gateway is down. The fallback covers the
   known templates; the LLM handles the general/ reworded case.
3. **Latency is variable and can be large** (1.8–8.7 s observed). Any design
   that lets the agent act before the constraint is applied is unsafe for
   negative/safety-critical missions — hence the synchronous pre-apply.
4. **The mission-execution fixes hold under live LLM:** deliver_at settle
   (26c2_2), exactly-N suppression (26c2_5), under-cap selective putdown
   with hold-until-decay (26c2_7) all earn their bonuses.

## Honest caveats

- **One run per scenario.** Encouraging, not a statistic. The timing-
  sensitive passes (26c2_2, 26c2_4) were each re-confirmed in a second run,
  but no n≥5 campaign was done (the failure modes are deterministic in the
  code, so repetition adds little).
- **Local server, not the public online server.** This is the correct
  testbed for mission handling (real LLM + real mission agents). The only
  online delta is **crates**, which the architecture does not model — a
  known, separate limitation (see README "Known assumptions"), orthogonal
  to level 1–2 mission compliance.
- **Conservative, non-undoable pre-apply.** A regex false-positive
  "forbidden" would keep a few tiles blocked until the next mission (no
  `GridGraph.unblock`). For the known templates regex and LLM agree, and
  over-blocking is far cheaper than a penalty.

## Status

**Challenge 2 levels 1–2 (single agent) are functionally complete, green on
the real server, LLM-driven, and latency-safe.** Remaining for "Agent B
done": **level 3 / coordination** — `26c2_8` handover
(one_pickup_another_deliver) and `26c2_10` go-to-and-wait (replace the
fixed `sleep(5000)` in `GoToMissionTarget` with real teammate
synchronization via the team protocol).
