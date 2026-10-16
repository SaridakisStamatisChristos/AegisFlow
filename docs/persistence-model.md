# Planned persistence model

PostgreSQL implementation begins in PR3. This document fixes the entity boundary
so later storage code does not accidentally define domain semantics.

## Entities

### `flows`
Stable Flow identity and mutable descriptive metadata only.

### `flow_versions`
Append-only immutable snapshots keyed by `(flow_id, version)` and a unique
Flow-Version ID. An Execution pins exactly one row.

### `executions`
Execution identity, pinned Flow-Version ID, state, cancellation marker, and
lifecycle timestamps.

### `stage_executions`
Per-Execution Stage state. One logical Stage instance per pinned Flow Version.

### `attempts`
Append-only attempt history with increasing sequence and later claim generation.
Retries insert new rows rather than rewriting history.

### `claims`
Worker ownership, lease expiry, owner identity, and monotonic generation/fencing
value. The authoritative completion transaction must validate current generation.

### `gates`
Durable Gate state and decision evidence.

### `signals`
Named durable signals with duplicate-safe identity.

### `effects`
Stable effect key, operation identity, request fingerprint/metadata, state,
classification, and reconciliation information.

### `execution_events`
Ordered structured Evidence/event history. Sensitive values are redacted or
omitted before persistence.

## Transaction rules to implement later

- Flow-Version creation is append-only.
- Execution creation and initial Stage materialization are atomic.
- Claim acquisition uses row locking / conditional update semantics.
- Completion validates lease generation in the same transaction that commits
  authoritative state.
- Effect state transitions and relevant execution evidence are transactionally
  consistent where practical.
- Gate decisions are durable before dependent work becomes eligible.
