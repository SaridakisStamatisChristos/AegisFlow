# R7 PR10 Requirement Ledger — CLI

Source: AegisFlow master handoff PR10 plus inherited AegisFlow invariants.

| ID | Requirement | Source | Criticality | Acceptance evidence | Owner / surface | State |
| --- | --- | --- | --- | --- | --- | --- |
| R10-01 | Provide a command-line interface for the PR10 roadmap slice. | USER | HARD | CLI package builds and executable help/commands are tested. | `packages/cli` | VERIFIED |
| R10-02 | Validate Flow JSON locally with the canonical Flow contract. | USER | HARD | Valid Flow succeeds; invalid Flow fails before network access. | CLI + `@aegisflow/contracts` | VERIFIED |
| R10-03 | Submit/register a Flow through the public SDK. | USER | HARD | Test observes `POST /v1/flows` through SDK behavior. | CLI + `@aegisflow/sdk` | VERIFIED |
| R10-04 | Start an execution through the public SDK without weakening durable idempotency semantics. | USER / DOMAIN | HARD | CLI requires caller idempotency key; test observes header and optional version pin. | CLI + SDK | VERIFIED |
| R10-05 | Inspect an execution through the public SDK. | USER | HARD | Test observes SDK request to execution inspection endpoint. | CLI + SDK | VERIFIED |
| R10-06 | Approve and reject durable Gates through the public SDK. | USER | HARD | Tests cover approve/reject, actor identity, and optional JSON evidence. | CLI + SDK | VERIFIED |
| R10-07 | The CLI must not become a second authority/runtime or directly access PostgreSQL/runtime internals. | DOMAIN | HARD | Architecture boundary permits only contracts/SDK plus Node built-ins; no direct DB/runtime imports. | boundary gate | VERIFIED |
| R10-08 | Invalid local inputs fail before authority-bearing network calls. | DOMAIN | HARD | Tests cover invalid Flow and missing idempotency key with zero fetch calls. | CLI tests | VERIFIED |
| R10-09 | CLI failures have deterministic machine-readable errors and nonzero exit codes. | INFERRED | SHOULD | Tests cover SDK and usage error mapping. | CLI | VERIFIED |
| R10-10 | Repository build/test/clean/dependency-lock/manifest gates include the CLI. | R7 / PLATFORM | HARD | `npm run verify`, lockfile install, manifest checks, and CI pass. | root scripts + manifests | VERIFIED |

## Verification anchor

GitHub Actions CI run #237 completed successfully on implementation head `ea1417f6857107d34c2978bc5f9775d7c8c54652`. The run passed committed-lockfile installation, dependency-declaration mutation detection, the complete source/test/boundary verification gate, PostgreSQL regression suites, and runtime dependency audit.

## Hard invariants

1. The CLI is a presentation/control client only. It never writes PostgreSQL or runtime ledgers directly.
2. Running executions remain pinned to immutable Flow Versions by the existing API/runtime contract.
3. Execution submission keeps the PR9 durable idempotency semantics; the CLI does not silently replace caller retry identity.
4. Gate authority remains in the durable Gate subsystem; the CLI only sends approve/reject decisions over the public API.
5. No n8n, Workflows-N8N, AgentForge, or RelayForge dependency is introduced.
6. PR11 web-console scope is excluded.

## Assumptions

| ID | Statement | Criticality | Confidence | Invalidation trigger |
| --- | --- | --- | --- | --- |
| A10-01 | Default local Control API URL is `http://127.0.0.1:8080`, matching the PR9 API default port. | LOW | HIGH | API default port changes. |
| A10-02 | JSON output is the safest V1 CLI contract because it is scriptable and does not invent unstable presentation semantics. | LOW | HIGH | Handoff specifies a human table/output format. |
