# AegisFlow

**Governed agentic automation for workflows that can reason, act, recover, and prove what they did.**

AegisFlow is a standalone automation product. It is not an n8n fork, an n8n
workflow collection, a re-skinned visual editor, an LLM wrapper, or a renamed
AgentForge/RelayForge codebase.

The design centers four properties:

- **Governed:** model reasoning and execution authority are separate.
- **Durable:** important execution state survives process failure.
- **Recoverable:** retries, waits, signals, worker failure, ambiguous effects, and human approval waits have explicit semantics.
- **Evidential:** execution history is a product primitive rather than an after-the-fact log reconstruction exercise.

## Current state — PR8 governed connectors and Agent tool execution

The repository now contains eight bounded roadmap layers:

- `@aegisflow/contracts`: opaque IDs, Flow/Stage contracts, validation, immutable Flow-version snapshots, and public state vocabularies;
- `@aegisflow/core`: pure deterministic Execution, StageExecution, Attempt, Gate, Effect, cancellation, retry, and Decision transition logic;
- `@aegisflow/persistence`: PostgreSQL migrations and reference repositories for durable workflow state and ordered execution evidence;
- `@aegisflow/queue`: PostgreSQL-backed worker claims, leases, monotonic fencing generations, heartbeats, expiry, and abandoned-work recovery;
- `@aegisflow/effects`: durable external-side-effect identity, duplicate suppression, outcome visibility, and reconciliation evidence;
- `@aegisflow/gates`: durable human approval authority and database-enforced protection of dependent work;
- `@aegisflow/providers`: vendor-neutral provider registration, normalized model responses, deterministic output validation, and durable Agent Stage provider-call recovery;
- `@aegisflow/connectors`: governed `http.request`, `github.request`, and `slack.postMessage` execution with durable tool effects and result evidence.

Agent configuration still comes from the Execution's pinned immutable Flow Version. Provider calls and connector calls both reuse PR5 Effect authority and remain subordinate to PR4 worker fencing and PR6 Gate protection. PR8 persists immutable connector evidence before a tool Effect can become successful, separates known failures from ambiguous outcomes, and quarantines unknown in-flight external calls instead of blindly replaying them.

When a connector registry is supplied, an Agent can execute a bounded provider → tool → provider loop up to its immutable `maxSteps`. Every returned tool is preflighted against the Agent allow-list and connector registry before the first side effect in that provider turn. Constructing the Agent runtime without connectors preserves the PR7 fail-closed behavior.

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
provider results / tool results / signals / evidence
```

Current boundaries keep contracts framework-free, core persistence-free, and persistence free of worker/Effect/Gate/Provider/Connector service logic. Providers compose immutable Agent contracts with worker Claim, Effect, and connector authority; connectors do not bypass those durable layers.

## Local verification

Requirements: Node.js 22 and npm 10.

Source-only verification:

```bash
npm install
npm run verify
```

PostgreSQL integration verification requires a PostgreSQL database and explicitly fails if `DATABASE_URL` is absent:

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
      allowedTools: ["github.request"],
      maxSteps: 2,
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
7. Provider abstraction and Agent Stage runtime — **complete**
8. HTTP/GitHub/Slack connectors and Agent tool execution — **current slice**
9. Control API + TypeScript SDK
10. CLI
11. Operator console
12. Deterministic demos, failure injection, and benchmarks

See [`docs/architecture.md`](docs/architecture.md), [`docs/state-machines.md`](docs/state-machines.md),
[`docs/persistence-model.md`](docs/persistence-model.md), [`docs/queue-workers.md`](docs/queue-workers.md),
[`docs/effect-ledger.md`](docs/effect-ledger.md), [`docs/gates.md`](docs/gates.md),
[`docs/providers-agent-runtime.md`](docs/providers-agent-runtime.md), [`docs/connectors.md`](docs/connectors.md),
and [`docs/r7-pr8-evidence.md`](docs/r7-pr8-evidence.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
