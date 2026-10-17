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

## Current state — durable control plane and graph scheduler

The repository now contains the complete PR1–PR12 product slices plus the PR13–PR15
correctness and hardening work:

- `@aegisflow/contracts`: opaque IDs, Flow/Stage contracts, validation, immutable Flow-version snapshots, and public state vocabularies;
- `@aegisflow/core`: pure deterministic Execution, StageExecution, Attempt, Gate, Effect, cancellation, retry, and Decision transition logic;
- `@aegisflow/persistence`: PostgreSQL migrations and reference repositories for durable workflow state and ordered execution evidence;
- `@aegisflow/queue`: PostgreSQL-backed worker claims, leases, monotonic fencing generations, heartbeats, expiry, and abandoned-work recovery;
- `@aegisflow/effects`: durable external-side-effect identity, duplicate suppression, outcome visibility, reconciliation evidence, and transactional Effect closure support;
- `@aegisflow/gates`: durable human approval authority and database-enforced protection of dependent work;
- `@aegisflow/flows`: production graph reconciliation for dependency release, failure/skip propagation, durable waits, durable early-Signal consumption, automatic Gate materialization, and parent Execution state aggregation;
- `@aegisflow/providers`: vendor-neutral provider registration, normalized model responses, deterministic output validation, bounded provider/tool loops, and crash-safe provider evidence;
- `@aegisflow/connectors`: governed `http.request`, `github.request`, and `slack.postMessage` execution with durable tool Effects and result evidence;
- `@aegisflow/api`: public Control API plus the scheduler service loop;
- `@aegisflow/sdk`: typed TypeScript client for the Control API;
- `@aegisflow/cli`: command-line operator surface;
- `@aegisflow/console`: server-rendered operator console with CSRF-protected mutations.

Provider and connector calls remain subordinate to worker fencing, Effect authority,
and Gate protection. Provider-result evidence and successful provider Effect closure
are committed in one local PostgreSQL transaction. If worker authority is lost after
a remote provider call, or a Stage is cancelled while an Effect is still claimed,
the Effect is quarantined as reconciliation-required rather than left indefinitely
in flight.

The Flow scheduler does not create a second execution authority model. It reconciles
graph eligibility and scheduler-owned passive stages; specialized Task, Agent, and
Action execution remains subordinate to the existing worker/runtime authorities.

## Architecture

```text
Operator Console / CLI / SDK
             |
             v
        Control API ---- Flow Registry
             |                |
             +-------+--------+
                     v
              Flow Scheduler
             /      |       \
      dependencies waits   signals/gates
             \      |       /
              Stage Runtime
             /      |       \
       Workers   Providers  Connectors
          |          |          |
          +----------+----------+
                     v
                Effect Ledger
                     |
              External systems

              PostgreSQL (V1)
flows / versions / executions / stages / attempts / claims /
effects / reconciliations / gates / gate decisions /
provider results / tool results / signals / ordered evidence
```

PostgreSQL is the single required coordination substrate for V1. Contracts and pure
state machines remain inward-facing; persistence does not depend on execution
services; and the scheduler composes existing state/Gate authority rather than
bypassing it.

## Local verification

Requirements: Node.js 22 and npm 10.

Source verification:

```bash
npm ci --ignore-scripts
npm run verify
```

PostgreSQL integration verification requires a PostgreSQL database and explicitly
fails if `DATABASE_URL` is absent:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/aegisflow_test npm run test:postgres
```

The integration harness runs every migration/test suite against the current schema;
it does not rename or hide migration files in the checkout. Hosted CI provisions
PostgreSQL 17, runs the full regression suite, executes the deterministic PR12
failure/demo scenarios, verifies dependency/evidence manifests, scans for secrets,
and audits production dependencies.

To run the Control API with graph reconciliation enabled:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/aegisflow \
PORT=8080 \
AEGISFLOW_SCHEDULER_INTERVAL_MS=1000 \
node packages/api/dist/main.js
```

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

## Roadmap status

1. Foundation and contracts — **complete**
2. Pure deterministic state machines — **complete**
3. PostgreSQL persistence — **complete**
4. Durable queue, worker leases, and generation fencing — **complete**
5. Effect ledger and reconciliation — **complete**
6. Durable human Gates — **complete**
7. Provider abstraction and Agent Stage runtime — **complete**
8. HTTP/GitHub/Slack connectors and Agent tool execution — **complete**
9. Control API + TypeScript SDK — **complete**
10. CLI — **complete**
11. Operator console — **complete**
12. Deterministic demos, failure injection, and benchmarks — **complete**
13. Provider/Effect atomicity and cancellation quarantine — **complete**
14. Durable graph scheduler and Execution aggregation — **complete**
15. Test-harness, routing, documentation, and repository hardening — **current slice**

Remaining work before a production-readiness claim includes authenticated identity and
RBAC, deployment/HA/backup qualification, secrets-management integration, production
observability/SLO evidence, and real-provider qualification. AegisFlow does not claim
generic exactly-once execution inside arbitrary external services.

See [`docs/architecture.md`](docs/architecture.md), [`docs/state-machines.md`](docs/state-machines.md),
[`docs/persistence-model.md`](docs/persistence-model.md), [`docs/queue-workers.md`](docs/queue-workers.md),
[`docs/effect-ledger.md`](docs/effect-ledger.md), [`docs/gates.md`](docs/gates.md),
[`docs/providers-agent-runtime.md`](docs/providers-agent-runtime.md), [`docs/connectors.md`](docs/connectors.md),
[`docs/control-api.md`](docs/control-api.md), [`docs/demo-benchmark.md`](docs/demo-benchmark.md), and
[`docs/repository-protection.md`](docs/repository-protection.md).

## License

Proprietary / all rights reserved. See [`LICENSE`](LICENSE).
