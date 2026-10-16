# AegisFlow

**Governed agentic automation for workflows that can reason, act, recover, and prove what they did.**

AegisFlow is a standalone automation product. It is not an n8n fork, an n8n
workflow collection, a re-skinned visual editor, an LLM wrapper, or a renamed
AgentForge/RelayForge codebase.

The design centers four properties:

- **Governed:** model reasoning and execution authority are separate.
- **Durable:** important execution state is designed to survive process failure.
- **Recoverable:** retries, waits, signals, worker failure, and ambiguous effects
  have explicit semantics.
- **Evidential:** execution history is a product primitive rather than an
  after-the-fact log reconstruction exercise.

## Current state — PR3 PostgreSQL persistence

The repository now contains three bounded roadmap layers:

- `@aegisflow/contracts`: opaque IDs, Flow/Stage contracts, validation, immutable
  in-memory Flow-version snapshots, and public state vocabularies;
- `@aegisflow/core`: pure deterministic Execution, StageExecution, Attempt, Gate,
  Effect, cancellation, retry, and Decision transition logic;
- `@aegisflow/persistence`: PostgreSQL migrations and reference repositories for
  Flows, Flow Versions, Executions, StageExecutions, Attempts, and ordered
  execution evidence.

PR3 adds database-enforced Flow-Version immutability, composite Flow/Flow-Version
integrity, atomic Execution + initial Stage materialization, retry-sequence
uniqueness, compare-and-set storage primitives, and concurrent event ordering.
Persistence does not decide whether a state transition is legal; callers must use
the pure core semantics.

Worker claims/leases/fencing, durable Effects and Gates, providers, connectors,
API/SDK/CLI, and the operator console remain later roadmap slices.

## Architecture direction

```text
Web / CLI / SDK
      |
      v
Control API ---- Flow Registry
      |               |
      +-------+-------+
              v
       Durable Runtime
        /           \
 Worker claims    Policy/Gates
        \           /
         Stage Engine
       /      |       \
 Providers Connectors Tasks
              |
        External systems

        PostgreSQL (V1)
flows / versions / executions / attempts /
effects / gates / signals / evidence
```

Current package boundaries keep contracts framework-free, core persistence-free,
and the PostgreSQL adapter dependent only on contracts plus the database/Node
adapter surface.

## Local verification

Requirements: Node.js 22 and npm 10.

Source-only verification:

```bash
npm install
npm run verify
```

PostgreSQL integration verification requires a PostgreSQL database and explicitly
fails if `DATABASE_URL` is absent:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/aegisflow_test npm run test:postgres
```

Hosted CI provisions PostgreSQL 17 and executes both verification paths.

## Minimal contract example

```ts
import { validateFlowDefinition } from "@aegisflow/contracts";

const flow = validateFlowDefinition({
  name: "incident-response",
  stages: [
    {
      id: "classify",
      type: "agent",
      provider: "deterministic",
      instruction: "Classify severity",
      allowedTools: [],
      maxSteps: 1,
    },
    {
      id: "approval",
      type: "gate",
      dependsOn: ["classify"],
      prompt: "Approve response?",
    },
    {
      id: "notify",
      type: "action",
      dependsOn: ["approval"],
      connector: "slack",
      operation: "send_message",
      input: { channel: "ops" },
    },
  ],
});
```

## Minimal state-machine example

```ts
import {
  nextAttemptSequence,
  transitionExecution,
  transitionGate,
} from "@aegisflow/core";

transitionExecution("PENDING", "START");
// => { from: "PENDING", event: "START", to: "RUNNING", changed: true }

transitionGate("APPROVED", "APPROVE");
// => identical duplicate decision, changed: false

nextAttemptSequence(2);
// => 3; retry creates a new Attempt sequence instead of reopening sequence 2
```

## Roadmap

1. Foundation and contracts — **complete**
2. Pure deterministic state machines — **complete**
3. PostgreSQL persistence — **current slice**
4. Durable queue, worker leases, and generation fencing
5. Effect ledger and reconciliation
6. Durable human Gates
7. Provider abstraction and Agent Stage runtime
8. HTTP/GitHub/Slack connectors
9. Control API + TypeScript SDK
10. CLI
11. Operator console
12. Deterministic demos, failure injection, and benchmarks

See [`docs/architecture.md`](docs/architecture.md),
[`docs/state-machines.md`](docs/state-machines.md),
[`docs/persistence-model.md`](docs/persistence-model.md), and
[`docs/r7-pr3-evidence.md`](docs/r7-pr3-evidence.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
