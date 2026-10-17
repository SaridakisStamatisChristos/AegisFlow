# R7 PR9 requirements — Control API + SDK

## Authority

Roadmap PR9 is limited to the Control API and public SDK. CLI work belongs to PR10 and the operator web console belongs to PR11.

## Required capabilities

- **R9.1 Flow registration/versioning:** validate submitted Flow definitions, create immutable versions, and return deterministic replay for an unchanged latest definition.
- **R9.2 Execution submission:** start an execution pinned to one immutable Flow Version and materialize its Stage executions.
- **R9.3 Idempotency:** durable execution submission identity; exact replay returns the original resource and conflicting key reuse fails closed.
- **R9.4 Inspection:** expose execution state and durable ordered events.
- **R9.5 Cancellation:** cancellation is monotonic, preserves Gate consistency, and fences active worker authority.
- **R9.6 Effects:** expose per-execution Effect inspection and explicit reconciliation without blind retry.
- **R9.7 Gates:** expose Gate inspection and durable approve/reject decisions through the existing Gate ledger.
- **R9.8 Signals:** store named Signals durably, make duplicate submission deterministic, and resume eligible Signal Stages through existing state transitions.
- **R9.9 SDK:** a typed TypeScript client uses only the public HTTP API and can drive a real PostgreSQL-backed execution.
- **R9.10 API validation:** bounded JSON input, structured errors, contract identifier validation, and no secret-bearing diagnostic dumps.
- **R9.11 Regression closure:** existing PR1–PR8 tests and invariants remain valid.

## Acceptance evidence

PR9 is merge-ready only if CI observes all existing verification gates plus the new SDK unit test and PostgreSQL-backed API/SDK integration scenario. A local design review or a workflow file alone is not sufficient evidence.

The integration scenario must demonstrate at least Flow versioning, exact idempotent execution replay, conflicting idempotency-key rejection, durable Signal replay/conflict behavior, a durable Gate decision, cancellation of a pending Gate execution, ambiguous Effect reconciliation, and SDK-driven inspection.

## Explicit non-goals

- CLI implementation.
- Web/operator console.
- visual Flow builder.
- enterprise IAM/RBAC/SSO.
- arbitrary scripting.
- automatic retry of ambiguous Effects.
- replacement of existing queue, Gate, Effect, provider, or connector semantics.
