# PDDL Experiment Notes

This note summarizes what to do with the PDDL work and how to explain the
results.

## Current Recommendation

Use BFS/BDI as the default runtime planner. Keep PDDL as an optional,
meaningful planner integration for experiments and report evidence.

The full PDDL pickup-and-deliver plan is now mission-safe: it defers to the
BDI mission plans whenever a mission constraint is active and reuses their
compliant-subset putdown selection, so `PDDL_DELIVERY_ENABLED` is off by
default for performance, not correctness.

Recommended defaults:

```env
PDDL_ENABLED=false
PDDL_DELIVERY_ENABLED=false
PDDL_TIMEOUT_MS=2500
PDDL_MIN_PATH_LENGTH=10
PDDL_AVOID_WHILE_CARRYING=true
```

For PDDL evidence runs, enable PDDL explicitly:

```powershell
$env:PDDL_ENABLED="true"
$env:PDDL_DELIVERY_ENABLED="false"
$env:PDDL_TIMEOUT_MS="5000"
$env:PDDL_MIN_PATH_LENGTH="10"
$env:PDDL_AVOID_WHILE_CARRYING="true"
```

## Experiment Summary

| Setup | Score | Delivered | Picked | Planner calls | Comment |
|---|---:|---:|---:|---:|---|
| BFS baseline | 231 | 21 | 21 | 0 | Best runtime behavior |
| Naive PDDL movement | 0 | 0 | 12 | 16 | Correct plans, too many slow solver calls |
| PDDL full delivery | 36 | 5 | 8 | 14 | Pickup-to-putdown PDDL works, but slow |
| Smart PDDL movement | 137 | 13 | 14 | 4 | Selective PDDL improved performance |

## Interpretation

PDDL integration is correct and meaningful: the agent can generate symbolic
movement plans, and the extended domain can generate full pickup-and-deliver
plans.

The live online solver has high latency, around 3 seconds per call. That makes
PDDL worse than BFS for short paths and urgent delivery, especially when parcels
are decaying.

The selective PDDL gate improves this:

- short paths go directly to BFS;
- delivery while carrying parcels goes directly to BFS;
- PDDL is only used for longer non-carrying movement paths;
- the timeout prevents the agent from waiting too long for the online solver.

This changed the PDDL movement result from 0 score to 137 score, while reducing
planner calls from 16 to 4.

## What To Do Next

1. Keep PDDL disabled by default for normal gameplay.
2. Use BFS/BDI for final Challenge 1 validation.
3. Keep the smart PDDL result for the report.
4. Do not keep tuning PDDL unless there is spare time.
5. Focus next on Challenge 2 validation once the teammate's LLM communication
   work is ready.

## Report Wording

Suggested wording:

> PDDL was integrated as an optional plan-library member inside the BDI
> architecture. The domain was extended from movement-only planning to include
> single-parcel pickup and delivery. Live experiments showed that PDDL produced
> valid plans, but the online solver introduced about 3 seconds of latency per
> call. A naive use of PDDL harmed performance, so we added selective gating:
> short paths and delivery while carrying parcels are handled by BFS, while PDDL
> is reserved for longer non-carrying paths. This preserves meaningful PDDL
> integration while keeping the agent reactive.

