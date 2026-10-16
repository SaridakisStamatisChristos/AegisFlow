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

## Failure / repair ledger

No PR5 implementation defect was exposed by the first complete hosted verification run. Therefore there is no F5 repair entry to record. This is not evidence that all possible Effect failures have been exhausted; it means the declared falsification set executed without producing a failing counterexample.

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

The code-bearing PR5 semantics are **VERIFIED** by run `38974419026`.

The PR remains **PARTIAL / draft** until:

1. `docs/r7-pr5-manifest.sha256` is generated from the repository's deterministic artifact verifier;
2. the manifest is checked by `npm run verify`;
3. the exact final PR head passes the complete hosted source, PostgreSQL, and dependency-audit chain.
