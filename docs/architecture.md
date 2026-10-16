# V1 architecture

## Decision summary

AegisFlow uses a TypeScript/Node monorepo with PostgreSQL as the single reference durability
substrate for V1. Domain contracts and pure state machines remain independent of PostgreSQL, HTTP
frameworks, model SDKs, connector SDKs, wall-clock time, and randomness.

PR1 introduced `@aegisflow/contracts`; PR2 `@aegisflow/core`; PR3
`@aegisflow/persistence`; PR4 `@aegisflow/queue`; PR5 `@aegisflow/effects`; PR6
`@aegisflow/gates`; and PR7 adds `@aegisflow/providers` for vendor-neutral provider contracts and
durable Agent Stage provider execution.

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
        +------ @aegisflow/providers --> @aegisflow/queue + @aegisflow/effects + pg
```

Persistence does not depend back on authority/runtime services. Providers do not import provider
SDKs or connectors; they compose the immutable Agent contract with worker Claim and Effect
authority.

## Architectural invariants

### PostgreSQL-first durability

PostgreSQL remains the only required durable coordination substrate in V1. PR7 does not introduce
Redis, Kafka, RabbitMQ, NATS, or Kubernetes.

### Authority layers are distinct

- PR4 Worker Claim authority answers which worker may advance Stage work.
- PR5 Effect authority answers whether one logical external side effect may be attempted/replayed.
- PR6 Gate authority answers whether protected Stage work is permitted to acquire worker authority.
- PR7 Provider execution composes worker + Effect authority; it does not become a fourth bypassing authority.

### Agent policy is pinned to the Flow Version

The runtime loads provider ID, instruction, tool allow-list, step budget, and output schema from the
Execution's immutable Flow Version. Callers cannot substitute a second provider policy document.

### Provider calls are external Effects

Every provider step has a stable Effect identity derived from StageExecution + step. A normalized
provider result is persisted before the Effect is marked successful. If a recovered worker finds a
claimed provider Effect without durable result evidence, the outcome is ambiguous and requires
reconciliation rather than replay.

### Worker fencing remains authoritative

The provider runtime acquires a PR4 Claim before planning/calling the provider and refreshes Claim
authority after the external call. A worker that lost its lease/generation cannot silently finish the
Stage; an uncertain provider outcome is quarantined.

### Provider evidence is immutable

`agent_provider_results` is one immutable normalized result per Effect and per StageExecution+step.
PostgreSQL verifies that the StageExecution owns the referenced Effect and rejects UPDATE/DELETE of
the result evidence.

### Tool execution remains outside PR7

Tool requests are normalized and checked against the immutable Agent allow-list, but no tool is
executed. Connector/tool execution begins in PR8. This keeps provider reasoning separate from action
authority.

### Earlier durability invariants remain

Flow Versions stay append-only; Execution bootstrap is atomic; worker Claims retain generation
history and fence stale workers; Effect keys converge duplicates and quarantine ambiguous external
outcomes; Gates fail closed until approved.

## Package roadmap

- `@aegisflow/contracts` — IDs, public domain types, schemas, error taxonomy.
- `@aegisflow/core` — pure state machines and retry/cancellation semantics.
- `@aegisflow/persistence` — PostgreSQL migrations and reference repositories.
- `@aegisflow/queue` — claims, leases, fencing, heartbeat, expiry, recovery.
- `@aegisflow/effects` — durable Effect identity, idempotency, and reconciliation.
- `@aegisflow/gates` — durable human Gate lifecycle and protected-work authority.
- `@aegisflow/providers` — vendor-neutral provider contract + durable Agent provider runtime.
- `@aegisflow/connectors` — future typed external actions.
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
6. Pinned Agent Stage -> provider registry selection and normalized provider request.
7. Provider output -> bounded normalization + deterministic schema/tool validation.
8. Provider invocation -> Effect planning/claim authority and immutable provider-result evidence.
9. Tool request -> future PR8 connector/action authority; PR7 refuses execution.
10. External uncertainty -> reconciliation-required rather than blind retry.

## Current PR7 guarantees

For the PostgreSQL 17 reference target, the executed integration suite demonstrates:

- Agent configuration is recovered from the pinned immutable Flow Version;
- unregistered providers and non-Agent stages fail before worker authority is created;
- provider calls are represented by stable Effects;
- normalized provider evidence is immutable and StageExecution-bound;
- provider result recovery avoids replay after worker failure;
- orphaned in-flight provider calls are quarantined rather than repeated;
- known provider failures and ambiguous outcomes remain distinguishable;
- output-schema mismatch fails the Stage without erasing external provider evidence;
- tool requests are allow-list checked and not executed before PR8;
- migration `0005_agent_provider_results` rolls back/reapplies while PR3–PR6 regression lanes remain green.

PR7 does not claim provider-specific API correctness, credential handling, generic exactly-once model
execution, multi-step tool loops, connector correctness, authentication/RBAC, PostgreSQL-major-version
portability, HA/backup/deployment readiness, production readiness, or SOTA performance.
