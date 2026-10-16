# R7 PR7 requirement closure matrix

Scope: roadmap PR7 only — vendor-neutral provider abstraction and durable Agent Stage execution on
the existing PostgreSQL worker/Effect/Gate authority layers.

| ID | Requirement | Evidence | State |
|---|---|---|---|
| R7-01 | PR7 stays isolated from provider SDKs/API keys, connectors/tool execution, API/SDK/CLI, UI, authN/authZ, and production claims. | package boundaries, PR diff, provider docs | VERIFIED |
| R7-02 | Agent runtime derives provider configuration from the pinned immutable Flow Version. | `loadAgentContext`, non-Agent/missing-provider tests | VERIFIED |
| R7-03 | Provider calls reuse PR5 Effect authority with stable StageExecution+step identity. | `agentProviderEffectIdentity`, Effect integration tests | VERIFIED |
| R7-04 | Provider responses are bounded JSON and malformed responses fail closed. | provider unit tests | VERIFIED |
| R7-05 | Output schema validation is deterministic and unsupported schema keywords fail closed. | schema unit/integration tests | VERIFIED |
| R7-06 | Provider result evidence is immutable and cannot cross-bind another StageExecution's Effect. | migration triggers + adversarial SQL tests | VERIFIED |
| R7-07 | Crash recovery reuses durable provider evidence without replaying the provider. | recovered-result integration test | VERIFIED |
| R7-08 | Orphaned in-flight provider calls are quarantined rather than blindly replayed. | orphaned-call recovery test | VERIFIED |
| R7-09 | Known provider failure and ambiguous provider outcome map to distinct durable Effect states. | failure-classification integration test | VERIFIED |
| R7-10 | Lost worker authority after provider execution cannot silently complete the Stage. | heartbeat/fencing runtime path + PR4 regression suite | VERIFIED |
| R7-11 | Tool requests outside the immutable allow-list fail closed; allowed tools are not executed before PR8. | tool integration tests | VERIFIED |
| R7-12 | Successful external provider evidence survives output-schema rejection while the Stage fails. | schema-mismatch integration test | VERIFIED |
| R7-13 | Migration `0005_agent_provider_results` rolls back/reapplies and PR3–PR6 regressions remain green. | canonical migration + persistence/queue/effect/gate suites | VERIFIED |
| R7-14 | Provider JSON has ordinary object semantics without `__proto__` prototype mutation. | explicit provider normalization regression | VERIFIED |
| R7-15 | Strict TypeScript, package boundaries, text hygiene, secret scan, and dependency audit pass. | hosted CI | VERIFIED |
| R7-16 | Declared PR7 executable/config/test artifacts have deterministic SHA-256 closure enforced by ordinary verification. | 17-artifact manifest; run `38982468778`, job `117246250332` | VERIFIED |
| R7-17 | Provider-specific networking, credentials, multi-step tool loops, connector correctness, HA/backup, production readiness, and SOTA claims are excluded. | scope docs + PR body | N/A — outside PR7 |

## Promotion rule

The executable/config/test closure above is VERIFIED on manifest-bearing head
`bccf379c1076611538dd14ae927316fc6510b865`. This documentation-only closure commit changes no
manifest-covered artifact. PR7 is promoted to merge-ready only after the exact resulting branch head
passes the complete hosted source/PostgreSQL/dependency chain; that final run is recorded in PR
metadata so documenting it does not create a self-invalidating additional commit.
