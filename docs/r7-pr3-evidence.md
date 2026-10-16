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

No PR3 failure is closed yet. Hosted PostgreSQL execution is still pending; any
failure will receive an `F3-xxx` entry with reproducer, root cause, earliest
invalidated phase, selective repair, and re-verification evidence.

## Current evidence state

**CONDITIONAL — PostgreSQL hosted verification and final manifest pending.**
