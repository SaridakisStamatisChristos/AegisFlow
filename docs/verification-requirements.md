# Verification requirements

The deterministic verification suite exists to prove core AegisFlow runtime semantics without relying on paid external model credentials or unverifiable manual steps.

| Requirement | Acceptance condition |
| --- | --- |
| Flagship Flow | Checked-in Incident Response Flow validates and registers through public interfaces. |
| Deterministic execution | API start, queue claim, durable completion, SDK inspection, and evidence succeed. |
| Agent reasoning | Deterministic provider produces schema-valid output with durable provider Effect evidence. |
| Human Gate | Wait, approval, evidence retention, authority release, and duplicate-decision semantics are verified. |
| External Effect | Same stable identity suppresses duplicate external action. |
| Retry | Expired lease creates a timed-out Attempt followed by a new successful Attempt. |
| Worker crash recovery | A killed worker loses authority and replacement ownership completes under a newer generation. |
| Stale-worker fencing | An obsolete generation cannot authoritatively complete work. |
| Signal idempotency | Durable Signal resumes eligible work and duplicate delivery replays the same Signal identity. |
| Ambiguous side effect | Uncertain external outcome requires explicit reconciliation and is never blindly retried. |
| Public path | At least one end-to-end path crosses API, runtime/worker authority, PostgreSQL, and result inspection. |
| CI execution | The deterministic scenario suite runs as part of hosted CI. |
| No performance overclaim | Timing observations are diagnostic only unless a separate benchmark contract is defined. |

## Hard invariants

1. Successful external Effects are not re-authorized for the same stable identity.
2. Ambiguous external outcomes are never blindly retried.
3. Stale worker generations cannot commit authoritative success.
4. Recovery appends a new Attempt instead of rewriting previous history.
5. Gate decisions and Signals retain their durable/idempotent contracts.
6. Deterministic verification remains usable without external model credentials.
