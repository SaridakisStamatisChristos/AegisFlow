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

## Current state — PR4 durable worker authority

The repository now contains four bounded roadmap layers:

- `@aegisflow/contracts`: opaque IDs, Flow/Stage contracts, validation, immutable
  Flow-version snapshots, and public state vocabularies;
- `@aegisflow/core`: pure deterministic Execution, StageExecution, Attempt, Gate,
  Effect, cancellation, retry, and Decision transition logic;
- `@aegisflow/persistence`: PostgreSQL migrations and reference repositories for
  durable workflow state and ordered execution evidence;
- `@aegisflow/queue`: PostgreSQL-backed worker claims, leases, monotonic fencing
  generations, heartbeats, expiry, and abandoned-work recovery.

PR4 keeps every worker claim as historical evidence tied to one Attempt. A Stage can
have only one active Claim; recovery expires the abandoned Claim, times out its
Attempt, then issues a new Attempt and higher generation. Completion must present
the exact live owner/Attempt/generation and an unexpired lease, so stale workers
cannot authoritatively finish recovered work.

The Effect ledger/idempotency layer, durable Gates, providers, connectors,
API/SDK/CLI, and operator console remain later roadmap slices.

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
flows / versions / executions / stages / attempts /
claims / effects / gates / signals / evidence
```

Current boundaries keep contracts framework-free, core persistence-free,
persistence free of worker authority, and queue explicitly dependent on core +
persistence for legal-transition and transactional storage services.

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
3. PostgreSQL persistence — **complete**
4. Durable queue, worker leases, and generation fencing — **current slice**
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
[`docs/persistence-model.md`](docs/persistence-model.md),
[`docs/queue-workers.md`](docs/queue-workers.md), and
[`docs/r7-pr4-evidence.md`](docs/r7-pr4-evidence.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
