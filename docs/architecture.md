# V1 architecture

## Decision summary

AegisFlow is a TypeScript/Node monorepo with PostgreSQL as the single reference
durability and coordination substrate for V1. Domain contracts and pure state
machines remain independent of PostgreSQL, HTTP frameworks, model SDKs, connector
SDKs, wall-clock time, and randomness.

The implemented package layers are:

- `@aegisflow/contracts` — immutable public contracts and validation;
- `@aegisflow/core` — pure state machines;
- `@aegisflow/persistence` — PostgreSQL migrations and repositories;
- `@aegisflow/queue` — worker claims, leases, fencing, attempts, and recovery;
- `@aegisflow/effects` — external Effect identity, completion, and reconciliation;
- `@aegisflow/gates` — human approval authority and dependent-stage protection;
- `@aegisflow/flows` — durable graph reconciliation and passive-stage scheduling;
- `@aegisflow/connectors` — governed external tools;
- `@aegisflow/providers` — provider execution and bounded provider/tool loops;
- `@aegisflow/api` — public control plane and scheduler process integration;
- `@aegisflow/sdk`, `@aegisflow/cli`, and `@aegisflow/console` — client/operator surfaces.

## Dependency rule

```text
@aegisflow/contracts
        ^
        |
@aegisflow/core

@aegisflow/persistence ----> contracts + pg
        ^
        |\
        | +---- queue ------> core + persistence + pg
        | +---- gates ------> core + persistence + pg
        | +---- effects ----> core + persistence + pg
        |
        +------ connectors --> effects + pg

flows ------> contracts + core + gates + pg
providers --> contracts + queue + effects + connectors + pg
api -------> contracts + core + effects + gates + flows + pg
sdk -------> contracts
cli -------> contracts + sdk
console ---> contracts + sdk
```

Persistence does not depend back on runtime/authority services. The scheduler does
not create a second state model. Connectors do not create a second side-effect
ledger. Providers compose immutable Agent contracts with worker Claims, provider
Effects, and connector execution.

## Runtime authority model

A Stage may be eligible according to the Flow graph while still lacking authority
to perform work. These concerns remain separate:

1. **Flow scheduler authority** determines graph eligibility, passive waits/signals,
   Gate materialization, skip propagation, and aggregate Execution state.
2. **Gate authority** determines whether protected work is permitted.
3. **Worker Claim authority** determines which worker may advance worker-owned Stage work.
4. **Effect authority** determines whether one logical external side effect may be
   attempted, suppressed, or quarantined for reconciliation.
5. **Pinned Flow Version authority** determines Agent provider, instruction, tool
   allow-list, step budget, and output schema.

A model response never grants any of these authorities.

## Durable graph reconciliation

`@aegisflow/flows` locks an Execution and its materialized Stage rows, validates them
against the pinned Flow Version, and converges immediate graph transitions within a
bounded pass count.

For currently implemented scheduler-owned behavior:

- a `BLOCKED` Stage becomes `READY` only after every dependency succeeds;
- a failed/cancelled/skipped dependency causes blocked descendants to become
  `SKIPPED`, preventing dead graph tails;
- a Signal Stage entering eligibility consumes a matching already-durable Signal,
  including a Signal that arrived while the Stage was still blocked;
- otherwise an eligible Signal Stage becomes `WAITING` until a matching durable
  Signal exists;
- a Wait Stage persists its waiting timestamp in `stage_executions.updated_at` and
  resumes deterministically after its delay or absolute timestamp is due;
- an eligible Gate Stage receives a deterministic durable Gate and remains waiting
  until the Gate ledger resolves it;
- aggregate Stage state drives the parent Execution among `RUNNING`, `WAITING`,
  `SUCCEEDED`, and `FAILED` through the existing core state machine.

The API process runs bounded non-overlapping scheduler ticks. PostgreSQL row locks
serialize concurrent reconcilers for one Execution.

Worker-owned Task/Agent/Action execution remains separate from graph eligibility and
must continue to use the existing Claim/Effect/Gate authorities. General dynamic
graph mutation and arbitrary loops/subflows remain non-goals for V1.

