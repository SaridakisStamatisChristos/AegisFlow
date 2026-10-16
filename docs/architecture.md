# V1 architecture

## Decision summary

AegisFlow uses a TypeScript/Node monorepo with PostgreSQL as the single reference
durability substrate for V1. Domain contracts and pure state machines remain
independent of PostgreSQL, HTTP frameworks, model SDKs, connector SDKs, wall-clock
time, and randomness.

PR1 introduced `@aegisflow/contracts`; PR2 `@aegisflow/core`; PR3
`@aegisflow/persistence`; PR4 `@aegisflow/queue`; PR5 `@aegisflow/effects`; and PR6
adds `@aegisflow/gates` for durable human approval authority and protected-work
enforcement.

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
        |
        +------ @aegisflow/effects --> @aegisflow/core + pg + node:crypto
```

`contracts` imports only relative modules. `core` imports only `contracts` plus
relative modules. `persistence` imports only contracts, PostgreSQL, Node migration
I/O, and relative modules. Queue, Effects, and Gates may depend on contracts, core,
persistence, and PostgreSQL; Effects additionally uses Node cryptography.
Persistence does not depend back on those authority services.

## Architectural invariants

### PostgreSQL-first durability

PostgreSQL remains the only required durable coordination substrate in V1. PR6 does
not introduce Redis, Kafka, RabbitMQ, NATS, or Kubernetes.

### Pure domain transitions remain authoritative

PR2 defines legal Gate and StageExecution transitions. PR6 composes those functions
with PostgreSQL transactions and constraints; it does not introduce a hidden Gate
state machine or terminal-state escape hatch.

### Authority layers are distinct

- PR4 Worker Claim authority answers which worker may advance Stage work.
- PR5 Effect authority answers whether one logical external side effect may be
  attempted/replayed.
- PR6 Gate authority answers whether protected Stage work is permitted to acquire
  worker authority.

Approval therefore does not execute work and does not replace Effect authority.

### Gate policy is pinned to the Flow version

Opening a Gate loads the Execution's immutable Flow definition and verifies the
materialized Stage is type `gate`. Deadline configuration and protected direct
dependents come from that pinned definition, not caller input.

### Protected work is fail-closed

`gate_protections` may link several Gates to one StageExecution. PostgreSQL rejects
an `ACTIVE` Claim whenever any protecting Gate is not `APPROVED`. This remains true
even if a caller bypasses the Gate service and writes through the Claim surface
directly.

### Human resolution evidence is immutable

Approval/rejection stores an opaque actor ID, bounded JSON evidence, and database
time. Expiry stores system evidence. One trigger rejects UPDATE/DELETE of resolution
rows. Authentication and authorization of those actor IDs are deliberately outside
PR6.

### Database clock decides Gate deadlines

Gate deadlines use PostgreSQL `clock_timestamp()`. A decision arriving after the
deadline cannot win merely because no expiry sweeper ran first: PR6 expires the
locked Gate transactionally before returning a conflict to the late decision.

### Earlier durability invariants remain

Flow Versions stay append-only; Execution bootstrap is atomic; worker Claims retain
generation history and fence stale workers; Effect keys converge duplicates and
quarantine ambiguous external outcomes.

## Package roadmap

- `@aegisflow/contracts` — IDs, public domain types, schemas, error taxonomy.
- `@aegisflow/core` — pure state machines and retry/cancellation semantics.
- `@aegisflow/persistence` — PostgreSQL migrations and reference repositories.
- `@aegisflow/queue` — claims, leases, fencing, heartbeat, expiry, recovery.
- `@aegisflow/effects` — durable Effect identity, idempotency, and reconciliation.
- `@aegisflow/gates` — durable human Gate lifecycle and protected-work authority.
- `@aegisflow/flows` — future graph scheduling and version semantics.
- `@aegisflow/policy` — future deterministic allow/require-gate/deny decisions.
- `@aegisflow/providers` — model provider adapters.
- `@aegisflow/connectors` — typed external actions.
- `@aegisflow/evidence` — higher-level ordered durable execution evidence.
- `@aegisflow/sdk` — public client used by CLI and web.

## Trust boundaries

1. User/API input -> contract validation.
2. Runtime -> persistence transaction boundary.
3. Human decision -> Gate row lock + immutable resolution evidence.
4. Gate approval -> protected Stage becomes eligible for worker Claim authority.
5. Worker -> Claim owner + lease + generation fencing authority.
6. Model output -> future schema validation + deterministic policy.
7. Side-effecting Stage -> Effect planning + Effect claim authority.
8. Effect-authorized request -> future connector/provider-native idempotency surface.
9. External response -> success/failure/ambiguity classification and reconciliation.
10. Runtime events -> redacted structured Evidence.

## Current PR6 guarantees

For the PostgreSQL 17 reference target, the executed integration suite demonstrates:

- Gate creation only on a Gate Stage and policy derivation from the pinned Flow;
- direct dependents become protected durable StageExecutions;
- approval/rejection/expiry remains monotonic and aligned with Gate Stage state;
- matching duplicate approval is idempotent without overwriting evidence;
- concurrent conflicting decisions produce one winner and one deterministic conflict;
- a deadline that elapsed before a human decision becomes durable `EXPIRED` first;
- Gate resolution evidence rejects database UPDATE/DELETE;
- invalid actor/evidence fails before durable Gate mutation;
- queue Claim authority is blocked until all protecting Gates are approved;
- direct SQL Claim bypass is also rejected;
- multiple Gates require unanimous approval;
- replacement service instances reconstruct durable terminal decisions;
- migration `0004_durable_gates` rolls back/reapplies while preserving PR3–PR5
  regression coverage.

PR6 does not claim authenticated human identity, RBAC/policy correctness,
notifications/UI, provider/connector correctness, general graph-scheduler behavior,
continuous expiry-sweeper latency, PostgreSQL-major-version portability, HA/backup
readiness, deployment readiness, or production/SOTA performance.
