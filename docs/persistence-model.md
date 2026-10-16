# PostgreSQL persistence model

PostgreSQL is AegisFlow's reference durable storage and coordination substrate for
V1. Persistence stores domain state; `@aegisflow/core` defines legal transitions;
`@aegisflow/queue` composes those semantics with durable worker authority.

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
atomic.

### `attempts`

Append-only work-attempt history with unique `(stage_execution_id, sequence)`.
Retries and worker recovery create a new sequence instead of reopening history.

### `execution_events`

Structured JSON-object evidence with a database-assigned identity `position`, giving
concurrent inserts a total persisted order.

### `claims`

PR4 adds durable worker authority. Each Claim is permanently tied to one Attempt and
contains:

- StageExecution ID;
- worker owner ID;
- positive monotonic generation;
- `ACTIVE`, `COMPLETED`, or `EXPIRED` state;
- claimed, heartbeat, lease-expiry, and optional finished timestamps.

A partial unique index permits at most one `ACTIVE` Claim per StageExecution. A
unique `(stage_execution_id, generation)` constraint makes generations durable
fencing tokens. Historical completed/expired Claims remain stored.

## Transaction boundaries

1. **Migrations:** each migration is applied transactionally while an advisory lock
   serializes migrators.
2. **Execution bootstrap:** Execution plus initial StageExecution rows commit or
   roll back together.
3. **PR3 compare-and-set:** concurrent expected-state writers cannot both win one
   state predicate.
4. **Claim acquisition:** the StageExecution row is locked before active-Claim
   inspection and new Attempt/Claim creation.
5. **Recovery:** expired Claim -> old Attempt `TIMED_OUT` -> Claim `EXPIRED` -> new
   Attempt + higher-generation Claim occurs in one transaction.
6. **Authoritative completion:** StageExecution, Attempt, and matching Claim are
   validated/updated in one transaction; stale generations cannot commit.
7. **Heartbeat:** one conditional SQL update extends only the exact live,
   unexpired owner/Attempt/generation.
8. **Evidence append:** one insert allocates the persisted event order position and
   stores the event payload.

PostgreSQL `READ COMMITTED` is the current reference isolation level. PR4's
authority-sensitive paths rely on row locks, conditional writes, and database
constraints rather than application read-then-write races.

## Migration lifecycle

Migrations live in `packages/persistence/migrations` as paired `*.up.sql` /
`*.down.sql` files and are tracked in `aegisflow_schema_migrations`.

Current chain:

1. `0001_initial` — Flow/runtime persistence and ordered evidence.
2. `0002_worker_claims` — durable worker Claims, generations, and lease indexes.

The integration suite verifies clean apply, rollback of `0002` while retaining the
PR3 schema, rollback of `0001`, and reapplication of the full chain.

## Still outside this slice

- Effect ledger/idempotency/reconciliation — PR5;
- durable Gates and approval evidence — PR6;
- Signals, providers, connectors, API/SDK/CLI, background recovery service, and
  operator UI.