## External-call durability

Every provider step has a stable Effect identity derived from StageExecution + step.
Every connector call has a stable Effect identity derived from StageExecution +
provider step + tool-call ID.

Normalized provider/tool evidence is immutable PostgreSQL evidence. A result cannot
be cross-bound to another StageExecution's Effect.

For provider calls, local evidence insertion and Effect transition to `SUCCEEDED`
are now committed in one PostgreSQL transaction. This removes the previous local
split-state window in which provider evidence could exist while the Effect remained
`CLAIMED`.

If worker authority is lost after a provider returns, the provider Effect is moved
to `RECONCILIATION_REQUIRED` rather than replayed. If a Stage is cancelled while it
still owns a `CLAIMED` Effect, a database trigger quarantines that Effect for
reconciliation. Cancellation therefore cannot permanently strand an in-flight
Effect as authoritative.

These guarantees do not claim exactly-once behavior inside arbitrary external
systems. A remote system may still commit while the process loses the response;
that is why reconciliation exists.

## Connector trust boundaries

Credentials and transports are injected by operator configuration and are not
accepted from Agent tool input or stored in Effect/result evidence.

- Generic HTTP requires HTTPS origins from an explicit allow-list and rejects
  Agent-supplied credential/transport headers.
- GitHub is fixed to `api.github.com` and requires normalized allowed API path prefixes.
- Slack is fixed to `chat.postMessage` and requires explicit allowed channel IDs.

The textual `authorityScope` is durable evidence context; destination enforcement is
mechanical inside each connector.

## Control plane and operator surfaces

The Control API provides Flow registration/version inspection, execution start and
inspection, cancellation, events, Effects, Gates, Signals, reconciliation, and
operator list views. Execution creation and Signal delivery use durable idempotency
keys.

The SDK speaks only to the public API. The CLI and server-rendered console use the
SDK rather than PostgreSQL internals. Console mutation forms are CSRF-protected and
HTML output is escaped. API and console route parsing classify malformed
percent-encoding as client input instead of leaking it into generic 500 handling.

Authentication/RBAC/SSO remain outside the current core-runtime slice. Until an
authentication layer is deliberately added, the Control API and operator console
must remain on a trusted network or behind an authenticated reverse proxy.

## Verification architecture

Hosted CI pins Node 22 and npm 10.9.2 and runs:

- lockfile install reproducibility;
- lint/typecheck/build and package-boundary checks;
- source/unit tests;
- PostgreSQL migration and integration tests;
- durable queue/Effect/Gate/provider/connector/scheduler failure-path tests;
- deterministic PR12 scenario/failure injection suite;
- secret scanning;
- evidence/dependency manifest verification;
- production dependency audit at high severity.

The PostgreSQL test orchestrator runs suites against the current committed migration
chain and no longer renames migration files in the working checkout. A killed test
process therefore cannot leave the repository with hidden/missing migrations.

## Trust boundaries

1. User/API input -> contract and route validation.
2. API submission -> durable idempotency identity.
3. Scheduler -> Execution row lock + pinned Flow Version validation.
4. Human decision -> Gate row lock + immutable resolution evidence.
5. Gate approval -> protected Stage eligibility.
6. Worker -> Claim owner + lease + generation fencing authority.
7. Pinned Agent Stage -> provider registry selection and immutable tool allow-list.
8. Provider output -> bounded normalization + schema/tool validation.
9. Provider invocation -> Effect planning/claim authority + atomic local evidence closure.
10. Tool request -> allow-list + connector-registry preflight.
11. Connector destination -> connector-specific origin/path/channel enforcement.
12. Connector invocation -> Effect planning/claim authority + immutable tool evidence.
13. External uncertainty or cancelled in-flight work -> reconciliation-required, never blind replay.

## Current limits

The current implementation is a strong core/runtime reference, not yet a full
production-readiness claim. Remaining qualification work includes authenticated
identity/RBAC, secrets-management integration, HA/backups/disaster recovery,
production observability and SLO evidence, deployment hardening, real-provider
qualification, and capacity characterization. PostgreSQL-major-version portability
beyond the CI/reference target is not yet established.
