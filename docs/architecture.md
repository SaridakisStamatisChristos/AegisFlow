# V1 architecture

## Design summary

AegisFlow is a TypeScript/Node monorepo with PostgreSQL as the reference durability and coordination substrate. Domain contracts and pure state machines remain independent of PostgreSQL, HTTP frameworks, model SDKs, connector SDKs, wall-clock time, and randomness.

The implemented layers are:

- `@aegisflow/contracts` — immutable public contracts and validation;
- `@aegisflow/core` — pure deterministic state machines;
- `@aegisflow/persistence` — PostgreSQL migrations and repositories;
- `@aegisflow/queue` — worker claims, leases, fencing, attempts, and recovery;
- `@aegisflow/effects` — external Effect identity, completion, ambiguity, and reconciliation;
- `@aegisflow/gates` — human approval authority and dependent-stage protection;
- `@aegisflow/flows` — durable graph reconciliation and passive-stage scheduling;
- `@aegisflow/connectors` — governed external tools;
- `@aegisflow/providers` — provider execution and bounded provider/tool loops;
- `@aegisflow/api` — public control plane and scheduler integration;
- `@aegisflow/sdk`, `@aegisflow/cli`, and `@aegisflow/console` — client/operator surfaces.

## Dependency rule

```text
contracts <- core
contracts <- persistence
core + persistence <- queue / gates / effects
contracts + core + gates <- flows
queue + effects + connectors <- providers
contracts + core + effects + gates + flows <- api
contracts <- sdk
sdk <- cli / console
```

Persistence does not depend back on runtime services. The scheduler does not create a second state model. Connectors do not create a second side-effect ledger. Providers compose immutable Agent contracts with worker Claims, provider Effects, and connector execution.

## Runtime authority model

Graph eligibility and execution authority are intentionally separate:

1. **Flow scheduler authority** determines dependency eligibility, passive waits/signals, Gate progression, skip propagation, and aggregate Execution state.
2. **Gate authority** determines whether protected work is permitted.
3. **Worker Claim authority** determines which worker may advance worker-owned Stage work.
4. **Effect authority** determines whether one logical external side effect may be attempted, suppressed, or quarantined.
5. **Pinned Flow Version authority** fixes provider, instruction, tool allow-list, step budget, and output schema.

A model response never grants any of these authorities.

## Durable graph reconciliation

`@aegisflow/flows` locks an Execution and its materialized Stage rows, validates them against the pinned Flow Version, and converges immediate graph transitions within a bounded pass count.

Implemented scheduler behavior includes:

- dependency release from `BLOCKED` to `READY` only after successful prerequisites;
- failure/cancellation/skip propagation to blocked descendants;
- durable early-Signal consumption;
- durable Signal and Wait stages;
- durable Gate creation and release;
- aggregate Stage state driving the parent Execution through the existing core state machine.

Worker-owned Task/Agent/Action execution remains separate from graph eligibility and must use existing Claim, Effect, and Gate authority.

## External-call durability

Provider steps and connector calls have stable Effect identities. Normalized provider/tool evidence is immutable PostgreSQL evidence and cannot be cross-bound to another StageExecution.

For provider calls, local evidence insertion and Effect transition to `SUCCEEDED` commit in one PostgreSQL transaction. If worker authority is lost after a provider returns, the Effect moves to `RECONCILIATION_REQUIRED`. Cancelling a Stage with a claimed Effect also quarantines the Effect. These rules prevent authoritative blind replay but do not claim exactly-once behavior inside external services.

## Connector trust boundaries

Credentials and transports are injected by operator configuration and are not accepted from Agent tool input or stored in durable Effect/result evidence.

- Generic HTTP requires approved HTTPS origins and rejects credential/transport headers from Agent input.
- GitHub is fixed to `api.github.com` and validates approved API path prefixes.
- Slack is fixed to `chat.postMessage` and validates approved channel IDs.

## Control plane

The Control API provides Flow registration/version inspection, execution start and inspection, cancellation, events, Effects, Gates, Signals, reconciliation, and bounded operator list views. Execution creation and Signal delivery use durable idempotency keys.

The SDK communicates only with the public API. The CLI and server-rendered console use the SDK rather than PostgreSQL internals. Console mutation forms are CSRF-protected and dynamic HTML is escaped.

The Control API now has fail-closed, hashed service-token authentication and role-based route permission checks, with principal-bound Gate/Effect attribution. This does not implement end-user login, OIDC/SSO, or multi-tenancy. The browser console still needs loopback isolation or an authenticated reverse proxy; see docs/security/AEGISCORE_INTEGRATION.md.

## Verification architecture

Hosted CI pins Node 22 and npm 10.9.2 and runs:

- reproducible lockfile installation;
- lint, typecheck, build, and package-boundary checks;
- source/unit tests;
- PostgreSQL migration and integration tests;
- queue/Effect/Gate/provider/connector/scheduler failure-path tests;
- deterministic scenario and failure-injection verification;
- secret scanning;
- evidence and dependency manifest verification;
- production dependency audit at high severity.

The PostgreSQL test orchestrator runs against the committed migration chain without renaming migration files in the checkout.

## Current limits

The implementation is a strong core/runtime reference, not yet a full production-readiness claim. Remaining qualification work includes human OIDC/SSO and resource-specific authorization, secrets-management integration, HA/backups/disaster recovery, production observability and SLO evidence, deployment hardening, real-provider qualification, and capacity characterization.
