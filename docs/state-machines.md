# State-machine specification

The state machines in `@aegisflow/core` are pure deterministic functions. A transition consumes only current state and an explicit event. It performs no I/O, reads no clock, draws no randomness, and mutates no caller-owned object. Invalid transitions fail closed with typed runtime errors.

## Execution

States: `PENDING`, `RUNNING`, `WAITING`, `SUCCEEDED`, `FAILED`, `CANCELLED`.

| From | Event | To |
| --- | --- | --- |
| `PENDING` | `START` | `RUNNING` |
| `PENDING` | `CANCEL` | `CANCELLED` |
| `RUNNING` | `WAIT` | `WAITING` |
| `RUNNING` | `SUCCEED` | `SUCCEEDED` |
| `RUNNING` | `FAIL` | `FAILED` |
| `RUNNING` | `CANCEL` | `CANCELLED` |
| `WAITING` | `RESUME` | `RUNNING` |
| `WAITING` | `FAIL` | `FAILED` |
| `WAITING` | `CANCEL` | `CANCELLED` |

`SUCCEEDED`, `FAILED`, and `CANCELLED` are terminal. Cancellation is monotonic. `WAITING` represents durable external progress, not worker liveness.

## Stage execution

States: `BLOCKED`, `READY`, `RUNNING`, `WAITING`, `SUCCEEDED`, `FAILED`, `SKIPPED`, `CANCELLED`.

| From | Event | To |
| --- | --- | --- |
| `BLOCKED` | `UNBLOCK` | `READY` |
| `BLOCKED` | `SKIP` | `SKIPPED` |
| `BLOCKED` | `CANCEL` | `CANCELLED` |
| `READY` | `START` | `RUNNING` |
| `READY` | `SKIP` | `SKIPPED` |
| `READY` | `CANCEL` | `CANCELLED` |
| `RUNNING` | `WAIT` | `WAITING` |
| `RUNNING` | `SUCCEED` | `SUCCEEDED` |
| `RUNNING` | `FAIL` | `FAILED` |
| `RUNNING` | `CANCEL` | `CANCELLED` |
| `WAITING` | `RESUME` | `RUNNING` |
| `WAITING` | `FAIL` | `FAILED` |
| `WAITING` | `CANCEL` | `CANCELLED` |

`SUCCEEDED`, `FAILED`, `SKIPPED`, and `CANCELLED` are terminal. A Stage can be skipped only before work starts. Dependency propagation belongs to `@aegisflow/flows`.

## Attempt

States: `CLAIMED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`.

| From | Event | To |
| --- | --- | --- |
| `CLAIMED` | `START` | `RUNNING` |
| `CLAIMED` | `TIMEOUT` | `TIMED_OUT` |
| `CLAIMED` | `CANCEL` | `CANCELLED` |
| `RUNNING` | `SUCCEED` | `SUCCEEDED` |
| `RUNNING` | `FAIL` | `FAILED` |
| `RUNNING` | `TIMEOUT` | `TIMED_OUT` |
| `RUNNING` | `CANCEL` | `CANCELLED` |

Terminal Attempts are never reopened. Retry allocates a new Attempt sequence so prior attempts remain immutable history. Worker leases and fencing are handled by `@aegisflow/queue`.

## Gate

States: `WAITING`, `APPROVED`, `REJECTED`, `EXPIRED`.

`APPROVE`, `REJECT`, and `EXPIRE` resolve a waiting Gate. Repeating the identical terminal decision is idempotent; a conflicting later decision fails with `GATE_DECISION_CONFLICT`. Durable Gate authority is handled by `@aegisflow/gates`.

## Effect

States: `PLANNED`, `CLAIMED`, `SUCCEEDED`, `FAILED`, `RECONCILIATION_REQUIRED`.

`PLANNED --CLAIM--> CLAIMED`. From `CLAIMED`, an Effect can `SUCCEED`, `FAIL`, or `REQUIRE_RECONCILIATION`. All three outcomes are terminal in the pure machine. `RECONCILIATION_REQUIRED` has no automatic transition back to `CLAIMED`; this is the no-blind-replay invariant. Durable Effect identity and reconciliation are handled by `@aegisflow/effects`.

## Decision branch resolution

`resolveDecisionBranch` accepts a declared unique choice list and one selected choice, then deterministically returns the selected branch and siblings to skip while preserving declaration order. It performs no graph mutation; graph reachability and dependency propagation remain `@aegisflow/flows` responsibilities.
