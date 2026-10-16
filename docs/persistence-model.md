# PostgreSQL persistence model

PostgreSQL is AegisFlow's reference durable storage and coordination substrate for
V1. Persistence stores domain state; `@aegisflow/core` defines legal transitions;
`@aegisflow/queue` composes those semantics with durable worker authority; and
`@aegisflow/effects` composes them with durable external-side-effect authority.

Reference CI target: PostgreSQL 17.

## Implemented entities

### `flows`

Stable Flow identity plus mutable descriptive metadata.

### `flow_versions`

Append-only immutable snapshots keyed by `(flow_id, version)` and unique
Flow-Version ID. A trigger rejects `UPDATE` and `DELETE`; a composite foreign key
ensures an Execution cannot pin another Flow's version.

### `executions`

Execution identity, pinned Flow/Flow-Version IDs, current state, and lifecycle
timestamps.

### `stage_executions`

One logical Stage instance per Execution, enforced by
`UNIQUE (execution_id, stage_id)`. Execution creation and initial Stage rows are
atomic. PR5 also adds a redundant composite uniqueness constraint on
`(id, execution_id)` so Effect rows can enforce Stage/Execution ownership with a
composite foreign key.

### `attempts`

Append-only work-attempt history with unique `(stage_execution_id, sequence)`.
Retries and worker recovery create a new sequence instead of reopening history.

### `execution_events`

Structured JSON-object evidence with a database-assigned identity `position`, giving
concurrent inserts a total persisted order.

### `claims`

Durable worker authority. Each Claim is permanently tied to one Attempt and stores
owner, positive monotonic generation, state, lease expiry, heartbeat, claim time,
and optional finish time. One partial unique index permits at most one `ACTIVE`
Claim per StageExecution.

### `effects`

PR5 adds one row for one logical external side effect:

- Effect ID;
- owning Execution and StageExecution;
- stable `effect_key`, unique within the Execution;
- SHA-256 `intent_digest` of canonical JSON intent;
- PR2 Effect state: `PLANNED`, `CLAIMED`, `SUCCEEDED`, `FAILED`, or
  `RECONCILIATION_REQUIRED`;
- claim/resolution timestamps;
- bounded result classification code;
- optional bounded external reference;
- create/update timestamps.

The ledger intentionally does not persist the raw connector intent payload. A
composite foreign key ensures the StageExecution belongs to the stored Execution.
State/timestamp consistency is enforced with a database check constraint.

### `effect_reconciliations`

One optional immutable reconciliation record per Effect whose original outcome was
ambiguous. It stores `CONFIRMED_SUCCEEDED` or `CONFIRMED_FAILED`, the bounded actor
identifier, an optional external reference, and reconciliation time. A trigger
rejects `UPDATE` and `DELETE` so reconciliation evidence cannot be rewritten.

## Transaction boundaries

1. **Migrations:** each migration is applied transactionally while an advisory lock
   serializes migrators.
2. **Execution bootstrap:** Execution plus initial StageExecution rows commit or
   roll back together.
3. **Compare-and-set:** concurrent expected-state writers cannot both win one state
   predicate.
4. **Worker claim acquisition/recovery/completion:** PR4 serializes authority with
   row locks, conditional writes, generations, and leases.
5. **Effect planning:** Stage ownership validation and insert-or-converge behavior
   occur in one transaction. Concurrent same-key planners converge on the row that
   wins the unique `(execution_id, effect_key)` constraint.
6. **Effect claim:** the Effect row is locked before the PR2 `PLANNED -> CLAIMED`
   transition is persisted, preventing two connector callers from both gaining
   authority.
7. **Effect completion:** one locked `CLAIMED` row moves to exactly one terminal
   result with its result classification metadata.
8. **Effect reconciliation:** the terminal ambiguous Effect is locked and a single
   immutable reconciliation row is inserted; duplicate identical reconciliation is
   idempotent, conflicting reconciliation is rejected.
9. **Evidence append:** one insert allocates the persisted event order position and
   stores the event payload.

PostgreSQL `READ COMMITTED` is the current reference isolation level. Authority
paths rely on row locks, conditional writes, uniqueness constraints, and foreign
keys rather than application read-then-write races.

## Migration lifecycle

Migrations live in `packages/persistence/migrations` as paired `*.up.sql` /
`*.down.sql` files and are tracked in `aegisflow_schema_migrations`.

Current chain:

1. `0001_initial` — Flow/runtime persistence and ordered evidence.
2. `0002_worker_claims` — durable worker Claims, generations, and lease indexes.
3. `0003_effect_ledger` — durable Effects, stable keys, intent digests, and immutable
   reconciliation evidence.

The integration suite verifies clean apply, rollback of `0003` while retaining the
PR4 schema, rollback of `0002` while retaining the PR3 schema, rollback of `0001`,
and reapplication of the full chain.

## Still outside this slice

- connector/provider-specific idempotency-key forwarding and retry policy;
- durable Gates and approval evidence — PR6;
- Signals, providers, connectors, API/SDK/CLI, background recovery service, and
  operator UI.
