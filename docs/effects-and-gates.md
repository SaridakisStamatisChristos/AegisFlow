# Effects and Gates

## Effects

An Effect is the runtime's identity for an external side effect. Every
side-effecting connector operation will eventually pass through the Effect
ledger.

Required semantics:

1. Derive or receive a stable `effectKey` for one logical side effect.
2. Persist `PLANNED` before execution when the runtime can do so safely.
3. Acquire Effect authority before calling the connector.
4. Classify the result as succeeded, failed with declared retry semantics, or
   ambiguous.
5. Ambiguous outcomes become `RECONCILIATION_REQUIRED`; they are not blindly
   repeated.
6. A prior `SUCCEEDED` Effect suppresses accidental replay of the same logical
   Effect.

AegisFlow does not claim generic exactly-once external execution.

## Gates

A Gate is a durable approval primitive, not a Boolean input to an Action.

Required semantics:

- unresolved Gate -> dependent protected work cannot run;
- approval/rejection persists with actor/time/evidence metadata;
- same duplicate decision is idempotent;
- conflicting duplicate decision returns a deterministic conflict;
- expiry is terminal;
- restart or worker replacement does not lose the Gate decision.

## Agent authority

An Agent Stage may request a tool or Action, but the request must still pass
runtime validation and deterministic policy. Policy can `ALLOW`, `REQUIRE_GATE`,
or `DENY`. The provider itself never grants authority.
