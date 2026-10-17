# R7 PR11 Requirement Ledger — Operator Web Console

Source: `AEGISFLOW_MASTER_HANDOFF.md` sections 16 and 18 plus inherited AegisFlow authority/evidence invariants.

| ID | Requirement | Source | Criticality | Acceptance evidence | State |
| --- | --- | --- | --- | --- | --- |
| R11-01 | Provide an operator web console only after the runtime/API evidence base is strong. | USER | HARD | PR1–PR10 merged; console package builds/tests against public SDK. | OPEN |
| R11-02 | List Flows and inspect immutable Flow Versions. | USER | HARD | Console routes + bounded API/SDK Flow list + Flow detail. | OPEN |
| R11-03 | Start executions from the console without weakening durable idempotency. | USER / DOMAIN | HARD | Stable rendered idempotency key reaches SDK; version pin supported. | OPEN |
| R11-04 | List/inspect executions and show Stage status. | USER | HARD | Console execution list/detail and tests. | OPEN |
| R11-05 | Show durable execution timeline/evidence. | USER | HARD | Execution detail renders events/evidence from public API. | OPEN |
| R11-06 | Surface pending Gates and approve/reject through existing Gate authority. | USER / DOMAIN | HARD | Pending Gate operator read + action forms + SDK delegation tests. | OPEN |
| R11-07 | Provide Effects/reconciliation view without blind ambiguous retry. | USER / DOMAIN | HARD | Bounded Effects read; only confirmed-success/confirmed-failure reconciliation actions. | OPEN |
| R11-08 | Console must not access PostgreSQL/runtime ledgers directly. | DOMAIN | HARD | Boundary gate permits only SDK/contracts/Node built-ins. | OPEN |
| R11-09 | Operator list reads must be bounded and signal truncation. | INFERRED | SHOULD | API queries fetch max 201, return max 200 + `truncated`. | OPEN |
| R11-10 | Durable/user-controlled text must not become executable HTML. | PLATFORM | HARD | Escaping + CSP test with adversarial stored text. | OPEN |
| R11-11 | Console mutations fail closed on malformed/oversized form input and missing action token. | PLATFORM | HARD | Console adversarial tests. | OPEN |
| R11-12 | No giant visual builder or n8n-style UI is added. | USER | HARD | Repository/UI scope inspection. | OPEN |
| R11-13 | Existing PR1–PR10 runtime, PostgreSQL, and dependency gates remain green. | R7 | HARD | CI `verify`, `test:postgres`, dependency audit. | OPEN |

## Hard invariants

1. PostgreSQL remains source of durable runtime authority, but the console never accesses it directly.
2. Console mutations go through the public SDK and existing Control API semantics.
3. Ambiguous Effects remain `RECONCILIATION_REQUIRED`; PR11 exposes explicit reconciliation and never adds blind retry.
4. Gate decisions remain durable, conflict-safe Gate subsystem operations.
5. Executions remain pinned to immutable Flow Versions.
6. AegisFlow stays independent of n8n, Workflows-N8N, AgentForge, and RelayForge.
7. PR11 is an operator console, not a Flow visual builder.

## Assumptions

| ID | Statement | Criticality | Confidence | Invalidation trigger |
| --- | --- | --- | --- | --- |
| A11-01 | Server-rendered HTML is sufficient for the first operator console and avoids adding a frontend dependency stack before evidence requires one. | LOW | HIGH | UI requirements demand rich client-side interactions. |
| A11-02 | 200 records is a safe bounded initial operator-list ceiling; explicit pagination can follow when real workload evidence requires it. | LOW | MEDIUM | Operator dataset routinely exceeds the useful first 200 records. |
| A11-03 | Authentication/RBAC remains outside PR11; trusted-network/reverse-proxy deployment matches the existing Control API trust boundary. | MEDIUM | HIGH | Deployment model exposes the console directly to untrusted users. |
