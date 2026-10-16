# R7 PR3 requirement ledger

Scope: roadmap PR3 — PostgreSQL persistence only.

| ID | Requirement | Source | Criticality | Acceptance evidence | Surface | Initial state |
| --- | --- | --- | --- | --- | --- | --- |
| R3-01 | Persist `flows`, `flow_versions`, `executions`, `stage_executions`, `attempts`, `execution_events` | hand-off | HARD | clean PostgreSQL migration + table inspection | migration 0001 | PARTIAL |
| R3-02 | Versioned migration has verified upgrade and rollback/reapply behavior | hand-off/R7 | HARD | integration test against clean Postgres | migration runner + SQL | UNVERIFIED |
| R3-03 | Flow Versions are append-only/immutable | architecture | HARD | DB rejects update/delete; duplicate `(flow_id,version)` rejected | SQL constraints/trigger | UNVERIFIED |
| R3-04 | Execution pins a Flow Version belonging to the same Flow | architecture | HARD | mismatched composite FK rejected | executions FK | UNVERIFIED |
| R3-05 | Execution + initial Stage materialization is atomic | hand-off | HARD | induced mid-transaction uniqueness failure leaves no partial rows | repository transaction | UNVERIFIED |
| R3-06 | Retry history is preserved by distinct Attempt sequences | hand-off | HARD | duplicate sequence rejected; original remains | attempts unique constraint | UNVERIFIED |
| R3-07 | Execution evidence survives concurrent append with total persisted ordering | architecture | HARD | concurrent append integration test, no loss/duplicate IDs | execution_events identity order | UNVERIFIED |
| R3-08 | Repository round-trips public PR1/PR2 records without semantic drift | hand-off | HARD | round-trip integration test | repository mappers | UNVERIFIED |
| R3-09 | Concurrent state writers cannot both win against the same expected state | hand-off | HARD | concurrent CAS test has exactly one winner | SQL compare-and-set | UNVERIFIED |
| R3-10 | PostgreSQL adapter does not define domain transition legality | PR2 invariant | HARD | dependency boundary + repository API inspection | boundary script | PARTIAL |
| R3-11 | CI executes the actual PostgreSQL integration path | R7 | HARD | hosted Actions service Postgres + `npm run test:postgres` success | CI | UNVERIFIED |
| R3-12 | PR4+ queue/effect/gate/provider features are not pulled into PR3 | hand-off | HARD | diff/topology inspection | repository scope | PARTIAL |

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
  versions are not claimed compatible until executed.
- **A3-02 (LOW):** PostgreSQL `READ COMMITTED` is sufficient for PR3 because
  concurrency-sensitive writes use single-statement predicates or constraints.
  PR4 may introduce stronger locking where lease ownership requires it.
- **A3-03 (LOW):** `pg` 8.23.1 is the Node adapter for this slice; no ORM is needed
  for six explicit tables and narrow transaction boundaries.

Final states are updated only after hosted evidence from the final PR head.
