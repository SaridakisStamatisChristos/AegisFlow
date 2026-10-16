# R7 PR5 evidence and falsification ledger

## Scope

Roadmap PR5 only: durable Effect identity, stable-key duplicate suppression, external-call claim authority, terminal outcome visibility, ambiguity quarantine, and immutable reconciliation evidence on the PostgreSQL 17 reference target.

Durable human Gates (PR6), providers/connectors, connector-native idempotency/reconciliation, API/SDK/CLI, deployment, HA/backup, and UI are outside this slice.

## Contract / plan / spec

PR5 preserves the PR2 Effect state machine rather than defining a second one:

```text
PLANNED -> CLAIMED -> SUCCEEDED
                   -> FAILED
                   -> RECONCILIATION_REQUIRED
```

The three outcome states remain terminal. Reconciliation is stored separately so external truth can be recorded without mutating the original terminal Effect.

The principal invariants are:

1. one stable `effectKey` per logical Effect within an Execution;
2. same key + same canonical intent converges to one Effect;
3. same key + different Stage/intent fails closed;
4. only a claimed Effect authorizes one connector call attempt;
5. prior success suppresses replay;
6. known failure does not silently replay;
7. ambiguity requires reconciliation rather than blind retry;
8. reconciliation is immutable and conflict-detecting;
9. confirmed success suppresses replay while confirmed failure remains blocked;
10. the ledger does not claim generic exactly-once delivery.

## Falsification targets executed

The hosted PostgreSQL suite attacked:

- canonical intent order dependence and non-JSON values;
- 12 concurrent planners using one key;
- same key with changed canonical intent;
- two concurrent claimers;
- replay after known success;
- replay after known failure;
- replay while outcome is ambiguous;
- identical versus conflicting reconciliation;
- reconciliation-confirmed failure;
- two concurrent completion writers;
- cross-Execution Stage binding;
- database mutation of reconciliation evidence;
- invalid key input leaving durable state untouched;
- full migration rollback/reapply through `0003_effect_ledger`;
- all prior PR3 persistence and PR4 worker-authority regressions.

## First full hosted verification

GitHub Actions run `38974419026`, job `117220288024`, head:

`dcfc2da89aa5200ccae0bc37947e3f964206d41a`

Observed results:

- PostgreSQL 17 service initialization: PASS;
- clean dependency install: PASS;
- strict TypeScript/build, lint, package boundaries, and secret scan: PASS;
- contract/core suite: **30/30 PASS**;
- PostgreSQL persistence + queue + effects suite: **29/29 PASS**;
- Effect-specific adversarial tests: **13/13 PASS**;
- migration `0003_effect_ledger` rollback/reapply: PASS;
- PR3 persistence regression lane: PASS;
- PR4 queue/fencing/recovery regression lane: PASS;
- runtime dependency audit: PASS, zero vulnerabilities reported;
- overall job conclusion: SUCCESS.

## Manifest closure

The repository verifier `scripts/hash-pr5-artifacts.mjs` hashes 14 executable/configuration/test artifacts with SHA-256.

Run `38974899162`, job `117221860255`, generated the exact hashes while `docs/r7-pr5-manifest.sha256` was intentionally absent. The same run passed source verification, **30/30** contract/core tests, **29/29** PostgreSQL tests, and the runtime dependency audit.

Those generated values were committed verbatim as `docs/r7-pr5-manifest.sha256`.

Run `38975007765`, job `117222217416`, head:

`c36af015608200f7a55c183abdffef548489ad35`

then executed the manifest as an enforcement gate. `npm run verify` compared the current artifacts against the committed manifest and passed, followed by the complete PostgreSQL migration/persistence/queue/effects suite and runtime dependency audit. Overall conclusion: SUCCESS.

## Failure / repair ledger

No PR5 implementation defect was exposed by the complete hosted verification runs. Therefore there is no F5 repair entry to record. This is not evidence that all possible Effect failures have been exhausted; it means the declared falsification set executed without producing a failing counterexample.

R7 requires discovered failures to be preserved, but it also forbids inventing failures merely to populate a repair narrative.

## Evidence boundaries

The verified tests demonstrate database/runtime behavior only for the declared PostgreSQL 17 reference target and synthetic external outcomes. They do **not** demonstrate:

- exactly-once behavior of an arbitrary remote provider;
- provider-native idempotency key forwarding;
- correctness of a Slack/GitHub/HTTP connector;
- remote reconciliation during real network partitions;
- automatic retry policy for terminal failed Effects;
- production throughput, HA, backup, or disaster recovery.

PR5 intentionally blocks automatic replay of `FAILED` and reconciliation-confirmed failure. An explicit retry-lineage mechanism, if later required, must preserve PR2 terminal-state monotonicity rather than reopening a terminal Effect.

## R7 closure state

All declared PR5 semantic, migration, regression, dependency, and executable-manifest requirements are **VERIFIED**.

A documentation-only closure commit changes the branch SHA but not any manifest-covered executable artifact. Before PR5 is promoted to **MERGE-READY**, the current pull-request head must still pass the same complete hosted workflow. That current-head result is recorded in the pull-request body after observation, avoiding a self-referential cycle where editing this evidence document to mention the latest successful run creates yet another unverified head.
