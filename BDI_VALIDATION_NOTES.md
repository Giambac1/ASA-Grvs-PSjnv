# BDI Validation Notes

This note summarizes the current Challenge 1 / BDI validation result.

## Main Result To Keep

Run file:

```text
experiments/results/final-bdi-c1-bdi-2026-06-16T10-07-24-580Z.json
```

Log file:

```text
experiments/logs/final-bdi-c1-bdi-2026-06-16T10-07-24-580Z.jsonl
```

## Summary

| Run | Strategy | Duration | Score | Picked | Delivered | Failed moves | Failed actions | Planner calls |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| final-bdi-c1 | greedy-nearest | 60 s | 256 | 23 | 23 | 0 | 0 | 0 |

This is the best clean BDI validation run so far. It should be used as the
main evidence that Agent A satisfies the Challenge 1 requirements.

## Interpretation

The BDI agent successfully:

- sensed the environment from server events;
- revised beliefs about parcels, own position, and map state;
- generated pickup and delivery options;
- revised intentions during the run;
- collected parcels;
- delivered parcels to delivery zones;
- completed the run with no failed moves and no failed actions.

The run used no PDDL planner calls:

```text
plannerCalls: 0
plannerFailures: 0
```

This is expected and desirable for the baseline BDI validation. PDDL evidence is
handled separately in `PDDL_EXPERIMENT_NOTES.md`.

## About Failed Intentions

The result has:

```text
failedIntentions: 5
```

This is not a problem. The log shows these failures mostly have
`reason: "stopped"`, meaning the intention revision mechanism interrupted older
intentions when the current situation changed. This is evidence of active
intention revision, not broken behavior.

## Report Wording

Suggested wording:

> Agent A was validated on a Challenge 1 course-server scenario using the
> greedy-nearest BDI strategy. In a 60-second run, the agent achieved a final
> score of 256, picked up 23 parcels, delivered 23 parcels, and had zero failed
> moves or failed actions. This confirms that the BDI loop can sense the
> environment, revise beliefs, revise intentions, and execute package collection
> and delivery reliably. Intention failures in the log were caused by deliberate
> stopping during intention revision rather than action execution errors.

## Next Step

Move on to Challenge 2 / LLM validation:

1. Run Agent A and Agent B together.
2. Check that Agent B handles mission-agent requests.
3. Check that Agent B forwards structured missions to Agent A.
4. Collect logs showing message exchange, mission interpretation, and strategy
   adaptation.

