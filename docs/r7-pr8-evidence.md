# R7 PR8 evidence and falsification ledger

## Scope

Roadmap PR8 only: governed `http.request`, `github.request`, and `slack.postMessage` connectors plus bounded durable Agent tool execution composed with the existing immutable Flow Version, PR4 worker Claim/fencing, PR5 Effect authority, PR6 Gate protection, and PR7 provider evidence.

PR8 does not claim a Control API/SDK/CLI, UI, authenticated AegisFlow user/RBAC, arbitrary ActionStage orchestration, external exactly-once semantics, automatic reconciliation, HA/backup/deployment readiness, production readiness, or SOTA performance.

## Principal invariants

1. Connector execution cannot bypass worker Claim authority or Effect authority.
2. Connector credentials/transports are injected configuration and are not Agent-controlled durable intent/result data.
3. HTTP/GitHub/Slack destinations are mechanically constrained before transport.
4. Every provider tool call receives one stable Effect identity derived from StageExecution + provider step + tool-call ID.
5. Immutable tool-result evidence is persisted before its Effect is marked `SUCCEEDED`.
6. Known external rejection is distinct from an unknown/ambiguous external outcome.
7. Recovery never blindly replays a claimed provider/tool call whose outcome is unknown.
8. Every tool in a provider turn is allow-list/registry preflighted before the first side effect in that turn.
9. Worker fencing remains authoritative after provider or connector execution and before durable Stage success is committed.
10. The two-argument Agent runtime remains the PR7 fail-closed compatibility path.

## Failure / repair ledger

### F8-001 — exact optional typing and Slack JSON narrowing

Initial hosted run `38984956578`, job `117254145843`, head `270826b616b4d83ca2040cb7e06396e3e28dd892` failed source/type verification before PostgreSQL ran.

Reproducer:
- GitHub and Slack constructors supplied `fetch: FetchLike | undefined` to an exact optional `fetch?: FetchLike` field;
- Slack result parsing did not narrow generic JSON objects strongly enough for TypeScript.

Violated requirement: R8-17 strict TypeScript/source verification.

Root cause: PR8 connector integration did not preserve `exactOptionalPropertyTypes` construction semantics and used an insufficient JSON-object narrowing boundary.

Earliest invalidated phase: **INTEGRATE / TYPECHECK**.

Selective repair:
- omit the `fetch` key when no injected transport exists;
- explicitly narrow Slack response/body JSON records.

Repair lineage: `0535e1a8800bf836c8479987c041fc81f6bb4a4a` and `dad42eb244287dde4cef83f9391546773dbfdbd2`.

Dependent source verification passed afterward.

### F8-002 — stale migration-shape regression and test-lane routing

Run `38985045147`, job `117254436178`, head `dad42eb244287dde4cef83f9391546773dbfdbd2` passed source compilation but exposed verification-harness drift in PostgreSQL.

Observed evidence before the failure:
- persistence 8/8 PASS;
- queue/fencing 8/8 PASS;
- Effect ledger 13/13 PASS;
- Gates 15/15 PASS;
- 10/11 PR7 provider integration tests passed.

The one failing PR7 test owned an internal migration fixture written when `0005_agent_provider_results` was the newest migration. With PR8 migration `0006_agent_tool_results` present, that private fixture did not remove `0006` before trying to reapply it. In parallel, the root source-test wildcard accidentally included the connector PostgreSQL integration file because hosted CI supplies `DATABASE_URL`.

Violated requirement: R8-16/R8-17 migration-regression and verification-lane integrity.

Root cause: stale test-harness assumptions, not connector/runtime semantics.

Earliest invalidated phase: **VERIFY / TEST ROUTING**.

Selective repair:
- the canonical persistence migration regression now owns the complete `0001 → 0006` apply/rollback/reapply chain;
- the PR8 connector suite separately verifies `0006` rollback/reapply while preserving PR7 `0005`;
- source `npm test` explicitly runs source-only files;
- PostgreSQL selects the ten PR7 runtime-semantic tests explicitly instead of relying on a negative Node test-name filter.

Relevant repair lineage includes `e9d7dddfe521ccf6e4417ba429c12b0232315efe`, `e147ca140f87cd0f3c16570f2c81c61b1708a4fb`, and `6e81733450e94fdd16e48132131743c68aa3d426`.

### F8-003 — connector authority scope was descriptive rather than enforced

An adversarial design review after the verification-routing repair found a governance defect before closure: GitHub and Slack connectors persisted an `authorityScope` label but did not yet mechanically constrain GitHub API path or Slack channel destination.

Reproducer:
- a GitHub connector configured for a repository could otherwise be asked to call another repository path with the same token;
- a Slack connector could otherwise be asked to post to another channel reachable by the token.

