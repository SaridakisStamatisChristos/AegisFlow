# R7 PR6 requirement closure matrix

Scope: roadmap PR6 only — durable human Gate identity, approval/rejection/expiry
evidence, restart-safe decisions, and protected-work authority on PostgreSQL 17.

| ID | Requirement | Evidence | State |
|---|---|---|---|
| R6-01 | PR6 remains isolated from providers/connectors, API/SDK/CLI, UI, authN/authZ policy, and generic graph scheduling. | Package boundary, PR diff, docs. | VERIFIED |
| R6-02 | A Gate can bind only to a materialized Gate Stage and derives deadline/protection edges from the pinned immutable Flow version. | `createGate`; non-Gate, cross-Execution, and protection-derivation tests. | VERIFIED |
| R6-03 | Gate Stage and durable Gate state advance through PR2 state machines without terminal reopening. | `transitionGate` / `transitionStageExecution`; approval/rejection/expiry tests. | VERIFIED |
| R6-04 | Approval/rejection persist actor, database time, and bounded JSON evidence. | `gate_resolutions`; approval/evidence test. | VERIFIED |
| R6-05 | Matching duplicate decision is idempotent and cannot overwrite original evidence. | Duplicate approval test; immutable resolution table. | VERIFIED |
| R6-06 | Conflicting concurrent decisions produce one durable winner and deterministic conflict. | Concurrent APPROVE vs REJECT test. | VERIFIED |
| R6-07 | Database clock controls expiry; a late human decision cannot beat an elapsed deadline. | `expires_at`, locked due check, late-decision test, expiry sweep test. | VERIFIED |
| R6-08 | Gate resolution evidence is database-enforced immutable. | mutation trigger plus UPDATE/DELETE adversarial test. | VERIFIED |
| R6-09 | Protected Stage work cannot acquire ACTIVE worker authority until all protecting Gates are approved. | Claim trigger; queue bypass test. | VERIFIED |
| R6-10 | Protection remains fail-closed against direct SQL Claim insertion and supports multiple Gates per Stage. | direct SQL bypass and unanimous-multi-Gate tests. | VERIFIED |
| R6-11 | Gate creation fails atomically if protected work already started. | started-protected-work test verifies no Gate and Gate Stage remains READY. | VERIFIED |
| R6-12 | Restart/replacement of the Gate service reconstructs durable terminal state and evidence. | replacement-ledger test. | VERIFIED |
| R6-13 | Gate/protected Stage ownership cannot cross Execution boundaries. | composite FKs + cross-Execution test. | VERIFIED |
| R6-14 | Migration `0004_durable_gates` is reversible and PR3–PR5 persistence/queue/effect semantics remain green. | migration rollback/reapply + full PostgreSQL suite. | VERIFIED |
| R6-15 | Strict TypeScript, package boundaries, text hygiene, secret scan, and runtime dependency audit pass. | GitHub Actions run `38976806862`, job `117228101153`. | VERIFIED |
| R6-16 | Declared executable/config PR6 artifacts have reproducible SHA-256 closure and the exact final head passes hosted verification. | PR6 manifest + final-head CI. | PARTIAL — manifest/final-head gate pending |
| R6-17 | Authentication/RBAC, notifications/UI, provider/connectors, generic scheduling, continuous sweeper latency, HA/backup, and SOTA claims are excluded. | Scope docs and PR body. | N/A — explicitly outside PR6 |

## First full hosted verification

Run `38976806862`, job `117228101153`, code head
`95fba5d80e520f1a7cdc21ffd52c3e6d1d312a6f`:

- source/package verification: PASS;
- contract/core tests: **30/30 PASS**;
- PostgreSQL persistence + queue + effects + gates tests: **44/44 PASS**;
- Gate-specific adversarial tests: **15/15 PASS**;
- migration `0004_durable_gates` rollback/reapply: PASS;
- PR3–PR5 regression lanes: PASS;
- runtime dependency audit: PASS, zero vulnerabilities reported;
- overall job: SUCCESS.

No PR6 implementation defect was exposed by the first complete hosted verification
run. R7 records that result directly rather than inventing a repair event.

## Completion rule

PR6 may be promoted to **VERIFIED / MERGE-READY** only when R6-16 is VERIFIED on
the exact final branch head. A later change to a manifest-covered artifact requires
manifest regeneration and dependent-gate re-verification.
