# R7 PR2 evidence ledger

## Local verification

Environment: Node.js 22.16.0, npm 10.9.2, TypeScript 5.8.3.

Observed before repository push:

- strict TypeScript compilation of `@aegisflow/core`: PASS;
- core tests: 14/14 PASS;
- terminal Execution/Stage/Attempt/Effect event matrices are adversarially rejected;
- attempt sequence malformed/non-finite/overflow inputs are rejected;
- invalid runtime state/event strings fail closed with `InvalidStateTransitionError`.

## Hosted verification

Code-bearing head `c9c61defbac2ee8f3a42d327be9913f60d59b93e` was exercised by
GitHub Actions run `38966542260`:

- checkout/setup: PASS;
- fresh toolchain install: PASS;
- repository-wide `npm run verify`: PASS;
- runtime dependency audit: PASS;
- job conclusion: SUCCESS.

This run covers PR1 regression tests plus PR2 core tests and the expanded architecture
boundary checks. The final R7 closure commit changes only evidence/manifest metadata;
PR readiness still requires CI to remain green on that final head.

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
- VERIFIED: repository-wide regression status on the code-bearing PR2 revision by
  hosted run `38966542260`.
- NOT CLAIMED: durable recovery, database correctness, concurrency safety,
  exactly-once effects, production readiness, or SOTA status.

## Completion state

`VERIFIED FOR DECLARED PR2 TARGET`

This verdict is limited to the pure deterministic state-machine slice. It does not
extend to PR3+ persistence, concurrency, Effects/Gates durability, providers,
connectors, APIs, deployment, or production readiness.
