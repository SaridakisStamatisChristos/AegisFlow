# V1 architecture

## Decision summary

AegisFlow uses a TypeScript/Node monorepo with PostgreSQL as the single reference
durability substrate for V1. Domain contracts and pure state machines remain
independent of PostgreSQL, HTTP frameworks, model SDKs, connector SDKs, wall-clock
time, and randomness.

PR1 introduced `@aegisflow/contracts`. PR2 introduced `@aegisflow/core`. PR3 added
`@aegisflow/persistence`. PR4 adds `@aegisflow/queue`, which composes core transition
semantics with PostgreSQL transactions to establish worker authority without moving
workflow semantics into the database adapter.

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
        |
@aegisflow/queue -------> @aegisflow/core + pg
```

`contracts` imports only relative modules. `core` imports only `contracts` plus
relative modules. `persistence` imports only `contracts`, PostgreSQL, Node migration
I/O, and relative modules. `queue` may depend on contracts, core, persistence, and
PostgreSQL. Persistence does **not** depend on queue.

## Architectural invariants

### PostgreSQL-first durability

The target runtime requires transactional ownership, leases, durable Gates,
Signals, Effects, and ordered evidence. PostgreSQL remains the only required durable
coordination substrate in V1; PR4 does not introduce Redis, Kafka, RabbitMQ, NATS,
or Kubernetes.

### Pure domain transitions

PR2 remains authoritative for legal Attempt and StageExecution transitions. PR4
uses those transition functions while PostgreSQL supplies serialization, durable
leases, and fencing. The queue does not invent a second state-machine policy.

### Immutable Flow Versions and atomic bootstrap

Flow Versions remain append-only and database-protected. Execution creation plus
initial Stage materialization stays one transaction.

### Worker authority is explicit

A Claim is durable authority for exactly one Attempt on one StageExecution. Claims
carry owner, lease expiry, and a monotonically increasing generation. The database
allows only one `ACTIVE` Claim per Stage. Completion must match the live
StageExecution, Attempt, owner, generation, and unexpired lease.

### Recovery preserves history

A recovered expired Claim is retained as `EXPIRED`; its Attempt becomes
`TIMED_OUT`. The replacement worker gets a new Attempt sequence and a larger
fencing generation. Earlier workers therefore remain observable but cannot regain
authority.

### Database clock for leases

Lease expiry and heartbeat extension use PostgreSQL `clock_timestamp()`. Worker
wall clocks do not decide authority.

### Consistent lock order

Claim, recovery, and completion paths lock durable records in the same conceptual
order: StageExecution -> Claim -> Attempt. This keeps authority changes serialized
and avoids an obvious application-level lock-order inversion.

## Package roadmap

- `@aegisflow/contracts` — IDs, public domain types, schemas, error taxonomy.
- `@aegisflow/core` — pure state machines and retry/cancellation semantics.
- `@aegisflow/persistence` — PostgreSQL migrations and reference repositories.
- `@aegisflow/queue` — claims, leases, fencing, heartbeat, expiry, recovery.
- `@aegisflow/flows` — graph scheduling and version semantics.
- `@aegisflow/policy` — deterministic allow/require-gate/deny decisions.
- `@aegisflow/effects` — idempotency and reconciliation ledger.
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
6. Approved Action -> Effect ledger -> connector.
7. External response -> classified success/failure/ambiguous result.
8. Runtime events -> redacted structured Evidence.

## Current PR4 guarantees

For the PostgreSQL 17 reference target, the executed integration suite demonstrates:

- concurrent claimers produce exactly one authoritative worker;
- only the matching live owner/Attempt/generation can heartbeat or complete;
- an expired lease cannot be resurrected by heartbeat or completion;
- recovery times out the abandoned Attempt before issuing a higher generation;
- stale completion after recovery is rejected;
- two concurrent finishers cannot both authoritatively finish one generation;
- repeated recovery preserves monotonically increasing generations and complete
  Attempt/Claim history;
- migration `0002_worker_claims` rolls back and reapplies without regressing PR3.

PR4 does **not** claim Effect idempotency/reconciliation, durable human Gate
behavior, a background recovery sweeper, provider/connector correctness, HA/backup
readiness, deployment readiness, or production/SOTA performance.
