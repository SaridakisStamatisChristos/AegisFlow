# R7 PR10 Evidence Record — CLI

Revision state: **VERIFIED** on implementation head `ea1417f6857107d34c2978bc5f9775d7c8c54652` by GitHub Actions CI run #237. This evidence-sealing revision must itself pass the same CI gates before merge.

## Requirement coverage

| Requirement | Artifact / test | Evidence state |
| --- | --- | --- |
| R10-01 | `packages/cli/package.json`, `src/bin.ts`, CLI help path | VERIFIED |
| R10-02 | `flow validate`; valid + invalid Flow tests | VERIFIED |
| R10-03 | `flow submit`; SDK request-observation test with canonical Flow normalization | VERIFIED |
| R10-04 | `execution start`; explicit idempotency key + version test | VERIFIED |
| R10-05 | `execution inspect` SDK endpoint test | VERIFIED |
| R10-06 | Gate approve/reject tests including evidence | VERIFIED |
| R10-07 | `scripts/check-boundaries.mjs` CLI import rule | VERIFIED |
| R10-08 | zero-network invalid-input tests | VERIFIED |
| R10-09 | structured SDK failure and usage-error tests | VERIFIED |
| R10-10 | root build/test/clean/manifest/dependency-lock integration | VERIFIED |

## Executed verification

CI run #237 on `ea1417f6857107d34c2978bc5f9775d7c8c54652` established:

- `npm ci --ignore-scripts` succeeded;
- dependency declaration mutation check succeeded;
- `npm run verify` succeeded after 59/59 tests passed;
- architecture boundary and secret-scan gates succeeded;
- PR10 artifact and dependency/config manifests succeeded;
- PostgreSQL migration/repository regressions succeeded;
- runtime dependency audit succeeded.

The immediately preceding run #235 falsified one test assumption: the Flow submit test expected raw input rather than the canonical definition returned by `validateFlowDefinition`. Production behavior was correct; the test was repaired to assert the normalized root-stage `dependsOn: []`, after which run #237 passed.

## Falsification targets exercised

The PR10 verification run attempted to falsify:

- malformed or contract-invalid Flow input;
- missing execution idempotency key;
- malformed AegisFlow identifiers;
- invalid Gate evidence shape;
- SDK/API structured failures;
- duplicate/unknown CLI options;
- non-http(s) base URLs;
- files larger than the 1 MiB CLI JSON input boundary;
- architecture drift that imports persistence/runtime authority directly;
- package-lock drift under `npm ci --ignore-scripts`;
- artifact-manifest drift;
- regressions in the existing PostgreSQL-backed runtime.

## Claims ledger

| Claim | State |
| --- | --- |
| PR10 CLI is implemented | VERIFIED |
| CLI uses only public SDK/contracts for AegisFlow authority | VERIFIED |
| CLI preserves execution idempotency semantics | VERIFIED |
| PR10 acceptance surface is complete | VERIFIED |
| PR10 is merge-ready | CONDITIONAL — final evidence-sealing head must pass CI |

No production-readiness, authentication, RBAC, or PR11 UI claim is made by this slice.
