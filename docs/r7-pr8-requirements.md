# R7 PR8 requirement closure matrix

Scope: roadmap PR8 only — governed HTTP/GitHub/Slack connectors and durable Agent tool execution on the existing PostgreSQL worker/Effect/Gate/provider authority layers.

| ID | Requirement | Evidence | State |
|---|---|---|---|
| R8-01 | PR8 stays isolated from Control API/SDK/CLI, UI, authN/authZ, HA/deployment, and production/SOTA claims. | package boundaries, PR diff, connector docs | VERIFIED |
| R8-02 | Connector credentials/transports are operator-injected, not accepted from Agent tool input or persisted in Effect/result evidence. | built-in connector construction + header tests + Effect intent shape | VERIFIED |
| R8-03 | Generic HTTP is HTTPS-only, origin-allow-listed, redirect-fail-closed, response-bounded, and blocks Agent-supplied credential/transport headers. | connector unit tests | VERIFIED |
| R8-04 | GitHub execution is fixed to api.github.com and mechanically constrained by normalized allowed API path prefixes. | GitHub authority tests | VERIFIED |
| R8-05 | Slack postMessage is fixed to Slack's API endpoint and mechanically constrained by allowed channel IDs. | Slack authority tests | VERIFIED |
| R8-06 | Every Agent tool call has stable Effect identity from StageExecution + provider step + tool-call ID. | `agentToolEffectIdentity` + duplicate-intent tests | VERIFIED |
| R8-07 | Tool result evidence is persisted before Effect success and is database-enforced immutable. | migration 0006 + tool-runtime tests | VERIFIED |
| R8-08 | Tool result evidence cannot cross-bind another StageExecution's Effect. | PostgreSQL validation trigger + adversarial SQL test | VERIFIED |
| R8-09 | Same stable tool identity with different canonical intent fails before another external call. | canonical-intent conflict test | VERIFIED |
| R8-10 | Known connector failure and ambiguous external outcome map to distinct durable Effect states. | connector-runtime integration tests | VERIFIED |
| R8-11 | Recovered in-flight tool Effect without durable evidence is quarantined and never blindly replayed. | orphaned-tool recovery test | VERIFIED |
| R8-12 | Provider tool calls are checked against the immutable Agent allow-list and connector registry before the first tool side effect in that provider turn. | PR8 Agent preflight tests | VERIFIED |
| R8-13 | Tool results are fed back into a bounded provider loop; immutable maxSteps stops further side effects. | provider→tool→provider and maxSteps tests | VERIFIED |
| R8-14 | Worker Claim fencing remains authoritative around provider/tool execution; a stale worker cannot complete the Stage. | PR4 regressions + PR8 fencing failure injection | PARTIAL — targeted fencing run pending |
| R8-15 | Two-argument Agent runtime construction preserves PR7 fail-closed tool behavior. | selected PR7 runtime regression lane | VERIFIED |
| R8-16 | Migration chain 0001→0006 applies, rolls back, and reapplies while PR3–PR7 runtime regressions remain green. | canonical migration + hosted PostgreSQL lanes | VERIFIED |
| R8-17 | Strict TypeScript, source-only test routing, package boundaries, secret scan, PostgreSQL verification, and dependency audit pass. | hosted CI | VERIFIED |
| R8-18 | Declared PR8 executable/config/test artifacts have SHA-256 closure and the exact final branch head passes hosted verification. | PR8 manifest + final-head CI | PARTIAL — packaging/final-head gate pending |
| R8-19 | Direct general ActionStage scheduling, external exactly-once guarantees, automatic reconciliation, API/SDK/CLI/UI/RBAC, HA/backup, production readiness, and SOTA claims are excluded. | scope docs + PR body | N/A — outside declared PR8 slice |

PR8 is merge-ready only when R8-14 and R8-18 are VERIFIED on the final candidate lineage.
