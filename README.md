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

## Current state — PR2 deterministic core

The repository now contains the first two roadmap slices:

- `@aegisflow/contracts`: opaque IDs, bounded Flow/Stage contracts, validation,
  immutable Flow-version snapshots, and public state vocabularies;
- `@aegisflow/core`: pure deterministic state machines for Executions,
  StageExecutions, Attempts, Gates, and Effects;
- monotonic terminal/cancellation semantics and explicit invalid-transition errors;
- retry sequence allocation without reopening prior Attempts;
- idempotent identical Gate decisions with deterministic conflict rejection;
- reconciliation as a terminal Effect outcome so ambiguous external effects cannot
  blind-replay;
- deterministic Decision branch resolution without adding a general expression
  language;
- adversarial tests for malformed inputs and terminal-state revival;
- architecture-boundary checks keeping `core` dependent only on `contracts`.

PostgreSQL persistence, workers/leases, durable Effects and Gates, providers,
connectors, API/SDK/CLI, and the operator console remain later roadmap slices.

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

The current code keeps contracts framework-free and keeps the pure core free of
persistence, HTTP, model-provider, connector, clock, randomness, and worker logic.

## Local verification

Requirements: Node.js 22 and npm 10. TypeScript is installed as a development
dependency.

```bash
npm install
npm run verify
```

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
2. Pure deterministic state machines — **current slice**
3. PostgreSQL persistence
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
[`docs/state-machines.md`](docs/state-machines.md), and
[`docs/r7-pr2-evidence.md`](docs/r7-pr2-evidence.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
