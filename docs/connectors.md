# Governed connectors and Agent tool execution

PR8 introduces `@aegisflow/connectors` and a tool-aware Agent execution path for the PostgreSQL 17 reference runtime.

## Authority model

Connector execution does not create a new authority layer. A tool call must already be inside an Agent Stage that holds PR4 worker Claim authority, and each external call is represented by PR5 Effect authority. PR6 Gate protection remains upstream of worker Claim acquisition. The connector registry is therefore an execution adapter under existing durable authority, not a bypass around it.

Every Agent tool call has a stable Effect identity derived from:

- StageExecution ID;
- provider step number;
- provider tool-call ID.

The Effect intent includes the immutable tool name, authority scope and normalized input. It does not contain injected connector credentials.

## Built-in connectors

### `http.request`

The generic HTTP connector:

- requires a non-empty operator-configured HTTPS origin allow-list;
- permits `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`;
- rejects credential/transport headers supplied by Agent tool input (`authorization`, `cookie`, `proxy-authorization`, `host`, `content-length`, `transfer-encoding`);
- rejects GET bodies;
- uses `redirect: error` so an approved origin cannot silently redirect to another destination;
- bounds timeout to 1–120000 ms;
- bounds captured response evidence to 1 MiB;
- treats transport uncertainty as an ambiguous outcome rather than a known retryable failure.

A non-2xx HTTP response is durable response evidence, not a transport exception. Higher-level policy may interpret the returned status/body.

### `github.request`

The GitHub connector:

- is fixed to `https://api.github.com`;
- injects the operator-provided bearer token; Agent input cannot replace it;
- requires a non-empty set of allowed API path prefixes;
- enforces the normalized request path against those prefixes before transport;
- rejects network-path/origin escape attempts;
- accepts only scalar query values;
- captures `x-github-request-id` when available.

Token permissions remain an external GitHub security boundary. PR8 does not implement organization RBAC or credential rotation.

### `slack.postMessage`

The Slack connector:

- is fixed to `https://slack.com/api/chat.postMessage`;
- injects the operator-provided bearer token;
- requires a non-empty allowed-channel set;
- rejects messages to channels outside that set before transport;
- validates bounded text and thread timestamp input;
- records the Slack message timestamp as external-reference evidence when returned.

## Durable result order

For a connector call, AegisFlow performs this order:

1. plan the stable Effect;
2. claim Effect authority;
3. call the connector;
4. normalize and persist immutable `agent_tool_results` evidence;
5. only then mark the Effect `SUCCEEDED`.

`agent_tool_results` is database-enforced immutable. PostgreSQL verifies that the referenced Effect belongs to the same StageExecution and is `CLAIMED` at insert time.

If durable evidence exists during worker recovery, it is reused and the connector is not called again. If recovery finds a claimed tool Effect with no result evidence, the Effect becomes `RECONCILIATION_REQUIRED`; AegisFlow does not blindly replay it.

Known connector rejection maps to a durable failed Effect. Transport/remote uncertainty maps to reconciliation-required authority.

## Agent tool loop

When a connector registry is supplied to `PostgresAgentRuntime`, PR8 enables bounded provider → tool → provider execution:

1. load Agent policy from the Execution's immutable Flow Version;
2. acquire PR4 worker Claim authority;
3. execute one provider step under its stable provider Effect;
4. if tool calls are returned, validate **all** tool names against the immutable Agent allow-list and connector registry before executing the first side effect;
5. execute each tool through the durable connector Effect runtime;
6. heartbeat/fence worker authority around tool execution;
7. feed durable tool results into the next provider request;
8. stop at immutable `maxSteps`;
9. validate final output schema and complete the worker Claim.

If `PostgresAgentRuntime` is constructed without a connector registry, the PR7 behavior remains: tool requests are validated but execution fails closed.

## Failure boundaries

PR8 deliberately does not claim:

- exactly-once execution by the external HTTP/GitHub/Slack service;
- automatic reconciliation of ambiguous outcomes;
- provider-specific or SaaS-specific authentication lifecycle management;
- application-level interpretation of arbitrary HTTP status bodies;
- authenticated AegisFlow user identity or RBAC;
- Control API, SDK, CLI, UI, notification delivery, HA/backup, or production deployment readiness;
- arbitrary direct `ActionStage` scheduling/orchestration beyond the connector/tool runtime delivered here;
- SOTA performance.

The repository still has no committed `package-lock.json`; executable/config/test artifact closure therefore does not freeze the transitive dependency graph.
