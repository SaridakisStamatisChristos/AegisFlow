# V1 architecture

## Decision summary

AegisFlow uses a TypeScript/Node monorepo with PostgreSQL as the single reference
durability substrate for V1. Domain contracts and pure state machines remain
independent of PostgreSQL, HTTP frameworks, model SDKs, connector SDKs, wall-clock
time, and randomness.

PR1 introduced `@aegisflow/contracts`. PR2 introduced `@aegisflow/core`. PR3 adds
`@aegisflow/persistence`, a PostgreSQL adapter that stores those contracts without
redefining their transition semantics.

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
```

`contracts` imports only relative modules. `core` imports only `contracts` plus
relative modules. `persistence` imports only `contracts`, the PostgreSQL driver,
Node migration I/O, and relative modules. In particular, persistence does **not**
import `core`; a database repository must never become the authority for whether a
domain transition is legal.

Later scheduling/runtime packages may depend on both core and persistence through
explicit interfaces.

## Why the hand-off architecture survives review

### PostgreSQL-first durability

The target runtime requires transactional ownership, leases, durable Gates,
Signals, Effects, and ordered evidence. PR3 now supplies the reference relational
substrate without adding Redis, Kafka, Kubernetes, or another distributed state
system.

### Keep state transitions pure

PR2 decides whether a transition is legal. PR3 provides storage primitives such as
compare-and-set. This separation means a storage race can be prevented without
copying transition policy into SQL/repositories.

### Immutable Flow Versions

Flow Version snapshots are append-only in the contract and now independently
protected in PostgreSQL by uniqueness constraints plus a trigger rejecting update
or delete. Executions use a composite foreign key so the stored Flow ID must match
the Flow Version's owner.

### Atomic execution materialization

Creating an Execution and its initial StageExecution rows is one transaction.
A partially materialized workflow is therefore not a valid persisted state.

### Evidence ordering

Concurrent execution-event inserts receive a database identity position. This
provides an unambiguous persisted order without requiring an in-memory sequencer.

### Reject premature queue semantics

PR3 does not add worker claims, leases, fencing generations, heartbeats, or recovery.
Those are PR4 because they require their own concurrency contract and adversarial
failure tests.

## Package roadmap

- `@aegisflow/contracts` — IDs, public domain types, schemas, error taxonomy.
- `@aegisflow/core` — pure state machines and retry/cancellation semantics.
- `@aegisflow/persistence` — PostgreSQL migrations and reference repositories.
- `@aegisflow/flows` — graph scheduling and version semantics.
- `@aegisflow/queue` — claims, leases, fencing, expiry, recovery.
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
3. Worker -> lease/fencing authority boundary (PR4).
4. Model output -> schema validation + deterministic policy.
5. Policy -> optional durable Gate.
6. Approved Action -> Effect ledger -> connector.
7. External response -> classified success/failure/ambiguous result.
8. Runtime events -> redacted structured Evidence.

## Current PR3 guarantees

PR3 can claim, when the PostgreSQL integration suite is green on the exact revision:

- clean migration and single-step rollback/reapply;
- durable round-trip of Flow, FlowVersion, Execution, StageExecution, Attempt, and
  execution-event records;
- database-enforced FlowVersion immutability;
- atomic Execution + initial Stage materialization;
- retry sequence uniqueness;
- compare-and-set conflict arbitration under concurrent writers;
- lossless concurrent event append with total database ordering.

PR3 does **not** claim worker recovery, lease fencing, external-effect idempotency,
durable Gate semantics, provider/connector correctness, deployment readiness, or
production readiness.
