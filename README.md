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

## Current state — PR1 foundation/contracts

This repository currently implements the first roadmap slice only:

- strict TypeScript contract package with no runtime framework dependencies;
- opaque domain IDs;
- canonical Flow definition and eight bounded Stage kinds;
- runtime Flow validation;
- duplicate, missing-dependency, and DAG-cycle rejection;
- execution, stage, attempt, Gate, and Effect state vocabularies;
- immutable Flow-version snapshots;
- contract tests and architecture-boundary checks;
- initial architecture, state-machine, persistence, Gate/Effect, and R7 evidence docs.

PostgreSQL persistence, workers/leases, runtime Effects, durable Gates, providers,
connectors, API/SDK/CLI, and the operator console are deliberately **not**
implemented in this slice.

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

The contract package intentionally sits at the center and imports no database,
HTTP framework, or model-provider SDK.

## Local verification

Requirements: Node.js 22 and npm 10. TypeScript is installed as a development
dependency.

```bash
npm install
npm run verify
```

For a source-only environment that already has TypeScript 5.8.3 available, the
same checks can be run without fetching packages.

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

## Roadmap

1. Foundation and contracts — **current slice**
2. Pure deterministic state machines
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

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/r7-evidence.md`](docs/r7-evidence.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
