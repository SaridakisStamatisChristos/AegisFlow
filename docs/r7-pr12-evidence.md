# R7 PR12 Evidence Record — Demo and Benchmark Suite

Revision state: implementation generated; evidence remains **UNVERIFIED** until the committed PR12 revision executes in GitHub Actions.

## Planned evidence

| Requirement | Evidence path | State |
| --- | --- | --- |
| R12-01 | Flagship JSON is registered and execution materialization inspected by the suite. | UNVERIFIED |
| R12-02 | `deterministic-flow` scenario. | UNVERIFIED |
| R12-03 | `agent-reasoning` scenario. | UNVERIFIED |
| R12-04 | `human-gate` scenario. | UNVERIFIED |
| R12-05 | `external-effect` scenario. | UNVERIFIED |
| R12-06 | `transient-failure-retry` scenario. | UNVERIFIED |
| R12-07 | `worker-crash-recovery` scenario with real child-process kill. | UNVERIFIED |
| R12-08 | `stale-worker-fencing` scenario. | UNVERIFIED |
| R12-09 | `wait-signal-resume` scenario. | UNVERIFIED |
| R12-10 | `ambiguous-effect-reconciliation` scenario. | UNVERIFIED |
| R12-11 | Suite uses loopback Control API + SDK + production runtime authorities + PostgreSQL. | UNVERIFIED |
| R12-12 | CI deterministic-example step. | UNVERIFIED |
| R12-13 | Existing architecture boundary/regression gates. | UNVERIFIED |
| R12-14 | Structured report contains `benchmarkKind=semantic-correctness`, `performanceClaim=false`. | UNVERIFIED |
| R12-15 | Full existing CI chain. | UNVERIFIED |
| R12-16 | PR12 checksum manifest. | UNVERIFIED |

## Falsification targets

- flagship Flow rejected by canonical contract validation;
- benchmark that passes without using public API/SDK where those surfaces exist;
- duplicate Effect causing a second external call;
- transient recovery rewriting Attempt history;
- fake worker crash simulated only by direct state edits;
- stale generation still able to complete;
- duplicate Signal creating a second durable Signal;
- ambiguous connector outcome accidentally retried;
- reconciliation silently changing history rather than recording explicit evidence;
- missing `DATABASE_URL` or unavailable dependency reported as PASS;
- child process hangs CI indefinitely;
- timing variance causing semantic benchmark failure;
- install/package-lock drift;
- existing PR1-PR11 PostgreSQL/runtime regression;
- unsealed artifact drift.

## Claims

| Claim | State |
| --- | --- |
| PR12 scenario harness is implemented | PARTIAL — generated, not yet executed |
| The nine required handoff scenarios pass | UNVERIFIED |
| The process-kill scenario uses a real killed worker | UNVERIFIED |
| PR12 completes the implementation roadmap | UNVERIFIED |
| PR12 is merge-ready | UNVERIFIED |
