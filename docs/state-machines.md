# State-machine specification

PR2 implements these rules as pure deterministic functions in `@aegisflow/core`.
A transition consumes only its current state and an explicit event. It performs no
I/O, reads no clock, draws no randomness, and mutates no caller-owned object.
Invalid transitions fail closed with a typed runtime error.

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

`SUCCEEDED`, `FAILED`, and `CANCELLED` are terminal. Cancellation is monotonic.
`WAITING` means durable external progress is required; it is not a worker-liveness
state. Persistence of that wait begins in PR3.

## Stage execution

States: `BLOCKED`, `READY`, `RUNNING`, `WAITING`, `SUCCEEDED`, `FAILED`, `SKIPPED`,
`CANCELLED`.

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

`SUCCEEDED`, `FAILED`, `SKIPPED`, and `CANCELLED` are terminal. A Stage can be
skipped only before work starts. Dependency satisfaction and propagation of
ready/skipped states across the Flow graph belong to the later `flows` package.

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

All other states are terminal. Retry never reopens an Attempt. `nextAttemptSequence`
allocates a new positive safe-integer sequence, so prior attempts remain immutable
history. Lease generations and stale-worker fencing remain PR4 scope.

## Gate

States: `WAITING`, `APPROVED`, `REJECTED`, `EXPIRED`.

`APPROVE`, `REJECT`, and `EXPIRE` resolve a waiting Gate. Repeating the identical
decision against its already-resolved state is idempotent (`changed: false`). A
conflicting later decision fails with `GATE_DECISION_CONFLICT`. All resolved Gate
states are terminal. Durable Gate records remain PR6 scope.

## Effect

States: `PLANNED`, `CLAIMED`, `SUCCEEDED`, `FAILED`, `RECONCILIATION_REQUIRED`.

`PLANNED --CLAIM--> CLAIMED`. From `CLAIMED`, an Effect can `SUCCEED`, `FAIL`, or
`REQUIRE_RECONCILIATION`. All three outcomes are terminal in the PR2 pure machine.
In particular, `RECONCILIATION_REQUIRED` has no automatic transition back to
`CLAIMED`; this encodes the no-blind-replay invariant. Durable idempotency keys,
reconciliation attempts, and external execution belong to PR5.

## Decision branch resolution

PR2 does not introduce an expression language. Given a declared unique choice list
and one selected choice, `resolveDecisionBranch` deterministically returns that
choice plus the sibling choices to skip, preserving declaration order. It performs
no graph mutation. Graph reachability and dependency propagation remain later
`flows` responsibilities.
