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

## Current state — PR6 durable Gate authority

The repository now contains six bounded roadmap layers:

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
  reconciliation evidence;
- `@aegisflow/gates`: durable human approval authority, expiry, immutable decision
  evidence, and database-enforced protection of dependent work.

A Gate is created only for a materialized `gate` Stage and derives its deadline and
protected direct dependents from the Execution's pinned immutable Flow version. The
Gate Stage moves into `WAITING`. Approval, rejection, or expiry is persisted with
database time and immutable evidence; conflicting terminal decisions fail closed.

Protected StageExecutions cannot acquire an `ACTIVE` worker Claim while any
protecting Gate is not `APPROVED`. The check exists in PostgreSQL as well as the
Gate API, so bypassing the higher-level Gate service does not grant worker
authority. Approval only removes the Gate barrier: later side-effecting work still
needs PR5 Effect authority before a connector call.

PR6 does not implement authentication/authorization policy for human identities,
notifications, providers/connectors, API/SDK/CLI, or the operator console.

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
claims / effects / reconciliations / gates / gate decisions / signals / evidence
```

Current boundaries keep contracts framework-free, core persistence-free, and
persistence free of worker/Effect/Gate service logic. Queue, Effects, and Gates
compose core transitions with PostgreSQL transactions and constraints.

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
      id: "approval",
      type: "gate",
      prompt: "Approve response?",
      expiresAfterMs: 3_600_000,
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

## Minimal Gate example

```ts
import { parseGateId } from "@aegisflow/contracts";
import { PostgresGateLedger } from "@aegisflow/gates";

const gates = new PostgresGateLedger(pool);
const opened = await gates.createGate({
  id: parseGateId("gate_example01"),
  executionId,
  stageExecutionId: approvalStageExecutionId,
});

await gates.resolveGate(opened.snapshot.gate.id, {
  event: "APPROVE",
  actorId: "operator-42",
  evidence: { ticket: "CHG-123" },
});
```

## Roadmap

1. Foundation and contracts — **complete**
2. Pure deterministic state machines — **complete**
3. PostgreSQL persistence — **complete**
4. Durable queue, worker leases, and generation fencing — **complete**
5. Effect ledger and reconciliation — **complete**
6. Durable human Gates — **current slice**
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
[`docs/effect-ledger.md`](docs/effect-ledger.md),
[`docs/gates.md`](docs/gates.md), and
[`docs/r7-pr6-evidence.md`](docs/r7-pr6-evidence.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
