# R7 PR12 Requirement Ledger — Demo and Benchmark Suite

Source: `AEGISFLOW_MASTER_HANDOFF.md` PR12, flagship demo, testing strategy, CI gates, V1 success criteria, and inherited runtime invariants.

| ID | Requirement | Source | Criticality | Acceptance evidence | State |
| --- | --- | --- | --- | --- |
| R12-01 | Provide a valid flagship Incident Response Flow example. | USER | HARD | Checked-in Flow validates/registers through public SDK/API. | OPEN |
| R12-02 | Demonstrate deterministic Flow execution. | USER | HARD | API start -> queue claim -> durable successful Stage/Attempt/Claim -> SDK inspection. | OPEN |
| R12-03 | Demonstrate Agent reasoning without external credentials. | USER | HARD | Deterministic provider + schema-validated final result + provider Effect evidence. | OPEN |
| R12-04 | Demonstrate durable human Gate semantics. | USER | HARD | Gate WAITING -> APPROVED, evidence retained, duplicate decision deterministic. | OPEN |
| R12-05 | Demonstrate an external Effect and duplicate suppression. | USER / DOMAIN | HARD | Connector called once; replay returns durable result for same stable Effect identity. | OPEN |
| R12-06 | Demonstrate transient failure and retry. | USER | HARD | Expired lease -> Attempt 1 TIMED_OUT -> recovered Attempt 2 -> SUCCEEDED. | OPEN |
| R12-07 | Demonstrate actual worker crash and recovery. | USER | HARD | Child process claims work, is killed, lease expires, replacement generation completes. | OPEN |
| R12-08 | Demonstrate stale-worker fencing. | USER / DOMAIN | HARD | Old generation completion rejected with STALE_CLAIM after recovery. | OPEN |
| R12-09 | Demonstrate wait/signal resume and duplicate-signal idempotency. | USER | HARD | SDK Signal resumes Stage; duplicate key replays same durable Signal. | OPEN |
| R12-10 | Demonstrate ambiguous side effect requiring reconciliation. | USER / DOMAIN | HARD | Effect becomes RECONCILIATION_REQUIRED; no blind retry; explicit reconciliation recorded. | OPEN |
| R12-11 | Include a public API -> runtime/worker -> PostgreSQL -> result E2E path. | USER | HARD | PR12 semantic suite starts real Control API and observes durable state through SDK plus production authorities. | OPEN |
| R12-12 | Run deterministic examples in actual CI. | USER / R7 | HARD | Observed GitHub Actions run on exact PR12 head executes `npm run demo:pr12`. | OPEN |
| R12-13 | Preserve PR1-PR11 authority boundaries; no second runtime/state model. | DOMAIN | HARD | Harness imports production public/runtime packages; no production authority bypass; normal boundary/regression gates green. | OPEN |
| R12-14 | Do not present timing observations as performance superiority. | R7 | HARD | Report declares semantic-correctness benchmark and `performanceClaim: false`; no timing gate. | OPEN |
| R12-15 | Preserve all existing regressions, PostgreSQL tests, dependency audit and reproducible install. | R7 | HARD | Full CI gates green. | OPEN |
| R12-16 | Seal PR12 artifacts/evidence with real checksums. | R7 | HARD | PR12 manifest verifies on final exact head. | OPEN |

## Hard invariants

1. A successful external Effect is not executed twice for the same stable identity.
2. Ambiguous external outcomes are never blindly retried.
3. A stale worker generation cannot commit authoritative success.
4. Worker recovery appends a new Attempt; it never rewrites the expired Attempt.
5. Gate decisions and Signals are durable/idempotent according to their existing contracts.
6. The deterministic provider keeps core demo execution free of paid external model credentials.
7. PR12 is evidence/demo infrastructure, not a new competing runtime or UI framework.

## Assumptions

| ID | Statement | Criticality | Confidence | Invalidation trigger |
| --- | --- | --- | --- | --- |
| A12-01 | “Benchmark” means reproducible semantic scenario evidence; wall-clock durations are diagnostic only because the handoff specifies no latency/throughput target. | LOW | HIGH | User supplies a performance budget/comparator. |
| A12-02 | The flagship example may model the high-severity path linearly rather than invent branch-scheduler semantics absent from the current Flow contract. | MEDIUM | HIGH | Handoff requires automated low/high branch execution in PR12. |
| A12-03 | Linux GitHub Actions is the authoritative process-kill evidence target for `SIGKILL`; other local OSes may terminate children differently. | LOW | HIGH | Cross-platform kill semantics become a declared requirement. |
