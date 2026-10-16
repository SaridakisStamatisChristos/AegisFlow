# R7 PR5 requirement closure matrix

Scope: roadmap PR5 only — durable Effect identity, idempotency, terminal outcome visibility, ambiguity quarantine, and immutable reconciliation evidence on the PostgreSQL 17 reference target.

| ID | Requirement | Evidence | State |
|---|---|---|---|
| R5-01 | PR5 remains isolated from Gates, providers/connectors, API/SDK/CLI, and UI. | `@aegisflow/effects` package boundary and PR diff; architecture boundary script. | VERIFIED |
| R5-02 | One logical Effect has a stable key within one Execution; concurrent identical planning converges on one row. | `effects_execution_key_unique`; 12-way concurrent planning integration test. | VERIFIED |
| R5-03 | Reusing an Effect key for a different Stage or canonical intent fails closed. | Stage/digest readback checks; key-mismatch and cross-Execution tests. | VERIFIED |
| R5-04 | Intent comparison does not require persisting raw connector payload. | Canonical JSON SHA-256 digest implementation and schema storing only `intent_digest`; canonicalization tests. | VERIFIED |
| R5-05 | Only one caller can acquire authority for an external call from a PLANNED Effect. | Effect row lock + PR2 `CLAIM`; concurrent claim integration test. | VERIFIED |
| R5-06 | A prior successful Effect suppresses accidental replay. | `SUPPRESSED_SUCCEEDED`; success replay integration test. | VERIFIED |
| R5-07 | Known failure remains terminal and visible instead of being silently retried. | PR2 terminal state preserved; `KNOWN_FAILED`; failure replay test. | VERIFIED |
| R5-08 | Ambiguous external outcome becomes `RECONCILIATION_REQUIRED` and blocks blind replay. | `AMBIGUOUS` completion mapping; ambiguity quarantine integration test. | VERIFIED |
| R5-09 | Reconciliation is separate immutable evidence; identical duplicates are idempotent and conflicts fail. | `effect_reconciliations`; DB mutation trigger; idempotency/conflict/immutability tests. | VERIFIED |
| R5-10 | Reconciliation cannot bypass terminal-state monotonicity or silently authorize replay. | Original Effect remains terminal; confirmed-success suppression and confirmed-failure blocking tests. | VERIFIED |
| R5-11 | Two concurrent completion writers cannot both authoritatively resolve one claimed Effect. | Effect row lock and state check; two-writer completion test. | VERIFIED |
| R5-12 | Effect ownership cannot cross-bind an Execution to another Execution's Stage. | Composite Stage/Execution FK plus application ownership check; adversarial test. | VERIFIED |
| R5-13 | Migration `0003_effect_ledger` is reversible and PR3/PR4 persistence/queue semantics remain green. | Full migration rollback/reapply test plus existing persistence and queue suites. | VERIFIED |
| R5-14 | Strict TypeScript, package boundaries, text hygiene, secret scan, and runtime dependency audit pass. | GitHub Actions run `38974419026`, job `117220288024`. | VERIFIED |
| R5-15 | Declared executable PR5 artifacts have reproducible SHA-256 closure and the exact final head passes hosted verification. | `scripts/hash-pr5-artifacts.mjs`, `docs/r7-pr5-manifest.sha256`, final-head CI. | PARTIAL — final manifest/head gate pending |
| R5-16 | Generic exactly-once delivery, connector-specific retry policy, and provider reconciliation are not claimed by PR5. | Architecture/effect-ledger documentation and PR scope. | N/A — explicitly outside PR5 |

## Evidence already executed

First full hosted code run: `38974419026`, job `117220288024`, on head `dcfc2da89aa5200ccae0bc37947e3f964206d41a`.

Observed results:

- source/package verification: PASS;
- contract/core tests: 30/30 PASS;
- PostgreSQL integration tests: 29/29 PASS;
- Effect-specific adversarial tests: 13/13 PASS;
- PR3 persistence regressions: PASS;
- PR4 queue/fencing regressions: PASS;
- runtime dependency audit: PASS, zero vulnerabilities reported.

No implementation defect was observed in that first complete hosted PR5 run. R7 does not manufacture a repair event where falsification did not find one.

## Completion rule

PR5 may be promoted to **VERIFIED / MERGE-READY** only when R5-15 is VERIFIED on the exact final branch head. Any later change to an artifact covered by the manifest requires regenerating the manifest and rerunning the dependent hosted gates.
