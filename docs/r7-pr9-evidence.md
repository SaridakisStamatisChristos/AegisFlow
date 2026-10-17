# R7 PR9 evidence record — Control API + SDK

## Reconstruction

PR9 was reconstructed against the hardened main branch after roadmap PR8. Existing durable semantics were reused rather than reimplemented: immutable Flow Versions, deterministic state machines, lease/generation fencing, the Effect ledger, durable Gates, provider boundaries, connectors, and PostgreSQL migrations 0001–0006.

## Implemented evidence surfaces

- `packages/api` — PostgreSQL-backed control service plus dependency-light Node HTTP adapter.
- `packages/sdk` — typed public HTTP client with structured errors.
- `packages/persistence/migrations/0007_control_api.*` — Flow-name lineage identity, durable submission idempotency, immutable durable Signals.
- `packages/api/test/control-api.integration.test.mjs` — public SDK → HTTP API → PostgreSQL integration path covering PR9 acceptance scenarios.
- `packages/sdk/test/client.test.mjs` — SDK request/header/error contract tests.
- `docs/control-api.md` — API, idempotency, cancellation, Signal, Effect, and deployment semantics.

## Adversarial findings addressed before submission

1. **Gate cancellation contradiction:** blindly cancelling a `WAITING` Gate Stage would leave the Gate ledger in `WAITING` while the Stage became `CANCELLED`, violating the existing Gate snapshot invariant. Cancellation now terminalizes unresolved Gates as `EXPIRED`, records immutable resolution evidence, and sets the Gate Stage to `FAILED` before cancelling remaining Stages.
2. **Stale worker authority after cancellation:** a Stage with an active Claim cannot merely be relabeled `CANCELLED`; otherwise a still-running worker could retain apparent authority. Cancellation terminalizes a running/claimed Attempt where legal and marks its active Claim non-authoritative before cancelling the Stage.
3. **Signal regression through new FK:** adding a conventional Signal→Execution foreign key would make legacy PR1–PR8 test cleanup order invalid by introducing a new parent-table truncation dependency. The migration instead database-validates execution existence on insert and makes Signals immutable. The public API exposes no execution deletion.
4. **Ambiguous Effect replay:** the API exposes the existing reconciliation primitive and does not introduce a retry shortcut for `RECONCILIATION_REQUIRED` Effects.
5. **Model/provider authority expansion:** PR9 does not add any path from model output directly to external authority. It only exposes already-governed Gate and Effect primitives.

## Verification contract

Required commands in CI:

```text
npm ci --ignore-scripts
npm run verify
npm run test:postgres
npm audit --omit=dev --audit-level=high
```

`npm run verify` includes dependency/config hash verification and the PR9 artifact manifest. `npm run test:postgres` includes the new API/SDK end-to-end suite after the prior durable-runtime suites.

## Evidence state

Implementation evidence is present in the branch. Merge readiness remains **UNVERIFIED** until the pull-request CI run for the final head commit is observed green. This document deliberately does not pre-claim CI success.
