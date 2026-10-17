# PostgreSQL persistence model

PostgreSQL is AegisFlow's reference durable storage and coordination substrate for V1. `@aegisflow/core` defines legal state transitions; persistence stores durable state; queue, Effect, Gate, provider, connector, and scheduler layers add authority-specific behavior.

Reference CI target: PostgreSQL 17.

## Core entities

### `flows` / `flow_versions`

Flows have stable identity. Flow Versions are append-only immutable snapshots. Executions pin one immutable version.

### `executions` / `stage_executions`

Executions store lifecycle state and the pinned Flow Version. One StageExecution is materialized for each logical Stage instance in an Execution.

### `attempts` / `claims`

Attempts preserve work-attempt history. Claims store durable worker authority, owner, lease, and monotonic fencing generation. Only one active Claim may exist per StageExecution.

### `execution_events`

Structured JSON evidence with database-assigned persisted order.

### `effects` / `effect_reconciliations`

Effects store stable side-effect identity, canonical-intent digest, durable state, bounded outcome metadata, and optional immutable reconciliation evidence. Raw connector credentials are not persisted.

### `gates` / `gate_protections` / `gate_resolutions`

Gates store durable approval state and optional expiry. Protection rows bind Gates to dependent StageExecutions. Resolution rows provide immutable decision evidence.

### provider/tool results and signals

Provider results, tool results, and Signals are durable evidence/state records with database-enforced ownership and immutability rules where applicable.

## Transaction and authority boundaries

1. **Migrations** run transactionally under an advisory lock.
2. **Execution bootstrap** creates the Execution and initial StageExecutions atomically.
3. **Worker claims** use row locks, generations, leases, and conditional writes to fence stale workers.
4. **Effects** serialize planning, claim, completion, and reconciliation through row locks and uniqueness constraints.
5. **Gate operations** lock relevant rows and atomically commit Gate/Stage/evidence changes.
6. **Provider success** commits provider-result evidence and Effect success in one local transaction.
7. **Scheduler reconciliation** locks an Execution and its Stage rows before applying graph transitions.
8. **Evidence append** uses database ordering for a durable event sequence.

PostgreSQL `READ COMMITTED` is the current reference isolation level. Authority paths rely on locks, constraints, triggers, and conditional writes rather than unguarded application read-then-write sequences.

## Migration lifecycle

The migration chain covers core runtime persistence, worker claims, Effect ledger, durable Gates, provider/tool result evidence, Control API state, Signals, and cancellation/Effect quarantine protections. Integration tests verify clean application, targeted rollback compatibility, and full-chain reapplication.

## Integrity principles

- immutable Flow Versions;
- monotonic terminal state;
- same-Execution ownership checks across related records;
- at most one active worker Claim per StageExecution;
- immutable Gate and reconciliation evidence;
- no blind replay after ambiguous external outcomes;
- durable idempotency for execution submission and Signals;
- cancellation cannot leave a claimed Effect indefinitely authoritative.

## Current limits

Authenticated identity/RBAC, production HA/backup policy, deployment topology, and cross-version PostgreSQL portability are outside the current persistence qualification boundary.