Violated requirements: R8-04/R8-05 destination authority.

Root cause: initial connector design separated credential injection from destination authorization but had not made the latter executable.

Earliest invalidated phase: **FALSIFY / AUTHORITY REVIEW**.

Selective repair:
- GitHub now requires non-empty normalized `allowedPathPrefixes` and rejects path escape/traversal outside them before transport;
- Slack now requires non-empty `allowedChannels` and rejects off-authority channels before transport;
- unit tests assert the blocked request does not reach the injected transport.

Repair lineage: `dcbc97050221a99b452e2f66568adb08f2b68145`, `f32cd9a32031382a03896be66dd0361864506807`, and `55a9a3dee59c42ec6c9276a092beaa959ff0b575`.

## First complete semantic green run

Run `38985480963`, job `117255846097`, head `6e81733450e94fdd16e48132131743c68aa3d426` completed the hardened connector/runtime chain successfully:

- source/unit: **42/42 PASS**;
- persistence PostgreSQL: **8/8 PASS**;
- worker queue/fencing: **8/8 PASS**;
- Effect ledger/reconciliation: **13/13 PASS**;
- Gate authority: **15/15 PASS**;
- selected PR7 provider runtime regressions: **10/10 PASS**;
- PR8 connector runtime: **6/6 PASS**;
- PR8 provider/tool loop: **5/5 PASS**;
- combined PostgreSQL integration: **65/65 PASS**;
- runtime dependency audit: PASS, zero vulnerabilities reported.

## Targeted worker-fencing failure injection

A dedicated test forced the active PR8 worker lease to expire inside the provider callback after the external provider returned but before provider-result persistence.

Run `38985616233`, job `117256272953`, code head `b743f6fae9b80268189309e2617770f2e0cb9a20` passed:

- source/unit: **42/42 PASS**;
- persistence PostgreSQL: **8/8 PASS**;
- queue/fencing: **8/8 PASS**;
- Effect ledger: **13/13 PASS**;
- Gates: **15/15 PASS**;
- PR7 provider compatibility: **10/10 PASS**;
- PR8 connector runtime: **6/6 PASS**;
- PR8 provider/tool loop: **5/5 PASS**;
- targeted PR8 post-provider fencing: **1/1 PASS**;
- combined PostgreSQL integration: **66/66 PASS**;
- dependency audit: PASS, zero vulnerabilities reported;
- overall job: SUCCESS.

The stale worker did not persist provider success, its provider Effect remained `CLAIMED`, and no durable provider result was created. A replacement worker recovered the Stage, did **not** invoke the provider a second time, and quarantined the unknown provider outcome as `RECONCILIATION_REQUIRED`.

## Artifact closure

A deterministic manifest covers **26 executable/config/test artifacts**. Manifest-generation run `38985795509`, job `117256845859`, head `c38db93850c3040dfbada347e9e7621e5a60cc6f` emitted the digest set while the full 42-source/66-PostgreSQL/audit chain remained green.

The digest file was then committed as `docs/r7-pr8-manifest.sha256`. Manifest-enforced run `38985947401`, job `117257323034`, documentation candidate head `dbb745f43e3729bd40a4789b350b0a20f92f65bf` passed:

- PR8 manifest: **26/26 verified**;
- source/unit: **42/42 PASS**;
- PostgreSQL integration: **66/66 PASS**;
- runtime dependency audit: PASS, zero vulnerabilities;
- cleanup: PASS;
- overall job: SUCCESS.

No documentation file is part of the executable manifest, preventing an evidence-document self-hash cycle.

## Evidence boundaries

Executed evidence establishes the declared PostgreSQL 17 connector/tool-runtime semantics only. It does not establish:

- exactly-once behavior inside external HTTP/GitHub/Slack services;
- automatic external reconciliation;
- correctness of arbitrary third-party HTTP APIs;
- GitHub/Slack token lifecycle, organization policy, or least-privilege configuration outside the connector;
- authenticated AegisFlow users/RBAC;
- a public Control API, SDK, CLI, or UI;
- generic direct ActionStage orchestration;
- HA, backup, disaster recovery, deployment readiness, production capacity/SLOs, or SOTA performance.

The repository still has no committed `package-lock.json`. The PR8 manifest therefore closes the declared executable/config/test artifacts, not the full transitive dependency graph.

## Closure state

All declared static PR8 requirements, targeted fencing, and the executable artifact manifest are **VERIFIED** for the PostgreSQL 17 reference target. The only remaining promotion gate is a full hosted run on the exact documentation-only final branch head; no manifest-covered file may change after this ledger commit.
