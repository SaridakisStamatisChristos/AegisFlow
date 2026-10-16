# V1 architecture

## Decision summary

AegisFlow uses a TypeScript/Node monorepo with PostgreSQL as the single reference
durability substrate for V1. Domain contracts and pure state machines remain
independent of PostgreSQL, HTTP frameworks, model SDKs, connector SDKs, wall-clock
time, and randomness.

PR1 introduced `@aegisflow/contracts`. PR2 introduced `@aegisflow/core`. PR3 added
`@aegisflow/persistence`. PR4 added `@aegisflow/queue`. PR5 adds
`@aegisflow/effects`, which composes the pure Effect state machine with durable
identity, idempotency, outcome visibility, and reconciliation evidence.

## Dependency rule

The current enforced package edges are:

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
        |
        +------ @aegisflow/effects --> @aegisflow/core + pg + node:crypto
```

`contracts` imports only relative modules. `core` imports only `contracts` plus
relative modules. `persistence` imports only contracts, PostgreSQL, Node migration
I/O, and relative modules. Queue and Effects may depend on contracts, core,
persistence, and PostgreSQL; Effects additionally uses Node cryptography to digest
canonical intent. Persistence does **not** depend back on queue or effects.

## Architectural invariants

### PostgreSQL-first durability

The target runtime requires transactional ownership, leases, durable Gates,
Signals, Effects, and ordered evidence. PostgreSQL remains the only required durable
coordination substrate in V1; PR5 does not introduce Redis, Kafka, RabbitMQ, NATS,
or Kubernetes.

### Pure domain transitions

PR2 remains authoritative for legal Effect transitions. PR5 calls
`transitionEffect` for `PLANNED -> CLAIMED -> terminal` and never adds a hidden
terminal-state escape hatch. PostgreSQL serializes authority and persistence; it
does not replace the core state machine.

### Worker authority remains separate from Effect authority

PR4 answers **which worker may advance Stage work**. PR5 answers **whether a logical
external side effect may be attempted or replayed**. A worker Claim is therefore
not sufficient authority to repeat an Effect. Later connector execution must hold
both the relevant Stage authority and Effect authority.

### Stable Effect identity

`effectKey` is unique within one Execution. Planning the same key and canonical
intent concurrently converges on one durable Effect. Reusing a key for a different
Stage or intent is rejected instead of silently aliasing two side effects.

### Intent digest instead of raw connector payload

PR5 canonicalizes JSON intent and stores only its SHA-256 digest in the Effect
ledger. This lets duplicate planning prove intent equality without making the
ledger a second store of connector payloads or secrets.

### No generic exactly-once claim

The ledger prevents runtime-level blind replay but cannot make an arbitrary remote
system exactly-once. Future connectors should forward stable idempotency keys or use
provider-native reconciliation where available.

### Ambiguity is quarantined

A connector outcome known to have succeeded becomes `SUCCEEDED`; known failure
becomes `FAILED`; uncertainty becomes `RECONCILIATION_REQUIRED`. The ambiguous state
cannot be claimed again. Reconciliation is written to a separate immutable table,
so confirming what happened externally does not rewrite the original terminal
Effect state.

### Reconciliation does not silently authorize retries

Confirmed success suppresses future replay. Confirmed failure remains visible and
blocked from automatic replay. A future connector/runtime retry policy must be
explicitly designed; PR5 does not reinterpret a terminal failure as fresh authority.

### Immutable Flow Versions and recovery history

Earlier invariants remain: Flow Versions are append-only, Execution bootstrap is
atomic, worker Claims retain historical generations, expired Attempts are timed
out rather than overwritten, and stale workers are fenced.

## Package roadmap

- `@aegisflow/contracts` — IDs, public domain types, schemas, error taxonomy.
- `@aegisflow/core` — pure state machines and retry/cancellation semantics.
- `@aegisflow/persistence` — PostgreSQL migrations and reference repositories.
- `@aegisflow/queue` — claims, leases, fencing, heartbeat, expiry, recovery.
- `@aegisflow/effects` — durable Effect identity, idempotency, and reconciliation.
- `@aegisflow/flows` — graph scheduling and version semantics.
- `@aegisflow/policy` — deterministic allow/require-gate/deny decisions.
- `@aegisflow/gates` — durable human approval lifecycle.
- `@aegisflow/providers` — model provider adapters.
- `@aegisflow/connectors` — typed external actions.
- `@aegisflow/evidence` — higher-level ordered durable execution evidence.
- `@aegisflow/sdk` — public client used by CLI and web.

Applications later consume those packages: API, worker, CLI, then operator web.

## Trust boundaries

1. User/API input -> contract validation.
2. Runtime -> persistence transaction boundary.
3. Worker -> Claim owner + lease + generation fencing authority.
4. Model output -> schema validation + deterministic policy.
5. Policy -> optional durable Gate.
6. Approved Action -> Effect planning + Effect claim authority.
7. Effect-authorized request -> connector/provider-native idempotency surface.
8. External response -> classified success/failure/ambiguous result.
9. Ambiguous response -> immutable reconciliation evidence before replay decisions.
10. Runtime events -> redacted structured Evidence.

## Current PR5 guarantees

For the PostgreSQL 17 reference target, the executed integration suite demonstrates:

- concurrent identical planning converges on one Effect row;
- same `effectKey` with different canonical intent fails closed;
- two concurrent claimers cannot both gain external-call authority;
- successful Effects suppress accidental replay;
- known failures remain terminal and visible;
- ambiguous outcomes become `RECONCILIATION_REQUIRED` and block replay;
- identical reconciliation is idempotent while conflicting reconciliation fails;
- confirmed success suppresses replay without mutating the original terminal state;
- confirmed failure remains blocked from automatic replay;
- two completion writers cannot both resolve one claimed Effect;
- Effect Execution/Stage ownership is enforced;
- reconciliation rows are database-enforced immutable evidence;
- migration `0003_effect_ledger` rolls back/reapplies while preserving PR3/PR4
  regression coverage.

PR5 does **not** claim provider/connector exactly-once behavior, connector-specific
retry policy, durable human Gates, PostgreSQL-major-version portability, HA/backup
readiness, deployment readiness, or production/SOTA performance.
