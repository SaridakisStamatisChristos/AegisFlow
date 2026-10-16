# R7 PR4 evidence and repair ledger

## Scope

Roadmap PR4 only: durable worker Claims, leases, generation fencing,
heartbeat/expiry, and recovery of abandoned Stage work. Effect idempotency (PR5),
Gates (PR6), providers/connectors, API/SDK/CLI, deployment, and UI are outside this
slice.

## Contract / plan / spec

The authoritative hand-off requires claim acquisition, leases, generation fencing,
heartbeat/expiry, killed-worker recovery, stale-completion rejection, and preserved
Attempt history. PR4 implements those semantics in `@aegisflow/queue` with
PostgreSQL migration `0002_worker_claims`.

## Local evidence before hosted PostgreSQL

- queue source passed strict TypeScript compilation against temporary interface
  stubs for its workspace/external modules;
- queue and modified persistence integration-test sources passed Node syntax checks;
- package JSON and repository scripts passed local syntax/hygiene inspection;
- no PostgreSQL server was available locally, so database behavior was not claimed
  passed from local execution.

## Hosted falsification targets

1. simultaneous workers claiming one READY Stage;
2. exact-generation heartbeat and expired-lease non-resurrection;
3. killed-worker recovery with old Attempt -> `TIMED_OUT`;
4. stale generation completion after recovery;
5. two concurrent finishers of the same generation;
6. completion after lease expiry;
7. repeated recoveries preserving generations and Attempt history;
8. non-claimable Stage rejection without durable residue;
9. invalid lease rejection before mutation;
10. PR3 persistence and migration regression suite.

## Failure / repair ledger

### F4-001 — queue typecheck could not resolve workspace dependency declarations

- **Observed evidence:** GitHub Actions run `38970682562`, job `117208013828`.
  PostgreSQL initialized successfully and dependency installation passed, but source
  verification failed before database tests.
- **Reproducer:** execute the initial PR4 root `npm run verify` after a clean install.
- **Observed errors:** TypeScript could not resolve `@aegisflow/core` and
  `@aegisflow/persistence` from queue, followed by derivative untyped-call errors.
- **Violated requirement:** reproducible source/package verification for the new
  queue package.
- **Root cause:** workspace package exports point TypeScript to emitted
  `dist/*.d.ts`. The initial root `typecheck` emitted only `contracts`, checked core
  and persistence with `--noEmit`, then checked queue. Queue therefore had no core
  or persistence declaration artifacts to resolve.
- **Earliest invalidated phase:** INTEGRATE. Queue semantics and PostgreSQL behavior
  had not yet been executed by hosted CI.
- **Selective repair:** change root typecheck ordering to build contracts, core, and
  persistence before checking queue with `--noEmit`.
- **Dependent gates rerun:** clean dependency install, source/package verification,
  all contract/core tests, all PR3+PR4 PostgreSQL integration tests, architecture
  boundaries, secret scan, and runtime dependency audit.
- **Reverification:** repaired code head `fb8949ad3af95e451468c3ccd33204db91ee732a`
  passed GitHub Actions run `38970767191`, job `117208297018`.
- **State:** VERIFIED REPAIRED.

## Repaired-head execution evidence

Run `38970767191` on head `fb8949ad3af95e451468c3ccd33204db91ee732a`:

- PostgreSQL 17 service: PASS;
- clean dependency install: PASS, 0 vulnerabilities reported by install audit;
- lint/typecheck/build and architecture boundaries: PASS;
- contracts/core suite: **30/30 PASS**;
- combined PostgreSQL persistence + queue suite: **16/16 PASS**;
- PR3 migration/repository regressions: PASS;
- concurrent claim race: PASS;
- heartbeat/fencing/expiry tests: PASS;
- killed-worker recovery + stale completion rejection: PASS;
- duplicate-finisher race: PASS;
- repeated recovery/history preservation: PASS;
- runtime dependency audit: PASS, 0 vulnerabilities.

## Current evidence state

**VERIFIED for the declared PR4 semantics on PostgreSQL 17 at the repaired code
head. Final documentation/manifest head still requires one exact-head hosted rerun
before the PR is marked merge-ready.**
