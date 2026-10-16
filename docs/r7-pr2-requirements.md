# R7 PR2 requirement ledger

Scope: roadmap PR2 only — pure deterministic state machines. PostgreSQL,
worker/lease concurrency, external side effects, durable Gates, provider calls,
connectors, and network APIs are explicitly out of scope.

| ID | Requirement | Source | Criticality | Acceptance evidence | Surface | State |
| --- | --- | --- | --- | --- | --- | --- |
| R2-01 | `@aegisflow/core` contains pure state-machine logic and depends only on `@aegisflow/contracts` plus relative modules. | HANDOFF | HARD | boundary check + source inspection | `packages/core`, boundary script | VERIFIED locally |
| R2-02 | Execution terminal states never revive; cancellation is monotonic. | HANDOFF | HARD | exhaustive terminal tests + transition tests | execution machine | VERIFIED locally |
| R2-03 | Stage terminal states never revive; skip is allowed only before work starts. | HANDOFF | HARD | exhaustive terminal tests + skip tests | stage machine | VERIFIED locally |
| R2-04 | A retry never reopens an Attempt; a new positive safe sequence is allocated. | HANDOFF | HARD | terminal-attempt tests + numeric falsification | attempt machine | VERIFIED locally |
| R2-05 | Gate duplicate identical decisions are idempotent and conflicting decisions are deterministic failures. | HANDOFF | HARD | duplicate/conflict tests | Gate machine | VERIFIED locally |
| R2-06 | Ambiguous Effect outcomes enter reconciliation and cannot blind-replay. | HANDOFF | HARD | reconciliation terminal tests | Effect machine | VERIFIED locally |
| R2-07 | Decision branch selection is deterministic without adding an expression language or mutating the Flow graph. | PR1 architecture | HARD | choice validation/order/immutability tests | branch resolver | VERIFIED locally |
| R2-08 | Malformed runtime state/event input fails closed with domain errors rather than incidental `TypeError`/undefined state. | R7 | HARD | adversarial JavaScript-call tests | transition engine | VERIFIED locally |
| R2-09 | Repository verification includes both PR1 contracts and PR2 core. | R7 | HARD | hosted `npm run verify` on code-bearing PR head | root scripts + CI | VERIFIED — run `38966542260` on `c9c61def...` |
| R2-10 | Public documentation matches implemented transition semantics and states later-slice boundaries. | R7 | SHOULD | doc/source comparison | README + architecture + state docs | VERIFIED locally |
| R2-11 | PR2 generated/modified artifacts have real SHA-256 evidence. | R7 | HARD | checksum manifest | PR2 manifest | VERIFIED — `docs/r7-pr2-manifest.sha256` |

## Hard invariants

1. No terminal Execution, StageExecution, Attempt, or Effect state transitions back to active work.
2. `CANCELLED` never returns to an active state.
3. Retry allocates a new Attempt sequence; it does not mutate a terminal Attempt.
4. A resolved Gate accepts only the identical duplicate decision; conflicting decisions fail.
5. `RECONCILIATION_REQUIRED` never authorizes automatic Effect replay.
6. State-machine outputs are deterministic functions of explicit inputs only.
7. PR2 does not claim durability, exactly-once delivery, lease fencing, or production readiness.

## Applicability

Database migrations, dependency outage behavior, worker concurrency, auth/tenant
boundaries, readiness/liveness, external connector idempotency, deployment, DAST,
and load testing are `N/A` for this pure in-memory package slice. Their roadmap
requirements remain open in later PRs; they are not waived.
