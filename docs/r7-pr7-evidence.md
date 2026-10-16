# R7 PR7 evidence and falsification ledger

## Scope

Roadmap PR7 only: vendor-neutral provider abstraction, durable normalized provider evidence, and one
Agent Stage provider step composed with PR4 worker Claims and PR5 Effect authority.

## Principal invariants

1. Agent configuration comes from the pinned immutable Flow Version.
2. Provider invocation cannot bypass worker Claim authority.
3. Every provider call is represented by one stable Effect identity.
4. Durable normalized provider evidence is written before an Effect is called successful.
5. Recovery never blindly repeats an unknown provider call.
6. Provider evidence is immutable and StageExecution-bound.
7. Schema validation and tool allow-list checks fail closed.
8. PR7 does not execute tools or import provider-specific networking/credential logic.

## Failure / repair ledger

### F7-001 — provider declaration dependency ordering

First hosted run `38981649579` failed source verification because provider TypeScript resolution ran
before queue/effects declarations had been emitted. The earliest invalid phase was build/typecheck
ordering, not runtime logic. Repair `9ab4aae54698be4d8df0ab1e138654a8bca1bba7` builds queue/effects
declarations before the provider no-emit check. The dependent source gate passed afterward.

### F7-002 — stale migration-chain regression

Run `38981731731` reached PostgreSQL and exposed a legacy persistence test that hard-coded migration
`0004_durable_gates` as the latest migration. The attempted test-name filter was not a reliable
suppression boundary. The repair updated the canonical persistence migration regression to include
`0005_agent_provider_results`, roll it back before `0004`, and reapply the complete chain. The
brittle skip workaround was removed. Commits `58f4eecebb9822e33d1e876b1685f4718e6a0c17` and
`61e5266ff6d44b7a73243175705a087d93e05a26` closed this harness defect.

### F7-003 — normalized JSON object prototype shape

Run `38981931104` passed migration, persistence, queue, effects, gates, and 10/11 Agent integration
tests. The only failure was strict equality between ordinary JSON `{status:"ok"}` and a normalized
null-prototype object with the same data. Repair `13e7765c736a4376830029755f70d579f64a579b`
restored ordinary JSON object semantics while defining keys through `Object.defineProperty`, so an
own `__proto__` property cannot mutate the object prototype. A dedicated regression was added and
passed before closure.

## First complete green code run

Run `38982103029`, job `117245080217`, head
`13e7765c736a4376830029755f70d579f64a579b`:

- source/unit tests: **35/35 PASS**;
- persistence PostgreSQL: **8/8 PASS**;
- worker queue/fencing: **8/8 PASS**;
- Effect ledger/reconciliation: **13/13 PASS**;
- Gate authority: **15/15 PASS**;
- Provider/Agent integration: **11/11 PASS**;
- combined PostgreSQL integration: **55/55 PASS**;
- migration `0005_agent_provider_results` rollback/reapply: PASS;
- runtime dependency audit: PASS, zero vulnerabilities reported;
- overall job: SUCCESS.

## Expanded closure run

Run `38982342831`, job `117245841783`, head
`25b47f16a90334e119b33301b6f59204aab9b985` added the explicit `__proto__` regression and expanded
the closure surface to 17 executable/config/test artifacts:

- source/unit tests: **36/36 PASS**;
- PostgreSQL integration: **55/55 PASS**;
- prototype-mutation regression: PASS;
- dependency audit: PASS, zero vulnerabilities;
- deterministic 17-artifact SHA-256 values emitted;
- overall job: SUCCESS.

## Manifest enforcement

The emitted hashes were committed unchanged in `docs/r7-pr7-manifest.sha256` at head
`bccf379c1076611538dd14ae927316fc6510b865`.

Run `38982468778`, job `117246250332` then enforced that manifest through ordinary `npm run verify`:

- `pr7-manifest: verified 17 executable/config artifacts`;
- source/unit tests: **36/36 PASS**;
- persistence PostgreSQL: **8/8 PASS**;
- worker queue/fencing: **8/8 PASS**;
- Effect ledger/reconciliation: **13/13 PASS**;
- Gate authority: **15/15 PASS**;
- Provider/Agent integration: **11/11 PASS**;
- combined PostgreSQL integration: **55/55 PASS**;
- runtime dependency audit: PASS, zero vulnerabilities;
- overall job: SUCCESS.

## Evidence boundaries

The executed evidence does not establish provider-specific HTTP/API correctness, credential
handling, generic exactly-once external model execution, multi-step tool loops, connector
correctness, authenticated actor identity/RBAC, HA/backup/deployment readiness, production
performance, or SOTA status. The repository has no committed `package-lock.json`, so the PR7
manifest closes declared source/config/test artifacts rather than the transitive dependency graph.

## Closure state

The declared executable/config/test PR7 surface is **VERIFIED** through manifest enforcement on
`bccf379c1076611538dd14ae927316fc6510b865`. This evidence-ledger update is documentation-only and
changes no manifest-covered artifact. PR promotion still requires one complete hosted run on the
exact resulting branch head; that final-head run is recorded in PR metadata rather than committed
back into this file, avoiding a self-invalidating evidence loop.
