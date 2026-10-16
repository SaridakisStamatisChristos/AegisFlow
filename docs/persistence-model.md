# PostgreSQL persistence model

PostgreSQL is AegisFlow's reference durable storage and coordination substrate for
V1. Persistence stores domain state; `@aegisflow/core` defines legal transitions;
`@aegisflow/queue` adds worker authority; `@aegisflow/effects` external-side-effect
authority; and `@aegisflow/gates` durable human approval authority.

Reference CI target: PostgreSQL 17.

## Implemented entities

### `flows` / `flow_versions`

Flows have stable identity. Flow Versions are append-only immutable snapshots. A
trigger rejects FlowVersion UPDATE/DELETE, and Executions pin one version.

### `executions` / `stage_executions`

Executions store current lifecycle state and the pinned FlowVersion. One logical
Stage instance exists per Execution. Composite `(id, execution_id)` uniqueness lets
later authority records prove same-Execution ownership with foreign keys.

### `attempts` / `claims`

Attempts preserve work-attempt history. Claims store durable worker authority,
leases, owner, and monotonic fencing generation. Only one Claim may be ACTIVE per
StageExecution.

### `execution_events`

Structured JSON-object evidence with a database-assigned total persisted order.

### `effects` / `effect_reconciliations`

PR5 stores stable Effect identity, canonical-intent digest, terminal outcome
classification, and optional immutable reconciliation evidence. Raw connector intent
is not stored in the ledger.

### `gates`

PR6 stores one durable Gate per Gate StageExecution:

- Gate ID, owning Execution and Gate StageExecution;
- PR2 Gate state (`WAITING`, `APPROVED`, `REJECTED`, `EXPIRED`);
- optional database-clock expiry deadline;
- terminal resolution timestamp;
- create/update timestamps.

A composite foreign key proves the Gate StageExecution belongs to the same
Execution. State/timestamp consistency is database-constrained.

### `gate_protections`

Maps each Gate to the materialized direct dependent StageExecutions it protects.
Both the Gate and protected Stage must belong to the same Execution. Several Gates
may protect one Stage.

### `gate_resolutions`

One immutable terminal evidence row per Gate. Approval/rejection requires a bounded
opaque actor identifier; expiry has no human actor. Bounded JSON object evidence and
a PostgreSQL timestamp are persisted. A trigger rejects UPDATE or DELETE.

## Transaction and authority boundaries

1. **Migrations:** transactional under an advisory migration lock.
2. **Execution bootstrap:** Execution plus initial StageExecutions are atomic.
3. **Worker claims:** row locks, generations, leases, and conditional writes fence
   duplicate/stale worker authority.
4. **Effects:** planning, claim, completion, and reconciliation serialize through
   locked Effect rows and uniqueness constraints.
5. **Gate creation:** materialized Stage rows are locked; the pinned Flow definition
   is validated; Gate expiry and direct protection edges are derived; the Gate Stage
   enters WAITING; Gate/protection rows commit together.
6. **Gate decision:** the Gate row and Gate Stage are locked; deadline is checked
   using the database clock; Gate state, Stage state, and immutable resolution
   evidence commit atomically.
7. **Protected Claim enforcement:** PostgreSQL rejects an ACTIVE Claim when any Gate
   protecting that Stage is not APPROVED. Failed queue attempts roll back their
   Attempt/Stage changes with the transaction.
8. **Evidence append:** database identity provides total persisted event order.

PostgreSQL `READ COMMITTED` is the current reference isolation level. Authority
paths rely on row locks, constraints, and conditional writes rather than unguarded
application read-then-write sequences.

## Migration lifecycle

Current chain:

1. `0001_initial` — Flow/runtime persistence and ordered evidence.
2. `0002_worker_claims` — worker Claims, fencing generations, lease indexes.
3. `0003_effect_ledger` — Effects, stable keys, intent digests, immutable
   reconciliation evidence.
4. `0004_durable_gates` — Gates, protection edges, immutable resolution evidence,
   and database Claim protection.

The integration suite verifies clean apply, rollback of `0004` while retaining the
PR5 schema, then rollback of `0003`, `0002`, and `0001`, followed by full-chain
reapplication.

## Still outside PR6

- authenticated/authorized human identity and policy/RBAC;
- notification delivery and approval UI;
- connector/provider-specific execution and idempotency forwarding;
- general graph scheduling/unblocking behavior;
- Signals, API/SDK/CLI, background worker/sweeper services, and operator UI.
