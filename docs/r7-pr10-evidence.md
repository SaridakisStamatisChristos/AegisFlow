# R7 PR10 Evidence Record — CLI

Revision state: implementation generated; verification remains **UNVERIFIED** until the branch CI gates execute on the committed revision.

## Requirement coverage

| Requirement | Artifact / test | Evidence state |
| --- | --- | --- |
| R10-01 | `packages/cli/package.json`, `src/bin.ts`, CLI help path | UNVERIFIED |
| R10-02 | `flow validate`; valid + invalid Flow tests | UNVERIFIED |
| R10-03 | `flow submit`; SDK request-observation test | UNVERIFIED |
| R10-04 | `execution start`; explicit idempotency key + version test | UNVERIFIED |
| R10-05 | `execution inspect` SDK endpoint test | UNVERIFIED |
| R10-06 | Gate approve/reject tests including evidence | UNVERIFIED |
| R10-07 | `scripts/check-boundaries.mjs` CLI import rule | UNVERIFIED |
| R10-08 | zero-network invalid-input tests | UNVERIFIED |
| R10-09 | structured SDK failure and usage-error tests | UNVERIFIED |
| R10-10 | root build/test/clean/manifest/dependency-lock integration | UNVERIFIED |

## Falsification targets

The PR10 verification run must attempt to falsify:

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
- artifact-manifest drift.

## Claims ledger

| Claim | State |
| --- | --- |
| PR10 CLI is implemented | PARTIAL — artifacts exist, execution evidence pending |
| CLI uses only public SDK/contracts for AegisFlow authority | UNVERIFIED pending boundary gate |
| CLI preserves execution idempotency semantics | UNVERIFIED pending tests |
| PR10 is merge-ready | UNVERIFIED pending complete CI |

No production-readiness, authentication, RBAC, or PR11 UI claim is made by this slice.
