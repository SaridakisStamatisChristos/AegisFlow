# V1 architecture

## Decision summary

AegisFlow uses a TypeScript/Node monorepo with PostgreSQL planned as the single
reference durability substrate for V1. The core domain model remains independent
of PostgreSQL, HTTP frameworks, model SDKs, and connector SDKs.

PR1 intentionally implements only `@aegisflow/contracts`. Later packages are
introduced when their runtime responsibility exists rather than as empty shells.

## Dependency rule

The intended dependency direction is:

```text
contracts
   ↓
core
   ↓
flows
   ↓
runtime
```

Adapters point inward through contracts/interfaces. `contracts` may import only
relative modules from itself. The CI boundary check enforces this today.

## Why the hand-off architecture survives review

### Keep PostgreSQL-first durability

The target runtime requires transactional ownership, leases, durable Gates,
Signals, Effects, and ordered evidence. A relational database can express these
without introducing another distributed subsystem in V1. This remains a design
commitment, not a PR1 runtime claim.

### Reject a general expression language in PR1

The conceptual hand-off example used conditional notation. A general `when`
expression language would silently create a parser/evaluator, security model,
and compatibility contract. PR1 therefore models bounded `decision` Stages but
does not introduce arbitrary expressions. Branch semantics belong to the state
machine/runtime slices.

### Reject arbitrary transform scripting

`transform` is declarative mapping only. Arbitrary JavaScript would violate the
V1 non-goal of arbitrary code execution and blur the authority boundary.

### Keep Agent Stages bounded

The contract exposes provider, instruction, allowed-tool declarations, output
schema, and `maxSteps`. Tool declarations are not execution authority. Runtime
policy, Gates, and Effects remain mandatory later boundaries.

## Planned packages

- `@aegisflow/contracts` — IDs, public domain types, schemas, error taxonomy.
- `@aegisflow/core` — pure state machines and retry/cancellation semantics.
- `@aegisflow/flows` — graph scheduling and version semantics.
- `@aegisflow/persistence` — PostgreSQL repositories and migrations.
- `@aegisflow/queue` — claims, leases, fencing, expiry, recovery.
- `@aegisflow/policy` — deterministic allow/require-gate/deny decisions.
- `@aegisflow/effects` — idempotency and reconciliation ledger.
- `@aegisflow/gates` — durable human approval lifecycle.
- `@aegisflow/providers` — model provider adapters.
- `@aegisflow/connectors` — typed external actions.
- `@aegisflow/evidence` — ordered durable execution evidence.
- `@aegisflow/sdk` — public client used by CLI and web.

Applications later consume those packages: API, worker, CLI, then operator web.

## Trust boundaries

1. User/API input -> contract validation.
2. Runtime -> persistence transaction boundary.
3. Worker -> lease/fencing authority boundary.
4. Model output -> schema validation + deterministic policy.
5. Policy -> optional durable Gate.
6. Approved Action -> Effect ledger -> connector.
7. External response -> classified success/failure/ambiguous result.
8. Runtime events -> redacted structured Evidence.

## Current PR1 guarantees

PR1 can only claim validated Flow contracts and immutable in-memory version
snapshots. It does **not** yet claim durable recovery, database immutability,
fencing, Effect idempotency, Gate durability, or production readiness.
