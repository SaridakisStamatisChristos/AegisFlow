# AegisFlow

**Governed agentic automation for workflows that can reason, act, recover, and prove what they did.**

AegisFlow is a standalone automation product. It is not an n8n fork, an n8n
workflow collection, a re-skinned visual editor, an LLM wrapper, or a renamed
AgentForge/RelayForge codebase.

The design centers four properties:

- **Governed:** model reasoning and execution authority are separate.
- **Durable:** important execution state survives process failure.
- **Recoverable:** retries, waits, signals, worker failure, ambiguous effects, and
  human approval waits have explicit semantics.
- **Evidential:** execution history is a product primitive rather than an
  after-the-fact log reconstruction exercise.

## Current state — PR7 provider abstraction and Agent Stage runtime

The repository now contains seven bounded roadmap layers:

- `@aegisflow/contracts`: opaque IDs, Flow/Stage contracts, validation, immutable Flow-version snapshots, and public state vocabularies;
- `@aegisflow/core`: pure deterministic Execution, StageExecution, Attempt, Gate, Effect, cancellation, retry, and Decision transition logic;
- `@aegisflow/persistence`: PostgreSQL migrations and reference repositories for durable workflow state and ordered execution evidence;
- `@aegisflow/queue`: PostgreSQL-backed worker claims, leases, monotonic fencing generations, heartbeats, expiry, and abandoned-work recovery;
- `@aegisflow/effects`: durable external-side-effect identity, duplicate suppression, outcome visibility, and reconciliation evidence;
- `@aegisflow/gates`: durable human approval authority and database-enforced protection of dependent work;
- `@aegisflow/providers`: vendor-neutral provider registration, normalized model responses, deterministic output validation, and durable Agent Stage provider-call recovery.

Agent configuration comes from the Execution's pinned immutable Flow Version. A provider call must
hold PR4 worker authority and is represented by PR5 Effect authority. The normalized provider result
is persisted immutably before the Effect becomes successful. Recovery reuses durable results and
quarantines unknown in-flight provider calls instead of blindly replaying them.

PR7 validates tool requests against the immutable Agent allow-list but does not execute tools.
Connector/tool execution begins in PR8.

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
      |       |
      +--- Effect Ledger
              |
        External systems

        PostgreSQL (V1)
flows / versions / executions / stages / attempts /
claims / effects / reconciliations / gates / gate decisions /
provider results / signals / evidence
```

Current boundaries keep contracts framework-free, core persistence-free, and persistence free of
worker/Effect/Gate/Provider service logic. Providers compose immutable Agent contracts with worker
Claim and Effect authority; no provider SDK is part of the core runtime.

## Local verification

Requirements: Node.js 22 and npm 10.

Source-only verification:

```bash
npm install
npm run verify
```

PostgreSQL integration verification requires a PostgreSQL database and explicitly fails if
`DATABASE_URL` is absent:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/aegisflow_test npm run test:postgres
```

Hosted CI provisions PostgreSQL 17 and executes both verification paths.

## Minimal Agent example

```ts
import { validateFlowDefinition } from "@aegisflow/contracts";

const flow = validateFlowDefinition({
  name: "triage",
  stages: [
    {
      id: "classify",
      type: "agent",
      dependsOn: [],
      provider: "my.provider",
      instruction: "Classify the incident.",
      allowedTools: [],
      maxSteps: 1,
      outputSchema: {
        type: "object",
        required: ["severity"],
        properties: { severity: { enum: ["low", "high"] } },
        additionalProperties: false,
      },
    },
  ],
});
```

## Roadmap

1. Foundation and contracts — **complete**
2. Pure deterministic state machines — **complete**
3. PostgreSQL persistence — **complete**
4. Durable queue, worker leases, and generation fencing — **complete**
5. Effect ledger and reconciliation — **complete**
6. Durable human Gates — **complete**
7. Provider abstraction and Agent Stage runtime — **current slice**
8. HTTP/GitHub/Slack connectors
9. Control API + TypeScript SDK
10. CLI
11. Operator console
12. Deterministic demos, failure injection, and benchmarks

See [`docs/architecture.md`](docs/architecture.md), [`docs/state-machines.md`](docs/state-machines.md),
[`docs/persistence-model.md`](docs/persistence-model.md), [`docs/queue-workers.md`](docs/queue-workers.md),
[`docs/effect-ledger.md`](docs/effect-ledger.md), [`docs/gates.md`](docs/gates.md),
[`docs/providers-agent-runtime.md`](docs/providers-agent-runtime.md), and
[`docs/r7-pr7-evidence.md`](docs/r7-pr7-evidence.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
