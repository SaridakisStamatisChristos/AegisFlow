# Effect ledger authority

`@aegisflow/effects` is the durable authority boundary for external side effects. Worker Claims answer **which worker may advance a Stage**; the Effect ledger answers **whether one logical external side effect may be attempted, suppressed, or quarantined**.

## Durable identity

An Effect has an opaque ID and a stable `effectKey`. PostgreSQL enforces uniqueness of `(execution_id, effect_key)`.

`planEffect` computes a SHA-256 digest of canonical JSON intent. Object keys are sorted recursively; non-JSON/non-finite values, excessive nesting, and oversized payloads are rejected. Only the digest is persisted in the ledger.

Concurrent identical planners converge on the stored Effect. Reusing the same key for a different Stage or intent fails with `KEY_CONFLICT`.

## State authority

```text
PLANNED --CLAIM--> CLAIMED
CLAIMED --SUCCEED--> SUCCEEDED
CLAIMED --FAIL--> FAILED
CLAIMED --REQUIRE_RECONCILIATION--> RECONCILIATION_REQUIRED
```

`SUCCEEDED`, `FAILED`, and `RECONCILIATION_REQUIRED` are terminal.

### Claiming

- `PLANNED` becomes `CLAIMED` and grants external-call authority.
- `CLAIMED` reports an in-flight operation.
- `SUCCEEDED` suppresses duplicate execution.
- `FAILED` remains known-failed unless an explicit higher-level retry lineage is introduced.
- `RECONCILIATION_REQUIRED` blocks replay until durable reconciliation evidence exists.

### Completion

Only a locked `CLAIMED` Effect can complete. Observed outcomes are classified as `SUCCEEDED`, `FAILED`, or ambiguous. The ledger stores bounded classification/reference metadata, not arbitrary response bodies.

## Reconciliation

Ambiguity is not a retry signal. `effect_reconciliations` stores one immutable decision per ambiguous Effect:

- `CONFIRMED_SUCCEEDED`;
- `CONFIRMED_FAILED`.

Identical duplicate reconciliation is idempotent; a conflicting decision fails deterministically. The original Effect remains historically `RECONCILIATION_REQUIRED`.

## Exactly-once boundary

AegisFlow prevents itself from authorizing known duplicates, but cannot guarantee exactly-once behavior inside arbitrary external systems. A remote service may commit while the runtime loses the response. That uncertainty is why explicit reconciliation exists.

Connectors should use provider-native idempotency keys where available and preserve provider request/reference identifiers as bounded evidence.

## Cancellation and authority loss

If worker authority is lost after an external call or a Stage is cancelled while an Effect remains claimed, the Effect is quarantined for reconciliation rather than left indefinitely authoritative or blindly replayed.
