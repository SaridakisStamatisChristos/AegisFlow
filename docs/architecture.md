# V1 architecture

## Decision summary

AegisFlow uses a TypeScript/Node monorepo with PostgreSQL as the single reference durability substrate for V1. Domain contracts and pure state machines remain independent of PostgreSQL, HTTP frameworks, model SDKs, connector SDKs, wall-clock time, and randomness.

PR1 introduced `@aegisflow/contracts`; PR2 `@aegisflow/core`; PR3 `@aegisflow/persistence`; PR4 `@aegisflow/queue`; PR5 `@aegisflow/effects`; PR6 `@aegisflow/gates`; PR7 `@aegisflow/providers`; and PR8 adds `@aegisflow/connectors` plus bounded Agent tool execution.

## Dependency rule

```text
@aegisflow/contracts
        ^
        |
@aegisflow/core

@aegisflow/contracts
        ^
        |
@aegisflow/persistence ---> pg / Node filesystem only
        ^
        |\
        | +---- @aegisflow/queue ----> @aegisflow/core + pg
        | +---- @aegisflow/gates ----> @aegisflow/core + pg
        | +---- @aegisflow/effects --> @aegisflow/core + pg + node:crypto
        |
        +------ @aegisflow/connectors --> @aegisflow/effects + pg
                         ^
                         |
        @aegisflow/providers --> @aegisflow/queue + @aegisflow/effects + pg
```

Persistence does not depend back on authority/runtime services. Connectors do not create a parallel side-effect authority layer; they execute under PR5 Effects. Providers compose immutable Agent contracts with worker Claims, provider Effects, and connector execution.

## Architectural invariants

### PostgreSQL-first durability

PostgreSQL remains the only required durable coordination substrate in V1. PR8 does not introduce Redis, Kafka, RabbitMQ, NATS, or Kubernetes.

### Authority layers remain distinct

- PR4 Worker Claim authority answers which worker may advance Stage work.
- PR5 Effect authority answers whether one logical external side effect may be attempted/replayed.
- PR6 Gate authority answers whether protected Stage work is permitted to acquire worker authority.
- PR7/PR8 provider and connector execution compose those authorities; they do not bypass them.

### Agent policy is pinned to the Flow Version

Provider ID, instruction, tool allow-list, step budget, and output schema come from the Execution's immutable Flow Version. A provider-returned tool name is executable only if it is both present in that immutable allow-list and registered in the connector registry.

### Provider and connector calls are external Effects

Every provider step has a stable Effect identity derived from StageExecution + step. Every connector call has a stable Effect identity derived from StageExecution + provider step + tool-call ID.

Normalized provider/tool evidence is persisted before its Effect is marked successful. Recovery reuses durable evidence and quarantines a claimed provider/tool Effect with no durable result as reconciliation-required instead of replaying it.

### Worker fencing remains authoritative across external calls

The Agent runtime acquires a PR4 Claim before provider/tool execution and refreshes authority around external calls. A stale worker cannot persist provider success or finish the Stage. A targeted PR8 failure injection expires the lease after a provider returns and proves that recovery does not call the provider again.

### Connector credentials and destinations are separate trust inputs

Credentials and transports are injected by operator configuration and are not accepted from Agent tool input or stored in Effect/result evidence.

- Generic HTTP requires HTTPS origins from an explicit allow-list and rejects Agent-supplied credential/transport headers.
- GitHub is fixed to `api.github.com` and requires normalized allowed API path prefixes.
- Slack is fixed to `chat.postMessage` and requires explicit allowed channel IDs.

The textual `authorityScope` is durable evidence context; path/channel/origin enforcement is performed mechanically by each connector.

### Provider/tool evidence is immutable

`agent_provider_results` and `agent_tool_results` are immutable PostgreSQL evidence. Database validation prevents a result from being cross-bound to another StageExecution's Effect.

### Tool turns are bounded and preflighted

For a provider turn returning multiple tools, the runtime checks **all** tool names against the immutable Agent allow-list and connector registry before executing the first tool. The provider → tool → provider loop cannot exceed immutable `maxSteps`.

### Earlier durability invariants remain

Flow Versions stay append-only; Execution bootstrap is atomic; worker Claims retain generation history and fence stale workers; Effect keys converge duplicates and quarantine ambiguous external outcomes; Gates fail closed until approved.

## Package roadmap

- `@aegisflow/contracts` — IDs, public domain types, schemas, error taxonomy.
- `@aegisflow/core` — pure state machines and retry/cancellation semantics.
- `@aegisflow/persistence` — PostgreSQL migrations and reference repositories.
- `@aegisflow/queue` — claims, leases, fencing, heartbeat, expiry, recovery.
- `@aegisflow/effects` — durable Effect identity, idempotency, and reconciliation.
- `@aegisflow/gates` — durable human Gate lifecycle and protected-work authority.
- `@aegisflow/providers` — vendor-neutral provider contract + durable Agent provider/tool loop.
- `@aegisflow/connectors` — governed HTTP/GitHub/Slack connector execution and durable tool-result evidence.
- `@aegisflow/flows` — future general graph scheduling/version orchestration.
- `@aegisflow/policy` — future deterministic allow/require-gate/deny policy layer.
- `@aegisflow/evidence` — future higher-level ordered durable execution evidence.
- `@aegisflow/sdk` — future public client used by CLI and web.

## Trust boundaries

1. User/API input -> contract validation.
2. Runtime -> persistence transaction boundary.
3. Human decision -> Gate row lock + immutable resolution evidence.
4. Gate approval -> protected Stage becomes eligible for worker Claim authority.
5. Worker -> Claim owner + lease + generation fencing authority.
6. Pinned Agent Stage -> provider registry selection and immutable tool allow-list.
7. Provider output -> bounded normalization + schema/tool validation.
8. Provider invocation -> Effect planning/claim authority + immutable provider-result evidence.
9. Tool request -> allow-list + connector-registry preflight.
10. Connector destination -> connector-specific origin/path/channel enforcement.
11. Connector invocation -> Effect planning/claim authority + immutable tool-result evidence.
12. External uncertainty -> reconciliation-required rather than blind retry.

## Current PR8 guarantees

For the PostgreSQL 17 reference target, executed tests demonstrate:

- HTTP/GitHub/Slack connector destination and credential boundaries fail closed;
- tool calls receive stable Effect identities and immutable result evidence;
- duplicate successful tool execution is suppressed;
- conflicting intent under the same stable tool identity fails before another external call;
- known connector rejection and ambiguous external outcome remain distinct;
- recovered claimed tool/provider calls without durable evidence are quarantined, not replayed;
- provider → tool → provider execution passes durable tool output into the next provider step;
- all tools in a turn are preflighted before the first side effect;
- immutable `maxSteps` stops further tool execution;
- worker authority loss after provider return cannot commit success;
- the two-argument PR7 runtime path remains fail-closed for tool execution;
- migration `0006_agent_tool_results` rolls back/reapplies while prior durability/runtime regression lanes remain green.

PR8 does not establish exactly-once behavior inside external services, automatic reconciliation, correctness of arbitrary third-party APIs, authenticated AegisFlow user identity/RBAC, Control API/SDK/CLI/UI, generic direct ActionStage orchestration, PostgreSQL-major-version portability, HA/backup/deployment readiness, production readiness, or SOTA performance.
