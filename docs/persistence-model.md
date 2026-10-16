# PostgreSQL persistence model

PR3 establishes PostgreSQL as AegisFlow's reference durable storage adapter. It
persists domain state but does not define domain transition semantics; those stay
in `@aegisflow/core`.

Reference CI target: PostgreSQL 17.

## Implemented entities

### `flows`

Stable Flow identity plus mutable descriptive metadata. PR3 exposes create/read
only; later APIs may add metadata updates without changing version snapshots.

### `flow_versions`

Append-only immutable snapshots keyed by `(flow_id, version)` and unique
Flow-Version ID. A database trigger rejects `UPDATE` and `DELETE`. Each Execution
pins one row, and a composite foreign key enforces that the pinned version belongs
to the same Flow ID stored on the Execution.

### `executions`

Execution identity, pinned Flow and Flow-Version IDs, current state, and lifecycle
timestamps. Storage exposes compare-and-set state updates; callers remain
responsible for validating the transition through the pure PR2 state machine.

### `stage_executions`

One logical Stage instance per Execution, enforced by
`UNIQUE (execution_id, stage_id)`. Creation of an Execution and its initial Stage
rows is one transaction.

### `attempts`

Attempt history is preserved by unique `(stage_execution_id, sequence)` rows.
Retrying creates a new sequence instead of overwriting an earlier Attempt.
Attempt state updates use compare-and-set storage primitives; retry policy remains
core/runtime logic.

### `execution_events`

Structured JSON-object evidence with an immutable database-assigned `position`.
The identity column gives concurrent inserts a total persisted order. Event IDs
remain caller-supplied AegisFlow `EvidenceId` values and are unique.

## Transaction boundaries

PR3 defines these boundaries explicitly:

1. **Migration file:** each migration is applied in one transaction while a
   PostgreSQL advisory lock serializes concurrent migrators.
2. **Execution bootstrap:** the Execution row and all initial StageExecution rows
   commit or roll back together.
3. **State write:** compare-and-set updates are one SQL statement, so concurrent
   writers cannot both commit against the same expected state.
4. **Flow-Version append:** insertion is one statement; database uniqueness and an
   immutability trigger prevent replacement or mutation.
5. **Attempt append:** uniqueness of `(stage_execution_id, sequence)` prevents a
   retry from replacing prior history.
6. **Evidence append:** one insert atomically allocates the database order position
   and persists the event payload.

PostgreSQL's default `READ COMMITTED` isolation is sufficient for these PR3
primitives because conflicting state writes use predicates/constraints rather than
read-then-write application races. PR4 will add row ownership, leases, generation
fencing, heartbeat/expiry, and abandoned-work recovery.

## Migration lifecycle

Migration files live in `packages/persistence/migrations` and are paired as
`*.up.sql` / `*.down.sql`. Applied IDs are recorded in
`aegisflow_schema_migrations`. The runner serializes migration execution with an
advisory lock.

`rollbackLastMigration` exists for development/test rollback validation. It is a
destructive operation and is never invoked automatically by runtime code.

## Deliberately not implemented in PR3

The following remain later roadmap slices:

- worker claims, leases, generation fencing, heartbeat, and recovery — PR4;
- Effect ledger/idempotency/reconciliation storage — PR5;
- durable Gates and approval evidence — PR6;
- Signals, providers, connectors, API/SDK/CLI, and operator UI.
