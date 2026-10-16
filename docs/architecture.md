# V1 architecture

## Decision summary

AegisFlow uses a TypeScript/Node monorepo with PostgreSQL planned as the single
reference durability substrate for V1. Domain contracts and pure state machines
remain independent of PostgreSQL, HTTP frameworks, model SDKs, connector SDKs,
wall-clock time, and randomness.

PR1 introduced `@aegisflow/contracts`. PR2 introduces `@aegisflow/core` for pure,
deterministic state-transition semantics only. Later packages appear when their
runtime responsibility exists rather than as empty shells.

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
relative modules from itself. `core` may import only `@aegisflow/contracts` plus
relative modules from itself. CI enforces those boundaries.

## Why the hand-off architecture survives review

### Keep PostgreSQL-first durability

The target runtime requires transactional ownership, leases, durable Gates,
Signals, Effects, and ordered evidence. A relational database can express these
without introducing another distributed subsystem in V1. Persistence begins in
PR3; PR2 deliberately does not simulate durability in memory.

### Keep state transitions pure

PR2 state machines consume only current state plus an explicit event and return a
frozen transition result. They perform no I/O, read no clock, and draw no
randomness. This keeps retry, cancellation, Gate, and Effect semantics testable
without conflating them with storage or worker ownership.

### Reject a general expression language

The conceptual hand-off example used conditional notation. A general expression
language would silently create a parser/evaluator, security model, and compatibility
contract. PR2 therefore resolves only an already-selected declared Decision choice;
it does not evaluate arbitrary expressions.

### Reject arbitrary transform scripting

`transform` remains declarative mapping only. Arbitrary JavaScript would violate
the V1 non-goal of arbitrary code execution and blur the authority boundary.

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

## Current PR2 guarantees

PR2 can claim deterministic in-memory transition semantics for Execution,
StageExecution, Attempt, Gate, Effect, and declared Decision branch selection.
Terminal states do not revive; cancellation is monotonic; retries allocate a new
Attempt sequence; conflicting Gate decisions fail; ambiguous Effects cannot blind
replay.

PR2 does **not** claim durable recovery, database correctness, dependency scheduling,
lease fencing, external-effect idempotency, durable Gate persistence, connector or
provider correctness, or production readiness.
