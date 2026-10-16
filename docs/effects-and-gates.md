# Effects and Gates

## Effects — implemented in PR5

An Effect is the runtime's durable identity for one logical external side effect.
Every side-effecting connector operation is expected to pass through the Effect
ledger once connectors exist.

Implemented semantics:

1. The runtime derives or receives a stable `effectKey` scoped to the Execution.
2. `planEffect` persists `PLANNED` before an external call may be authorized.
3. Canonical JSON intent is SHA-256 digested; the ledger stores the digest, not the
   raw connector payload.
4. Concurrent planning of the same key and same intent converges on one Effect.
5. The same key with a different Stage or intent is a deterministic conflict.
6. `claimEffect` is the authority boundary before a connector call. Two concurrent
   claimers cannot both acquire the `PLANNED -> CLAIMED` transition.
7. Known success becomes `SUCCEEDED` and suppresses replay.
8. Known failure becomes `FAILED` and remains visible/terminal; PR5 does not
   silently reopen it for retry.
9. Ambiguous outcomes become `RECONCILIATION_REQUIRED` and cannot be blindly
   repeated.
10. Reconciliation is a separate immutable record. Confirmed success suppresses
    replay; confirmed failure remains blocked from automatic replay.
11. Two completion writers cannot both authoritatively resolve one claimed Effect.

AegisFlow does **not** claim generic exactly-once external execution. The ledger
prevents duplicate authority inside AegisFlow, but future connectors should also use
provider-native idempotency keys, lookup APIs, or reconciliation primitives where
available.

### Retry boundary

PR2 declares `FAILED` and `RECONCILIATION_REQUIRED` terminal Effect states. PR5
preserves that invariant. Connector-specific retry policy is deliberately not
implemented here because doing so by mutating a terminal Effect would create a
second, contradictory state machine. A later runtime policy may introduce explicit
retry lineage only after its semantics are specified and adversarially tested.

## Gates — PR6

A Gate is a durable approval primitive, not a Boolean input to an Action.

Required semantics for the next slice:

- unresolved Gate -> dependent protected work cannot run;
- approval/rejection persists with actor/time/evidence metadata;
- same duplicate decision is idempotent;
- conflicting duplicate decision returns a deterministic conflict;
- expiry is terminal;
- restart or worker replacement does not lose the Gate decision.

## Agent authority

An Agent Stage may request a tool or Action, but the request must still pass
runtime validation and deterministic policy. Policy can `ALLOW`, `REQUIRE_GATE`,
or `DENY`. The provider itself never grants authority. Even after policy approval,
a side-effecting connector call must acquire Effect authority before execution.
