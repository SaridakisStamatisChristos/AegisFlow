# R7 PR2 evidence ledger

## Local verification

Environment: Node.js 22.16.0, npm 10.9.2, TypeScript 5.8.3.

Observed before repository push:

- strict TypeScript compilation of `@aegisflow/core`: PASS;
- core tests: 14/14 PASS;
- terminal Execution/Stage/Attempt/Effect event matrices are adversarially rejected;
- attempt sequence malformed/non-finite/overflow inputs are rejected;
- invalid runtime state/event strings fail closed with `InvalidStateTransitionError`.

This is evidence for the PR2 core package only. PR1 regression coverage and the
repository-wide CI gate remain unverified until the branch is pushed and hosted CI
executes the current head.

## Failure / repair ledger

### F2-001 — malformed runtime input escaped the typed contract

- Reproducer: JavaScript caller supplied an unknown state/event to the generic
  transition lookup.
- Violated requirement: R2-08.
- Root cause: the first implementation indexed the transition table directly and
  trusted TypeScript types at runtime; an unknown state could cause an incidental
  `TypeError`, and an unknown Gate event could resolve to `undefined`.
- Earliest invalidated phase: SPEC.
- Repair: use guarded table/event lookups and explicit `InvalidStateTransitionError`.
- Reverification: added independent adversarial JavaScript-call tests; 14/14 core
  tests pass after repair.

## Claim ledger

- VERIFIED locally: PR2 state-transition functions are deterministic and pure for
  the declared state/event contracts.
- VERIFIED locally: terminal-state and no-blind-replay invariants are enforced by
  executable tests.
- UNVERIFIED: repository-wide regression status on the PR head until hosted CI.
- NOT CLAIMED: durable recovery, database correctness, concurrency safety,
  exactly-once effects, production readiness, or SOTA status.

## Completion state

`CONDITIONAL — hosted repository verification and final manifest pending.`
