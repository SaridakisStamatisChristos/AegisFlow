# R7 PR3 evidence and repair ledger

## Scope

Roadmap PR3 only: PostgreSQL reference persistence. Worker claims/leases/fencing,
Effects, Gates, Signals, providers, connectors, APIs, deployment, and UI are outside
this slice.

## Contract / plan / spec

The authoritative hand-off requires six minimum tables, migrations, clean migration
evidence, round-trip tests, documented transaction boundaries, and concurrent
integration tests where relevant. PR3 maps those requirements to
`@aegisflow/persistence`, one initial reversible SQL migration, and a real
PostgreSQL integration suite.

## Local evidence available before hosted CI

- TypeScript source for the persistence package compiled under the repository's
  strict compiler options against temporary interface stubs for its external
  modules.
- migration file pairing and package topology were inspected.
- the local execution environment has Node 22.16.0, npm 10.9.2, and TypeScript
  5.8.3 but no PostgreSQL server, so database acceptance is **not** marked passed
  locally.

## Falsification targets encoded in integration tests

1. clean migration -> rollback -> reapply;
2. direct FlowVersion `UPDATE` and `DELETE` attempts;
3. mid-transaction Stage uniqueness failure after Execution insert;
4. Execution pointing to a FlowVersion owned by another Flow;
5. two concurrent compare-and-set writers against one expected state;
6. concurrent evidence append with no lost rows and strict position ordering;
7. duplicate Attempt sequence attempting to overwrite retry history.

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
- **Dependent gates to rerun:** full source verification, all PostgreSQL integration
  tests, dependency audit, and the concurrent-event reproducer on the repaired
  revision.
- **Independent evidence:** the schema still enforces the identity column as a
  primary key, while the integration test independently validates strictly
  increasing repository output after concurrent inserts.
- **State:** REPAIRED IN CODE / REVERIFICATION PENDING.

## Current evidence state

**CONDITIONAL — F3-001 repaired; hosted PostgreSQL re-verification and final manifest pending.**
