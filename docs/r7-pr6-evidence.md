# R7 PR6 evidence and falsification ledger

## Scope

Roadmap PR6 only: durable human Gate identity, terminal approval/rejection/expiry,
immutable decision evidence, restart-safe state, and protected-work authority on the
PostgreSQL 17 reference target.

## Contract / plan / spec

PR6 preserves PR2 as the legal transition authority:

```text
Gate: WAITING -> APPROVED | REJECTED | EXPIRED
Gate Stage: READY -> RUNNING -> WAITING
Approval: WAITING -> RUNNING -> SUCCEEDED
Rejection/expiry: WAITING -> FAILED
```

Protection and deadline policy are derived from the pinned immutable Flow version.
The Gate caller supplies identity, not a replacement policy document.

The principal invariants are:

1. only a materialized Gate Stage can own Gate authority;
2. Gate opening and protection-edge materialization are atomic;
3. terminal Gate decisions are monotonic;
4. same duplicate decision is idempotent and does not rewrite evidence;
5. conflicting decisions fail deterministically;
6. database time decides deadline expiry;
7. decision evidence is immutable;
8. protected work cannot acquire ACTIVE worker Claim authority unless every
   protecting Gate is APPROVED;
9. database enforcement survives higher-level service bypass;
10. restart does not lose terminal Gate truth.

## Falsification targets executed

The hosted suite attacked:

- Gate creation on a non-Gate Stage;
- Gate identity collision on one Gate Stage;
- Gate creation after protected work already started;
- approval evidence overwrite through duplicate decision;
- concurrent APPROVE versus REJECT;
- late approval after forced deadline expiry;
- duplicate expiry;
- database mutation/deletion of resolution evidence;
- malformed actor and non-JSON evidence;
- queue Claim before approval and transaction rollback afterward;
- two protecting Gates with only one approved;
- cross-Execution Gate/Stage binding;
- service replacement after terminal rejection;
- direct SQL ACTIVE Claim insertion while Gate is unresolved;
- complete migration rollback/reapply through `0004_durable_gates`;
- every existing persistence, worker-claim/fencing, and Effect regression lane.

## First full hosted verification

GitHub Actions run `38976806862`, job `117228101153`, head
`95fba5d80e520f1a7cdc21ffd52c3e6d1d312a6f`.

Observed:

- PostgreSQL 17 service: PASS;
- dependency install: PASS;
- strict TypeScript/build, lint, boundaries, secret scan: PASS;
- contract/core: **30/30 PASS**;
- combined PostgreSQL: **44/44 PASS**;
- Gate-specific: **15/15 PASS**;
- migration rollback/reapply: PASS;
- PR3–PR5 regressions: PASS;
- dependency audit: PASS, zero vulnerabilities;
- overall conclusion: SUCCESS.

## Failure / repair ledger

No PR6 implementation defect was exposed by the first complete hosted run. There is
therefore no F6 repair entry. This does not claim exhaustive proof of all possible
Gate failure modes; it means the declared adversarial set produced no failing
counterexample.

## Evidence boundaries

The executed evidence does not establish:

- authentication or authorization correctness for the opaque actor identifier;
- notification delivery or approval UX;
- arbitrary nested/subflow Gate semantics;
- a general graph scheduler or automatic downstream readiness propagation;
- a continuously running expiry sweeper or a maximum expiration latency;
- provider/connector correctness;
- multi-region/HA, backup/restore, deployment, or production performance.

## R7 closure state

The code-bearing PR6 semantics are **VERIFIED** by run `38976806862`.

The PR remains **PARTIAL / draft** until the PR6 executable/config artifact
manifest is generated, committed, enforced by `npm run verify`, and an exact final
head passes the complete hosted source/PostgreSQL/dependency chain.
