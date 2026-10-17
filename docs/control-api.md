# Control API and TypeScript SDK

The Control API is AegisFlow's public control plane. PostgreSQL remains the source of durable truth, while domain execution semantics remain in contracts, core state machines, the Gate ledger, Effect ledger, worker fencing, and scheduler layers.

## Public endpoints

Health:

- `GET /health/live`
- `GET /health/ready`

Flows:

- `POST /v1/flows`
- `GET /v1/flows/:flowId`
- `GET /v1/flows`

Executions:

- `POST /v1/executions`
- `GET /v1/executions/:executionId`
- `POST /v1/executions/:executionId/cancel`
- `GET /v1/executions/:executionId/events`
- `GET /v1/executions/:executionId/effects`
- `GET /v1/executions/:executionId/gates`
- `GET /v1/executions/:executionId/signals`
- `POST /v1/executions/:executionId/signals/:signalName`
- `GET /v1/executions`

Gates:

- `GET /v1/gates/:gateId`
- `GET /v1/gates/pending`
- `POST /v1/gates/:gateId/approve`
- `POST /v1/gates/:gateId/reject`

Effects:

- `GET /v1/effects/:effectId`
- `GET /v1/effects`
- `POST /v1/effects/:effectId/reconcile`

## Idempotent submission

Execution creation requires an `Idempotency-Key`. A durable `(scope, key)` record stores a canonical request digest and the resulting execution identity.

- Same key + same request returns the original execution with replay semantics.
- Same key + different request fails with `IDEMPOTENCY_CONFLICT`.
- Process restart does not erase submission identity.

Signals use the same principle, scoped by execution and signal name.

## Signals

Signals are append-only durable records. When a Signal matches an eligible Signal Stage, the control plane advances the Stage through the deterministic state machine and records evidence. Signals that arrive while the Stage is blocked remain durable for later scheduler consumption.

## Cancellation

Cancellation is monotonic and authority-preserving. Nonterminal Stages are cancelled through the core state machine, worker authority is fenced, waiting Gates are terminalized consistently, and claimed Effects are quarantined rather than stranded.

## Effect reconciliation

The API exposes explicit reconciliation for `RECONCILIATION_REQUIRED` Effects and does not add blind retry semantics. Accepted decisions are `CONFIRMED_SUCCEEDED` and `CONFIRMED_FAILED`.

## SDK

`@aegisflow/sdk` is a typed HTTP client for the public API. It does not access PostgreSQL or private runtime packages. Structured API failures become `AegisFlowSdkError` with HTTP status and AegisFlow error code.

## Security and deployment boundary

The current Control API does not include enterprise authentication, RBAC, SSO, or secrets management. Inputs and identifiers are validated, request bodies are bounded, SQL is parameterized, and malformed path encoding is classified as client input. Until authentication is added, expose the API only on a trusted network or behind an authenticated reverse proxy.
