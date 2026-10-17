# R7 PR12 Evidence Record — Demo and Benchmark Suite

Revision state: **VERIFIED** on implementation head `91b4b937c83f7fbd62ce52ea2f23a4fb01f48029` by GitHub Actions CI run #255 (`39013841968`). This evidence-sealing revision must itself pass the same CI gates before merge.

## Requirement coverage

| Requirement | Executed evidence | State |
| --- | --- | --- |
| R12-01 | `flagship-incident-definition`: checked-in six-stage Incident Response Flow registered through SDK/API and materialized with canonical READY/BLOCKED states. | VERIFIED |
| R12-02 | `deterministic-flow`: API start -> queue claim/completion -> durable SDK Stage state + execution evidence. | VERIFIED |
| R12-03 | `agent-reasoning`: deterministic provider called once; schema-valid `{severity:"high"}`; provider Effect `SUCCEEDED`. | VERIFIED |
| R12-04 | `human-gate`: WAITING -> APPROVED, dependent authority released, duplicate approval `changed=false`, first evidence preserved. | VERIFIED |
| R12-05 | `external-effect`: connector external-call count remained 1 across durable replay; Effect `SUCCEEDED`. | VERIFIED |
| R12-06 | `transient-failure-retry`: two Attempts recorded as `TIMED_OUT`, then `SUCCEEDED`. | VERIFIED |
| R12-07 | `worker-crash-recovery`: child process claimed work, was killed, replacement recovered generation 2 and completed. | VERIFIED |
| R12-08 | `stale-worker-fencing`: generations 1 -> 2; stale completion rejected before fresh completion. | VERIFIED |
| R12-09 | `wait-signal-resume`: one Stage resumed; duplicate Signal idempotency key replayed same durable Signal. | VERIFIED |
| R12-10 | `ambiguous-effect-reconciliation`: Effect `RECONCILIATION_REQUIRED`; explicit `CONFIRMED_FAILED` reconciliation recorded. | VERIFIED |
| R12-11 | Harness started real loopback Control API, drove SDK surfaces, used production queue/provider/connector/Gate/Effect authorities, and persisted in PostgreSQL. | VERIFIED |
| R12-12 | CI #255 executed the PR12 command after normal PostgreSQL regressions. | VERIFIED |
| R12-13 | Existing architecture boundary gate plus complete PR1-PR11 regression suite passed. | VERIFIED |
| R12-14 | Structured report declared semantic-correctness benchmark and no performance claim. | VERIFIED |
| R12-15 | Lockfile install, mutation check, 65/65 non-PostgreSQL tests, full PostgreSQL suites, secret scan, dependency manifest, and audit all passed. | VERIFIED |
| R12-16 | CI-generated PR12 artifact hashes are sealed in `docs/r7-pr12-manifest.sha256`; final head verification remains required. | CONDITIONAL |

## Executed PR12 report

CI #255 emitted:

```text
PASS flagship-incident-definition
PASS deterministic-flow
PASS agent-reasoning
PASS human-gate
PASS external-effect
PASS transient-failure-retry
PASS worker-crash-recovery
PASS stale-worker-fencing
PASS wait-signal-resume
PASS ambiguous-effect-reconciliation
summary: 10 passed / 0 failed
```

Selected semantic observations from the executed report:

- flagship Flow: 6 stages, exactly one root READY at materialization;
- deterministic Flow: Stage `SUCCEEDED`, one durable execution-start evidence event;
- Agent: one provider call, provider Effect `SUCCEEDED`;
- external Effect: one external connector call despite replay;
- retry: Attempt states `[TIMED_OUT, SUCCEEDED]`;
- killed worker: replacement generation `2`, two Attempts total;
- stale fencing: old generation rejected, generations `[1, 2]`;
- Signal: one resumed Stage, duplicate delivery replayed;
- ambiguous Effect: state `RECONCILIATION_REQUIRED`, then explicit `CONFIRMED_FAILED` reconciliation.

Elapsed scenario durations are intentionally not acceptance evidence and support no performance claim.

## R7 falsification / repair history

1. CI #253 reached typecheck, all 65 existing unit/adversarial tests, architecture boundaries, secret scan, and deterministic PR12 hash generation successfully. It stopped only because `docs/dependency-lock-manifest.sha256` still represented PR11 while PR12 had intentionally changed root scripts and CI.
2. The dependency checksum ledger was refreshed exactly from CI #253's generated 16-artifact output; no dependency declarations or lockfile content changed.
3. CI #255 then passed the full chain, including all pre-existing PostgreSQL suites, the new PR12 scenario harness, and runtime dependency audit.
4. The PR12 scenario harness passed all 10 scenarios, including the real child-process `SIGKILL` recovery test.
5. The PR12 artifact checksum ledger is now sealed from CI #255's generated hashes; the sealing commit must pass a final exact-head CI run.

## Falsification targets exercised

- flagship Flow rejected by canonical contract validation;
- benchmark passing without public API/SDK where those surfaces exist;
- duplicate Effect causing a second external call;
- transient recovery rewriting Attempt history;
- fake worker crash simulated only by direct state edits;
- stale generation able to complete;
- duplicate Signal creating a second durable Signal;
- ambiguous connector outcome blindly retried;
- reconciliation omitted after ambiguous state;
- child process hanging the CI job;
- timing variance acting as an acceptance threshold;
- install/package-lock drift;
- PR1-PR11 PostgreSQL/runtime regression;
- dependency/artifact manifest drift.

## Claims ledger

| Claim | State |
| --- | --- |
| PR12 scenario harness is implemented | VERIFIED |
| The nine required handoff behavioral scenarios pass | VERIFIED |
| The flagship Incident Response Flow contract scenario passes | VERIFIED |
| The process-kill scenario uses a real killed worker process | VERIFIED |
| PR12 preserves prior authority and evidence invariants | VERIFIED |
| PR12 completes the implementation roadmap | VERIFIED |
| PR12 is merge-ready | CONDITIONAL — final evidence-sealing head must pass CI |

No throughput, latency superiority, production-authentication, visual-builder, or enterprise-readiness claim is made by PR12.
