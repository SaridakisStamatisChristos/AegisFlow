# Effect ledger authority

## Purpose

PR5 introduces `@aegisflow/effects`, the durable authority boundary for external
side effects. It answers a different question from PR4 worker claims:

- worker Claim: **which worker may advance this Stage?**
- Effect ledger: **may this logical external side effect be attempted or replayed?**

A later connector call must satisfy both relevant authority boundaries.

## Durable identity

An Effect is identified by a caller-supplied opaque Effect ID and a stable
`effectKey`. The database enforces `UNIQUE (execution_id, effect_key)`.

`planEffect` also computes a SHA-256 digest of canonical JSON intent. Object keys are
sorted recursively, non-JSON/non-finite values are rejected, nesting and aggregate
size are bounded, and only the digest is persisted. This gives the ledger a way to
detect accidental reuse of the same key for different intent without persisting a
second copy of potentially sensitive connector input.

Concurrent identical planners use `INSERT ... ON CONFLICT DO NOTHING` plus locked
readback. They converge on the stored Effect. If the stored Stage or intent digest
differs, planning fails with `KEY_CONFLICT`.

## State authority

The PR2 Effect state machine remains authoritative:

```text
PLANNED --CLAIM--> CLAIMED
CLAIMED --SUCCEED--> SUCCEEDED
CLAIMED --FAIL--> FAILED
CLAIMED --REQUIRE_RECONCILIATION--> RECONCILIATION_REQUIRED
```

`SUCCEEDED`, `FAILED`, and `RECONCILIATION_REQUIRED` remain terminal.

### `claimEffect`

The Effect row is locked before authority is evaluated.

- `PLANNED` -> atomically becomes `CLAIMED` and returns connector-call authority.
- `CLAIMED` -> `IN_FLIGHT`; another caller already owns the one transition.
- `SUCCEEDED` -> returns `SUPPRESSED_SUCCEEDED`; do not call externally again.
- `FAILED` -> `KNOWN_FAILED`; PR5 does not automatically replay it.
- `RECONCILIATION_REQUIRED` without reconciliation -> blocks with
  `RECONCILIATION_REQUIRED`.
- ambiguous + confirmed success -> `SUPPRESSED_SUCCEEDED`.
- ambiguous + confirmed failure -> `KNOWN_FAILED`.

### `completeEffect`

Only a locked `CLAIMED` Effect can complete. The caller classifies the observed
outcome as:

- `SUCCEEDED`;
- `FAILED`;
- `AMBIGUOUS`.

The ledger stores only a bounded result classification code and optional external
reference. It does not persist arbitrary response bodies. Concurrent completion
writers serialize on the row; after one commits, the other observes a terminal
state and fails with `STALE_STATE`.

## Reconciliation

Ambiguity is not a retry signal. It is a requirement to determine what happened at
the external system.

`effect_reconciliations` stores one immutable decision per ambiguous Effect:

- `CONFIRMED_SUCCEEDED`;
- `CONFIRMED_FAILED`.

The record also contains a bounded reconciler identifier, optional external
reference, and database timestamp. A PostgreSQL trigger rejects update/delete.

Identical duplicate reconciliation is idempotent at the API layer. A conflicting
second reconciliation fails deterministically.

The original Effect remains `RECONCILIATION_REQUIRED`; reconciliation does not
rewrite history or bypass PR2 terminal-state monotonicity.

## Exactly-once boundary

PR5 does not claim exactly-once execution against arbitrary external systems.
AegisFlow can prevent itself from authorizing a known duplicate, but a process may
still fail after the provider commits and before the runtime observes the response.
That case is why `RECONCILIATION_REQUIRED` exists.

Future connectors should, where possible:

1. send the stable Effect key as the provider's idempotency key;
2. persist provider request/reference identifiers as bounded metadata;
3. query the provider after ambiguous failure;
4. write immutable reconciliation evidence before deciding what comes next.

## Retry boundary

PR5 intentionally does not implement automatic retries of a terminal failed Effect.
Doing so would require an explicit retry-lineage model that preserves the stable
logical Effect identity while representing multiple externally authorized attempts.
That mechanism is outside PR5 and must not be approximated by mutating a terminal
Effect back to `PLANNED`.

## Evidence and limits

The PostgreSQL 17 integration suite exercises concurrent planning, key/intent
collision, concurrent claim, success suppression, known-failure blocking,
ambiguity quarantine, success/failure reconciliation, reconciliation conflicts,
concurrent completion, Stage/Execution ownership, reconciliation immutability, and
invalid-input non-mutation.

It does not validate a real external provider, connector-native idempotency,
network-partition recovery against a provider, or production throughput.
