# Governed connectors and Agent tool execution

`@aegisflow/connectors` executes approved external tools under existing worker, Gate, and Effect authority. The connector registry is an execution adapter, not a new authority layer.

Every Agent tool call has a stable Effect identity derived from StageExecution ID, provider step number, and provider tool-call ID. Effect intent includes tool name, authority scope, and normalized input, but never injected connector credentials.

## Built-in connectors

### `http.request`

The generic HTTP connector:

- requires an operator-configured HTTPS origin allow-list;
- permits `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`;
- rejects Agent-supplied credential/transport headers such as `authorization`, `cookie`, `host`, and `content-length`;
- rejects GET bodies;
- rejects redirects;
- bounds timeouts and captured response evidence;
- treats transport uncertainty as ambiguous rather than safely retryable.

A non-2xx HTTP response is durable response evidence, not a transport exception.

### `github.request`

The GitHub connector:

- is fixed to `https://api.github.com`;
- injects the operator-provided bearer token;
- requires approved API path prefixes;
- validates normalized request paths before transport;
- rejects network-path/origin escape attempts;
- captures `x-github-request-id` when available.

Token permissions remain an external GitHub security boundary.

### `slack.postMessage`

The Slack connector:

- is fixed to `https://slack.com/api/chat.postMessage`;
- injects the operator-provided bearer token;
- requires an allowed-channel set;
- rejects messages outside that set before transport;
- validates bounded text/thread input;
- records the Slack message timestamp as external-reference evidence when returned.

## Durable result order

For a connector call, AegisFlow:

1. plans the stable Effect;
2. claims Effect authority;
3. calls the connector;
4. normalizes and persists immutable tool-result evidence;
5. closes the Effect only after durable evidence exists.

If durable evidence exists during worker recovery, it is reused and the connector is not called again. A claimed tool Effect with no result evidence becomes `RECONCILIATION_REQUIRED`; it is never blindly replayed.

## Agent tool loop

The Agent runtime loads policy from the pinned Flow Version, acquires worker authority, executes provider steps under stable Effects, validates all requested tools before external execution, runs tools through governed connectors, fences worker authority around tool execution, feeds durable tool results into later provider steps, enforces `maxSteps`, validates final output, and completes the worker Claim.

## Security boundary

Connectors do not provide user identity/RBAC, credential lifecycle management, or exactly-once guarantees inside external services. Those concerns remain explicit external or higher-level boundaries.
