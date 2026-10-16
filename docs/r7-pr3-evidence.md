# R7 PR3 evidence and repair ledger

## Scope

Roadmap PR3 only: PostgreSQL reference persistence. Worker claims/leases/fencing,
Effects, Gates, Signals, providers, connectors, APIs, deployment, and UI are outside
this slice.

## Contract / plan / spec

The authoritative hand-off requires six minimum tables, migrations, clean migration
evidence, round-trip tests, documented transaction boundaries, and concurrent
integration tests where relevant. PR3 maps those requirements to
`@aegisflow/persistence`, one reversible initial SQL migration, and a real
PostgreSQL integration suite.

## Local evidence

- TypeScript source for the persistence package compiled under the repository's
  strict compiler options against temporary interface stubs for its external
  modules.
- migration file pairing and package topology were inspected.
- the local execution environment has Node 22.16.0, npm 10.9.2, and TypeScript
  5.8.3 but no PostgreSQL server, so database acceptance was intentionally left
  unverified locally and delegated to hosted CI.

## Hosted verification

### Initial code-bearing run — falsification found a defect

GitHub Actions run `38968425696`, job `117200564980`:

- PostgreSQL 17 service initialization: PASS;
- fresh dependency install: PASS;
- source/package verification: PASS (30/30 pre-existing contract/core tests);
- PostgreSQL integration: **FAILED** at concurrent event ordering (7/8 passed);
- runtime dependency audit: skipped because the preceding gate failed.

This failure is preserved as F3-001 rather than overwritten by the repaired run.

### Repaired revision

Revision `c96c46684dfc5456cf5877829b0b3da8fd181989` was verified by GitHub
Actions run `38968766281`, job `117201685348`:

- PostgreSQL 17 service initialization: PASS;
- fresh dependency install: PASS;
- `npm run verify`: PASS;
- PostgreSQL migration/repository integration suite: PASS;
- F3-001 concurrent-event reproducer: PASS;
- runtime dependency audit: PASS;
- overall job conclusion: SUCCESS.

## Falsification targets encoded in integration tests

1. clean migration -> rollback -> reapply;
2. direct FlowVersion `UPDATE` and `DELETE` attempts;
3. mid-transaction Stage uniqueness failure after Execution insert;
4. Execution pointing to a FlowVersion owned by another Flow;
5. two concurrent compare-and-set writers against one expected state;
6. concurrent evidence append with no lost rows and strict numeric position ordering;
7. duplicate Attempt sequence attempting to overwrite retry history.

The round-trip test independently covers Flow, FlowVersion, Execution,
StageExecution, Attempt, and execution-event serialization/deserialization.

## Failure / repair ledger

### F3-001 — execution-event ordering was lexicographic after text projection

- **Observed evidence:** GitHub Actions run `38968425696`, job `117200564980`.
  Source verification passed, then PostgreSQL integration test 7/8 failed on the
  strict monotonic position assertion for concurrent event appends.
- **Reproducer:** append 24 execution events concurrently, read them through
  `listExecutionEvents`, then assert every returned `position` is greater than its
  predecessor.
- **Violated requirement:** R3-07 (concurrent evidence must have a total persisted
  order exposed correctly by the repository).
- **Root cause:** the SQL projected `position::text` so the Node adapter could parse
  PostgreSQL `bigint` safely as JavaScript `bigint`, but `ORDER BY position` bound
  to the projected text output name. Values therefore sorted lexicographically
  (`1, 10, ... 2, ...`) rather than by the underlying numeric identity column.
- **Earliest invalidated phase:** GENERATE. The schema/identity design was correct;
  the repository read query was not.
- **Selective repair:** keep the text projection but qualify the sort expression as
  `ORDER BY execution_events.position ASC`, forcing PostgreSQL to order by the
  numeric source column.
- **Dependent gates rerun:** full source verification, all PostgreSQL integration
  tests, dependency audit, and the original concurrent-event reproducer.
- **Independent evidence:** the schema enforces the identity column as a primary
  key, while the integration test independently verifies strictly increasing
  repository output after concurrent inserts.
- **State:** CLOSED / VERIFIED by run `38968766281`.

## Claim ledger

| Claim | State | Evidence / limitation |
| --- | --- | --- |
| PR3 provides reference durable storage for the six declared entities on PostgreSQL 17 | VERIFIED | clean migration, round-trips, transaction/concurrency tests in run `38968766281` |
| Flow Versions are database-enforced immutable | VERIFIED | direct update/delete adversarial test + trigger |
| Execution bootstrap is atomic | VERIFIED | induced mid-transaction conflict leaves no partial rows |
| Concurrent expected-state writers have at most one winner | VERIFIED | concurrent CAS integration test |
| Concurrent execution evidence is lossless and returned in numeric persisted order | VERIFIED | 24-way append test after F3-001 repair |
| Compatibility with PostgreSQL majors other than 17 | UNVERIFIED | not executed |
| Worker recovery / lease fencing | UNVERIFIED / OUT OF PR3 SCOPE | PR4 |
| Production readiness, HA, backup/restore, capacity, SOTA performance | UNVERIFIED | not claimed by PR3 |

## Evidence gaps / next slice

No PR3 HARD requirement remains open for the declared PostgreSQL 17 CI target.
Remaining work belongs to later roadmap slices, beginning with PR4 worker claims,
leases, generation fencing, heartbeat/expiry, and abandoned-work recovery.

## Completion state

**VERIFIED FOR DECLARED PR3 POSTGRESQL 17 TARGET — merge-ready after the exact final evidence/manifest head re-passes CI.**
