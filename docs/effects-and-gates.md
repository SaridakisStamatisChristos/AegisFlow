# Effects and Gates

## Effects — implemented in PR5

An Effect is the runtime's durable identity for one logical external side effect.
Every side-effecting connector operation is expected to pass through the Effect
ledger once connectors exist.

Implemented semantics:

1. Stable `effectKey` scoped to the Execution.
2. Durable `PLANNED` state before an external call may be authorized.
3. Canonical JSON intent SHA-256 digest instead of raw connector payload storage.
4. Concurrent same-key/same-intent planning converges on one Effect.
5. Same key with different Stage or intent fails closed.
6. `claimEffect` is the connector-call authority boundary.
7. Success suppresses replay; known failure stays terminal.
8. Ambiguity becomes `RECONCILIATION_REQUIRED` and blocks blind replay.
9. Reconciliation is separate immutable evidence.

AegisFlow does not claim generic exactly-once external execution.

## Gates — implemented in PR6

A Gate is durable human authority, not a Boolean input to an Action.

Implemented semantics:

1. Gate creation is bound to a materialized Gate StageExecution and derives its
   expiry/protection set from the pinned immutable Flow version.
2. Opening moves the Gate Stage into `WAITING` using the PR2 Stage state machine.
3. Approval/rejection persists actor, PostgreSQL time, and bounded JSON evidence.
4. Resolution uses the PR2 Gate state machine; terminal states are never reopened.
5. A duplicate matching decision is idempotent and does not overwrite original
   evidence.
6. A conflicting terminal decision returns a deterministic conflict.
7. Expiry is terminal. A late human decision first commits `EXPIRED`, then fails.
8. Resolution evidence is database-enforced immutable.
9. Dependent work cannot acquire an ACTIVE worker Claim while any protecting Gate
   is not `APPROVED`; PostgreSQL enforces this even against direct Claim insertion.
10. Multiple protecting Gates require unanimous approval.
11. Reconstructing the service after restart reads the same durable terminal Gate
    and resolution evidence.

Gate approval authorizes protected Stage work; it does not itself grant Effect
authority for an external side effect.

## Agent authority

An Agent Stage may request a tool or Action, but model output must still pass
runtime validation and deterministic policy. Future policy can `ALLOW`,
`REQUIRE_GATE`, or `DENY`; the provider itself never grants authority. Protected
work must satisfy Gate authority, worker Claim authority, and—when side effects are
involved—Effect authority at their respective boundaries.
