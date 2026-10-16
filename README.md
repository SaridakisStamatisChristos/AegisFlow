# AegisFlow

**Governed agentic automation for workflows that can reason, act, recover, and prove what they did.**

AegisFlow is a standalone automation product. It is not an n8n fork, an n8n
workflow collection, a re-skinned visual editor, an LLM wrapper, or a renamed
AgentForge/RelayForge codebase.

The design centers four properties:

- **Governed:** model reasoning and execution authority are separate.
- **Durable:** important execution state survives process failure.
- **Recoverable:** retries, waits, signals, worker failure, and ambiguous effects
  have explicit semantics.
- **Evidential:** execution history is a product primitive rather than an
  after-the-fact log reconstruction exercise.

## Current state — PR5 durable Effect authority

The repository now contains five bounded roadmap layers:

- `@aegisflow/contracts`: opaque IDs, Flow/Stage contracts, validation, immutable
  Flow-version snapshots, and public state vocabularies;
- `@aegisflow/core`: pure deterministic Execution, StageExecution, Attempt, Gate,
  Effect, cancellation, retry, and Decision transition logic;
- `@aegisflow/persistence`: PostgreSQL migrations and reference repositories for
  durable workflow state and ordered execution evidence;
- `@aegisflow/queue`: PostgreSQL-backed worker claims, leases, monotonic fencing
  generations, heartbeats, expiry, and abandoned-work recovery;
- `@aegisflow/effects`: durable external-side-effect identity, duplicate planning
  convergence, claim authority, terminal outcome visibility, and immutable
  reconciliation evidence.

PR5 gives one logical external side effect a stable `effectKey` scoped to an
Execution. The ledger stores a SHA-256 digest of canonical intent rather than raw
connector payload. Reusing the same key for different intent fails closed;
concurrent identical planning converges on one Effect. A successful Effect suppresses
replay. A known failure remains terminal. An ambiguous outcome becomes
`RECONCILIATION_REQUIRED` and cannot be called again until reconciliation records
what actually happened externally.

AegisFlow does **not** claim generic exactly-once external execution. PR5 prevents
blind replay inside the runtime; future connectors must still use provider-native
idempotency and reconciliation capabilities where available.

Durable human Gates, providers, connectors, API/SDK/CLI, and the operator console
remain later roadmap slices.

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
         Effect Ledger
              |
        External systems

        PostgreSQL (V1)
flows / versions / executions / stages / attempts /
claims / effects / reconciliations / gates / signals / evidence
```

Current boundaries keep contracts framework-free, core persistence-free,
persistence free of worker/Effect authority, and queue/effects explicitly dependent
on core + persistence for legal-transition and transactional storage services.

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

## Minimal Effect-ledger example

```ts
import { parseEffectId } from "@aegisflow/contracts";
import { PostgresEffectLedger } from "@aegisflow/effects";

const effects = new PostgresEffectLedger(pool);
const planned = await effects.planEffect({
  id: parseEffectId("effect_example01"),
  executionId,
  stageExecutionId,
  effectKey: "notify:incident:42",
  intent: { connector: "slack", operation: "send_message", incidentId: 42 },
});

const authority = await effects.claimEffect(planned.effect.id);
if (authority.disposition === "CLAIMED") {
  // Only now may the connector call be attempted.
}
```

## Roadmap

1. Foundation and contracts — **complete**
2. Pure deterministic state machines — **complete**
3. PostgreSQL persistence — **complete**
4. Durable queue, worker leases, and generation fencing — **complete**
5. Effect ledger and reconciliation — **current slice**
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
[`docs/queue-workers.md`](docs/queue-workers.md),
[`docs/effect-ledger.md`](docs/effect-ledger.md), and
[`docs/r7-pr5-evidence.md`](docs/r7-pr5-evidence.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
