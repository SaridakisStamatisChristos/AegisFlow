# AegisFlow

**Governed agentic automation for workflows that can reason, act, recover, and prove what they did.**

AegisFlow is a standalone TypeScript/Node automation runtime focused on durable execution, explicit authority boundaries, recovery after failure, and auditable evidence.

The design centers four properties:

- **Governed:** reasoning does not automatically grant execution authority.
- **Durable:** execution state survives process failure.
- **Recoverable:** retries, waits, signals, worker loss, ambiguous effects, and approvals have explicit semantics.
- **Evidential:** execution history is stored as a first-class product primitive.

## Current implementation

The V1 core/runtime is organized as a monorepo of focused packages:

- `@aegisflow/contracts` — Flow/Stage contracts, validation, immutable Flow versions, and public state vocabularies.
- `@aegisflow/core` — deterministic Execution, StageExecution, Attempt, Gate, Effect, cancellation, retry, and decision state machines.
- `@aegisflow/persistence` — PostgreSQL migrations and durable repositories.
- `@aegisflow/queue` — worker claims, leases, heartbeats, monotonic fencing generations, and abandoned-work recovery.
- `@aegisflow/effects` — durable external-side-effect identity, duplicate suppression, ambiguity quarantine, and reconciliation.
- `@aegisflow/gates` — durable human approval authority and database-enforced protection of dependent work.
- `@aegisflow/flows` — dependency release, failure propagation, waits, signals, Gate progression, and parent Execution aggregation.
- `@aegisflow/providers` — vendor-neutral model providers, normalized responses, bounded provider/tool loops, and durable provider evidence.
- `@aegisflow/connectors` — governed HTTP, GitHub, and Slack execution with durable tool Effects.
- `@aegisflow/api` — public Control API and scheduler service loop.
- `@aegisflow/sdk` — typed TypeScript client.
- `@aegisflow/cli` — command-line operator/developer surface.
- `@aegisflow/console` — server-rendered operator console with protected mutations.

Provider and connector calls remain subordinate to worker fencing, Effect authority, and Gate protection. Provider-result evidence and successful provider Effect closure are committed in one PostgreSQL transaction. Loss of worker authority after an external call quarantines the Effect for reconciliation instead of allowing blind replay.

## Architecture

```mermaid
flowchart TB
    subgraph Interfaces["Operator & Developer Interfaces"]
        Console["Operator Console"]
        CLI["CLI"]
        SDK["TypeScript SDK"]
    end

    subgraph ControlPlane["Control Plane"]
        API["Control API"]
        Registry["Flow Registry<br/>immutable versions"]
        Scheduler["Flow Scheduler<br/>dependencies · waits · signals · gates"]
    end

    subgraph ExecutionPlane["Execution Plane"]
        Runtime["Stage Runtime"]
        Workers["Workers<br/>leases · heartbeats · fencing"]
        Providers["Model Providers<br/>bounded reasoning/tool loops"]
        Connectors["Governed Connectors<br/>HTTP · GitHub · Slack"]
    end

    subgraph Governance["Governance & Recovery"]
        Gates["Human Gates<br/>approval authority"]
        Effects["Effect Ledger<br/>idempotency · quarantine · reconciliation"]
        Evidence["Ordered Evidence<br/>execution · provider · tool results"]
    end

    DB[("PostgreSQL<br/>coordination + durability")]
    Human["Human Approvers"]
    External["External Systems"]

    Console --> API
    CLI --> API
    SDK --> API
    API --> Registry
    API --> Scheduler
    Registry --> Scheduler
    Scheduler --> Runtime
    Scheduler <--> Gates
    Runtime --> Workers
    Workers --> Providers
    Workers --> Connectors
    Providers --> Effects
    Connectors --> Effects
    Providers --> Evidence
    Connectors --> Evidence
    Runtime --> Evidence
    Human --> Gates
    Effects --> External
    Connectors --> External
    Registry --> DB
    Scheduler --> DB
    Runtime --> DB
    Workers --> DB
    Gates --> DB
    Effects --> DB
    Evidence --> DB
```

PostgreSQL is the single reference coordination substrate for V1. Contracts and pure state machines remain inward-facing; persistence does not depend on execution services; and graph scheduling composes the existing state, Gate, Claim, and Effect authorities instead of bypassing them.

## Local verification

Requirements: Node.js 22 and npm 10.

```bash
npm ci --ignore-scripts
npm run verify
```

PostgreSQL integration tests require `DATABASE_URL`:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/aegisflow_test npm run test:postgres
```

Run the deterministic end-to-end scenario suite with:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/aegisflow_test npm run demo:deterministic
```

Hosted CI runs source verification, PostgreSQL integration tests, deterministic failure/recovery scenarios, evidence/dependency manifest checks, secret scanning, and a production dependency audit.

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

## Capability status

Implemented in the current V1 core/runtime:

- immutable Flow versions and deterministic state machines;
- PostgreSQL-backed durable execution state and ordered evidence;
- worker leases, recovery, and fencing;
- Effect identity, duplicate suppression, ambiguity quarantine, and reconciliation;
- durable human Gates;
- model-provider and governed connector execution;
- graph scheduling for dependencies, waits, signals, and Gates;
- Control API, SDK, CLI, and operator console;
- deterministic failure-injection and recovery verification.

Remaining work before a production-readiness claim includes authenticated identity/RBAC, secrets-management integration, deployment/HA/backup qualification, production observability and SLO evidence, real-provider qualification, and capacity characterization. AegisFlow does not claim generic exactly-once execution inside arbitrary external services.

See [`docs/architecture.md`](docs/architecture.md), [`docs/state-machines.md`](docs/state-machines.md), [`docs/persistence-model.md`](docs/persistence-model.md), [`docs/queue-workers.md`](docs/queue-workers.md), [`docs/effect-ledger.md`](docs/effect-ledger.md), [`docs/gates.md`](docs/gates.md), [`docs/providers-agent-runtime.md`](docs/providers-agent-runtime.md), [`docs/connectors.md`](docs/connectors.md), [`docs/control-api.md`](docs/control-api.md), [`docs/demo-benchmark.md`](docs/demo-benchmark.md), and [`docs/repository-protection.md`](docs/repository-protection.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
