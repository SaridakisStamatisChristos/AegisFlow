# R7 requirement ledger — PR1

| ID | Requirement | Source | Criticality | Acceptance evidence | State before CI |
|---|---|---|---|---|---|
| R1 | AegisFlow is independent of n8n and adjacent portfolio repos | user hand-off | HARD | product boundary + dependency scan | VERIFIED locally |
| R2 | TypeScript/Node monorepo foundation | user hand-off | HARD | workspace/package/toolchain files build | VERIFIED locally |
| R3 | Domain IDs, Flow, Flow Version, Execution, Stage/state contracts | PR1 | HARD | exported TypeScript declarations + typecheck | VERIFIED locally |
| R4 | Invalid graphs and missing dependencies rejected | PR1 | HARD | executable negative tests | VERIFIED locally |
| R5 | Dependency cycles rejected | PR1 | HARD | executable cycle test | VERIFIED locally |
| R6 | Unknown Stage kinds rejected | PR1 | HARD | executable unknown-kind test | VERIFIED locally |
| R7 | Immutable Flow-Version concept | PR1 | HARD | mutation-isolation/freeze test | VERIFIED locally |
| R8 | Architecture/state/persistence/Effect/Gate semantics documented before runtime implementation | hand-off | HARD | docs reviewed against contracts | VERIFIED locally |
| R9 | Basic CI mirrors local critical checks | R0 | HARD | workflow file + observed GitHub run | PARTIAL until GitHub run |
| R10 | Clean install on fresh hosted runner | R0 | HARD | observed GitHub install | UNVERIFIED until CI |
| R11 | No committed secrets | security baseline | HARD | local high-confidence secret scan | VERIFIED locally |
| R12 | Proprietary/no-license-granted repository stance | inferred conservative legal default | SHOULD | `UNLICENSED` + all-rights-reserved LICENSE | PARTIAL; user may replace explicitly |

## Applicability map

- PostgreSQL migration tests: **N/A for PR1**; persistence begins PR3.
- Worker crash/fencing tests: **N/A for PR1**; worker authority begins PR4.
- Effect concurrency/reconciliation tests: **N/A for PR1**; runtime Effect ledger begins PR5.
- Gate restart tests: **N/A for PR1**; durable Gate runtime begins PR6.
- Provider/connector auth tests: **N/A for PR1**; adapters begin PR7/PR8.
- DAST, Kubernetes, SSO, billing, enterprise IAM: **N/A for V1 PR1** by product non-goals.
