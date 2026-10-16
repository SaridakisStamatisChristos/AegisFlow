# R7 PR3 requirement ledger

Scope: roadmap PR3 — PostgreSQL persistence only.

| ID | Requirement | Source | Criticality | Acceptance evidence | Surface | Final state |
| --- | --- | --- | --- | --- | --- | --- |
| R3-01 | Persist `flows`, `flow_versions`, `executions`, `stage_executions`, `attempts`, `execution_events` | hand-off | HARD | clean PostgreSQL 17 migration + six-table inspection in hosted integration test | migration 0001 | VERIFIED |
| R3-02 | Versioned migration has verified upgrade and rollback/reapply behavior | hand-off/R7 | HARD | migration test applies `0001_initial`, rolls it back, verifies removal, and reapplies | migration runner + SQL | VERIFIED |
| R3-03 | Flow Versions are append-only/immutable | architecture | HARD | direct DB `UPDATE`/`DELETE` rejection plus `(flow_id, version)` uniqueness in migration | SQL constraints/trigger | VERIFIED |
| R3-04 | Execution pins a Flow Version belonging to the same Flow | architecture | HARD | integration test rejects a cross-Flow composite-FK mismatch | executions FK | VERIFIED |
| R3-05 | Execution + initial Stage materialization is atomic | hand-off | HARD | induced mid-transaction uniqueness failure leaves no Execution or Stage rows | repository transaction | VERIFIED |
| R3-06 | Retry history is preserved by distinct Attempt sequences | hand-off | HARD | duplicate sequence rejected while original Attempt remains | attempts unique constraint | VERIFIED |
| R3-07 | Execution evidence survives concurrent append with total persisted ordering | architecture | HARD | 24 concurrent appends, no loss/duplicate IDs, strictly increasing numeric positions after F3-001 repair | execution_events identity order | VERIFIED |
| R3-08 | Repository round-trips public PR1/PR2 records without semantic drift | hand-off | HARD | Flow, FlowVersion, Execution, StageExecution, Attempt, and execution event round-trip test | repository mappers | VERIFIED |
| R3-09 | Concurrent state writers cannot both win against the same expected state | hand-off | HARD | two concurrent CAS writers yield exactly one successful write | SQL compare-and-set | VERIFIED |
| R3-10 | PostgreSQL adapter does not define domain transition legality | PR2 invariant | HARD | dependency-boundary check plus persistence API review; package does not import `@aegisflow/core` | boundary script | VERIFIED |
| R3-11 | CI executes the actual PostgreSQL integration path | R7 | HARD | GitHub Actions run `38968766281` provisions PostgreSQL 17 and passes source, PostgreSQL, and dependency-audit gates | CI | VERIFIED |
| R3-12 | PR4+ queue/effect/gate/provider features are not pulled into PR3 | hand-off | HARD | PR diff/topology inspection; no claims, leases, fencing, Effect ledger, durable Gate, provider, connector, API, or UI implementation | repository scope | VERIFIED |

## Hard invariants

- Flow Version content is immutable after insertion.
- an Execution's `flow_id` and `flow_version_id` cannot disagree;
- Execution bootstrap is all-or-nothing;
- a retry cannot replace an existing Attempt sequence;
- concurrent expected-state writes have at most one winner;
- event append does not lose records under concurrency;
- persistence stores state but does not decide whether a domain transition is legal.

## Assumptions

- **A3-01 (MEDIUM):** PostgreSQL 17 is the PR3 reference CI target. Other major
  versions remain unverified and are not claimed compatible.
- **A3-02 (LOW):** PostgreSQL `READ COMMITTED` is sufficient for PR3 because
  concurrency-sensitive writes use single-statement predicates or constraints.
  PR4 may introduce stronger locking where lease ownership requires it.
- **A3-03 (LOW):** `pg` 8.23.1 is the Node adapter for this slice; no ORM is needed
  for six explicit tables and narrow transaction boundaries.

All HARD PR3 requirements are closed as `VERIFIED` for the declared PostgreSQL 17
CI target. This does not promote later-roadmap or production-readiness claims.
