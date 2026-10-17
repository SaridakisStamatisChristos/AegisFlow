# Control API and TypeScript SDK

PR9 adds AegisFlow's first public control plane. The API is intentionally small and dependency-light: the HTTP adapter uses Node's built-in server, while PostgreSQL remains the source of durable truth. Domain execution semantics continue to live in the existing contracts, core state machines, Gate ledger, Effect ledger, and worker fencing mechanisms.

## Public endpoints

Health:

- `GET /health/live`
- `GET /health/ready`

Flows:

- `POST /v1/flows` — validate and register a Flow definition; identical latest definitions are stable replays, changed definitions create the next immutable Flow Version.
- `GET /v1/flows/:flowId` — inspect the Flow and all immutable versions.

Executions:

- `POST /v1/executions` — start an execution pinned to either the requested Flow Version or the latest version.
- `GET /v1/executions/:executionId`
- `POST /v1/executions/:executionId/cancel`
- `GET /v1/executions/:executionId/events`
- `GET /v1/executions/:executionId/effects`
- `GET /v1/executions/:executionId/gates`
- `GET /v1/executions/:executionId/signals`
- `POST /v1/executions/:executionId/signals/:signalName`

Gates:

- `GET /v1/gates/:gateId`
- `POST /v1/gates/:gateId/approve`
- `POST /v1/gates/:gateId/reject`

Effects:

- `GET /v1/effects/:effectId`
- `POST /v1/effects/:effectId/reconcile`

## Idempotent submission semantics

Execution creation requires an `Idempotency-Key` header. A durable `(scope, key)` record stores a canonical request digest and the created execution identity.

- Repeating the same key with the same canonical request returns the original execution with `replayed: true`.
- Reusing the key with a different Flow or Flow Version fails closed with `IDEMPOTENCY_CONFLICT`.
- The ledger is PostgreSQL-backed, so process restart does not erase submission identity.

Signals use the same principle, scoped by execution and signal name. Duplicate delivery of the same key and payload returns the original durable Signal; a conflicting payload fails closed.

## Durable Signals

Signals are append-only records containing identity, execution, name, idempotency key, request digest, bounded JSON payload, and creation time. Database triggers reject Signals for missing Executions and reject update/delete mutation.

The migration deliberately validates the execution reference with an insert trigger instead of a foreign key. Existing PR1–PR8 integration suites intentionally truncate core tables independently; a new FK would introduce a hidden truncation dependency and regress those suites. AegisFlow does not expose execution deletion, and Signal rows are immutable, so insert-time validation preserves the V1 integrity boundary without weakening normal runtime semantics.

When a Signal matches a materialized `signal` Stage that is already `READY` or `WAITING`, the control service advances that Stage through the existing deterministic state machine and records `signal.received` evidence. Signals arriving before a blocked stage becomes eligible remain durable for later runtime consumption.

## Cancellation semantics

Cancellation is monotonic and authority-preserving.

- Terminal successful/failed Executions cannot be silently reopened or rewritten as cancelled.
- Repeated cancellation of an already-cancelled Execution is deterministic.
- Nonterminal Stage executions are cancelled through the existing state machine.
- Active worker Claims are fenced by terminalizing the associated Attempt where possible and marking the Claim non-authoritative before the Stage is cancelled.
- A `WAITING` human Gate cannot remain actionable after its Execution is cancelled. It is durably terminalized as `EXPIRED`, its Gate Stage becomes `FAILED`, and immutable Gate resolution evidence records `reason: execution_cancelled`.

This preserves the existing Gate invariant that Gate state and Gate Stage state must agree.

## Effect reconciliation

The API exposes Effect inspection and explicit reconciliation of `RECONCILIATION_REQUIRED` Effects. It does not add blind retry semantics. Reconciliation continues to use the existing append-only Effect ledger and accepts only `CONFIRMED_SUCCEEDED` or `CONFIRMED_FAILED` decisions.

## SDK

`@aegisflow/sdk` is a typed HTTP client for the public API. It does not reach into PostgreSQL or private runtime packages. This is the same boundary the PR10 CLI is expected to use.

The SDK covers Flow registration/inspection, execution start/inspection/cancellation, events, Effects, Gates, Signals, Gate decisions, and Effect reconciliation. Structured API failures become `AegisFlowSdkError` with HTTP status and AegisFlow error code.

## Security and deployment boundary

PR9 does not add enterprise authentication, RBAC, SSO, secrets management, or billing. Those remain later product concerns. The control API validates identifiers and JSON inputs, caps request bodies at 1 MiB, uses parameterized SQL, and does not put Signal payloads into execution evidence.

Until an authentication layer is deliberately added, deployments must expose the control API only inside an appropriate trusted network or behind a separately authenticated reverse proxy. This is an explicit V1 limitation, not an implicit security claim.
