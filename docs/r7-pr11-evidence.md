# R7 PR11 Evidence Record — Operator Web Console

Revision state: **VERIFIED** on implementation head `ecfdef2726e46592cabda7ac5b3a72087fcce58c` by GitHub Actions CI run #247. This evidence-sealing revision must itself pass the same CI gates before merge.

## Requirement coverage

| Requirement | Executed evidence | State |
| --- | --- | --- |
| R11-01 | `@aegisflow/console` builds, typechecks, and executes its HTTP tests. | VERIFIED |
| R11-02 | Flow list/detail/version routes plus SDK/API/PostgreSQL operator read integration. | VERIFIED |
| R11-03 | Console test proves rendered idempotency key and optional Flow Version pin reach SDK unchanged. | VERIFIED |
| R11-04 | Execution list/detail and Stage-status rendering tests. | VERIFIED |
| R11-05 | Evidence timeline rendering test with adversarial stored markup. | VERIFIED |
| R11-06 | Pending-Gate read integration and approve/reject action-token delegation tests. | VERIFIED |
| R11-07 | Effects operator read plus explicit reconciliation test; invalid `RETRY` rejected. | VERIFIED |
| R11-08 | Architecture boundary gate reports `CLI/console -> SDK/contracts`. | VERIFIED |
| R11-09 | Operator queries fetch at most 201 and expose at most 200 rows plus `truncated`. | VERIFIED |
| R11-10 | Stored `<script>` / `<img>` payloads are escaped; CSP is asserted. | VERIFIED |
| R11-11 | Missing action token and oversized form bodies fail before SDK mutation. | VERIFIED |
| R11-12 | Console is server-rendered operations UI with no visual Flow builder dependency or canvas. | VERIFIED |
| R11-13 | Full PostgreSQL regression runner and runtime dependency audit pass. | VERIFIED |

## Executed verification

CI run #247 (`39011288916`) on `ecfdef2726e46592cabda7ac5b3a72087fcce58c` established:

- `npm ci --ignore-scripts` succeeded and did not mutate dependency declarations;
- TypeScript typecheck succeeded across the monorepo including API, SDK, CLI, and console;
- all 65 non-PostgreSQL unit/adversarial tests passed;
- console XSS/CSP, action-token, Effect decision, idempotency, and oversized-input tests passed;
- architecture boundary and secret-scan gates passed;
- the generated PR11 artifact ledger was produced deterministically;
- the 16-artifact dependency/config checksum manifest passed;
- the full PostgreSQL runner passed, including existing persistence/queue/Effects/Gates/provider/connectors/API suites and the new operator read integration;
- `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities.

The PR11 operator integration specifically verified durable Flow/version listing, execution listing, pending Gate discovery/removal after approval, and an ambiguous Effect surfacing as `RECONCILIATION_REQUIRED`.

## R7 falsification / repair history

1. CI #243 rejected the first implementation at TypeScript compile time because the validated reconciliation decision was still inferred as generic `string` under the strict SDK contract. The repair explicitly narrowed it to `"CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED"` without changing runtime behavior.
2. CI #245 then passed typecheck, all 65 tests, boundaries, and secret scan, and failed only because the dependency checksum ledger intentionally still represented PR10. CI printed the exact new 16-artifact ledger.
3. The dependency ledger was refreshed from that generated evidence.
4. CI #247 passed the entire verification chain, PostgreSQL regressions, the new PR11 database-backed operator test, and dependency audit.

## Falsification targets exercised

- stored HTML/script payload rendered as executable markup;
- missing/incorrect action token on mutations;
- oversized form input;
- malformed decisions and JSON evidence;
- direct console imports of persistence/runtime/effects/gates;
- unbounded operator read design;
- blind Effect retry;
- execution-start idempotency loss;
- Gate resolution authority bypass;
- package-lock/dependency declaration drift;
- PR1–PR10 PostgreSQL/runtime regressions;
- dependency/artifact manifest drift.

## Claims ledger

| Claim | State |
| --- | --- |
| PR11 operator console screens are implemented | VERIFIED |
| Console preserves API/SDK authority boundaries | VERIFIED |
| Operator mutations fail closed on invalid local input | VERIFIED |
| Bounded operator read endpoints are durable-state backed | VERIFIED |
| PR11 handoff acceptance surface is complete | VERIFIED |
| PR11 is merge-ready | CONDITIONAL — final evidence-sealing head must pass CI |

No authentication/RBAC, public-internet exposure, visual-builder, or enterprise-readiness claim is made by PR11.
