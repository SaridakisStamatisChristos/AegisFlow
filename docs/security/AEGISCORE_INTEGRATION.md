# AegisCore — Control API service identity

Status: **implemented security slice**, not enterprise IAM or production certification.

## Trust boundary and rollout

The Control API can register Flows, start/cancel Executions, submit Signals, resolve approval Gates and reconcile Effects. These operations previously relied on a trusted network/reverse proxy. Every `/v1` request now requires a bearer credential. Health endpoints remain public for probes. Empty/malformed auth config causes startup to fail.

Configure **hashes only** in `AEGISFLOW_API_KEYS_JSON`:

```json
[
  { "id": "deploy-operator", "sha256": "<64 lowercase hex characters>", "role": "operator" },
  { "id": "approval-service", "sha256": "<64 lowercase hex characters>", "role": "approver", "expiresAt": "2027-01-01T00:00:00Z" }
]
```

Generate each credential locally using `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`. Calculate its hash with `node -e 'const c=require("node:crypto"); console.log(c.createHash("sha256").update(process.argv[1]).digest("hex"))' TOKEN`; take care not to leave tokens in shell history. Never commit, log, or paste production credentials or live digests. Use a secrets manager for raw tokens (CLI/SDK/console) and protect access to hashed verifier config. Revocation/rotation requires changing configured hashes and restarting the API; optional expiry is checked for every request. Use role-separated credentials rather than one global admin token.

API uses `AEGISFLOW_API_HOST` (default `127.0.0.1`). Public/external binding requires TLS termination, firewall restrictions and rate limiting at the edge. SDK accepts `new AegisFlowClient({ baseUrl, apiToken })` and refuses non-loopback plaintext HTTP with tokens; CLI and console read `AEGISFLOW_API_TOKEN`. The console is **strictly loopback-only**: it refuses non-loopback hosts even if `AEGISFLOW_CONSOLE_TRUSTED_PROXY=1` is set. Reverse proxy configuration, container publishing, SSH tunnels and port forwarding can invalidate local-only safety and are outside the evaluated contract. The shared API service token does not authenticate human browser visitors.

## Authorization contract

| Role | GET/reads | Execute/start/cancel/signal/register | Gate approval | Effect reconciliation |
| --- | --- | --- | --- | --- |
| reader | yes | no | no | no |
| operator | yes | yes | no | no |
| approver | yes | no | yes | no |
| reconciler | yes | no | no | yes |
| admin | yes | yes | yes | yes |

All **19 explicitly enumerated protected routes** use a method/path capability registry, checked before service/database work. Unknown methods, routes and noncanonical traversal/encoded separators are rejected, not granted a generic read/execute fallback. The existing required `actorId` for Gate decisions and `reconciledBy` for Effect reconciliation must match the authenticated credential ID, or the request is 403. An untrusted actor/tenant header cannot create authority. Invalid, missing, expired or revoked bearer credentials produce 401 with a WWW-Authenticate challenge; roles lacking permission produce 403. No migrations were required; execution/effect/gate logic is untouched.

This is **instance-wide access**, not tenant isolation. There is no OAuth/OIDC login, SSO, MFA, personal accounts, per-resource ownership, fine-grained grants, centralized revocation, automated credential rollover or individual browser actor trace for a shared service token. Do not claim enterprise multi-tenant safety. Tokens require high entropy because SHA-256 of a low-entropy secret is unsuitable; server config hashes are security-sensitive.

## Verification and compatibility

Authentication changes are breaking: provision token distribution before changing a running API. Previously unauthenticated SDK/CLI scripts will receive 401 until configured. API server, SDK and console require environment configuration; the console's operator attribution fields must match its API identity. Use explicit cutover and do not roll back into an exposed unauthenticated Control API.

Commands: `npm run verify`, `npm run test:postgres` and `npm run demo:deterministic`. These are CI gates. The additional `packages/api/test/auth-policy.test.mjs` contract verifies 19 route-methods against all five roles (95 decisions), unknown method/path and canonicalization rejection, duplicate/malformed headers and side-effect denial. Added adversarial requests cover missing/wrong/malformed/expired credentials, forged identities, restricted capabilities, authorized operations and invalid configuration. Local endpoint tests use controlled fixtures; no live identity provider is configured or tested. Proxy browser-auth, TLS, secrets manager, revocation procedures and hosted qualifications remain deployment tasks.

## Exact protected route registry (v0.2)

The policy is enforced by `PROTECTED_ROUTE_POLICY` in `packages/api/src/auth.ts`, not by HTTP-method fallback. All 19 entries are enumerated below. Resource selectors are syntactically validated by the existing Control API ID parsers; **no tenant or per-resource ownership isolation exists** in the current one-instance service model.

| Method | Route | Required capability | Principal / resource scope |
| --- | --- | --- | --- |
| GET | `/v1/flows` | read | Service credential / instance-wide |
| POST | `/v1/flows` | execute | Service credential / instance-wide |
| GET | `/v1/flows/:flowId` | read | Service credential / instance-wide |
| GET | `/v1/executions` | read | Service credential / instance-wide |
| POST | `/v1/executions` | execute | Service credential / instance-wide |
| GET | `/v1/executions/:executionId` | read | Service credential / instance-wide |
| POST | `/v1/executions/:executionId/cancel` | execute | Service credential / instance-wide |
| GET | `/v1/executions/:executionId/events` | read | Service credential / instance-wide |
| GET | `/v1/executions/:executionId/effects` | read | Service credential / instance-wide |
| GET | `/v1/executions/:executionId/gates` | read | Service credential / instance-wide |
| GET | `/v1/executions/:executionId/signals` | read | Service credential / instance-wide |
| POST | `/v1/executions/:executionId/signals/:signalName` | execute | Service credential / instance-wide |
| GET | `/v1/gates/pending` | read | Service credential / instance-wide |
| GET | `/v1/gates/:gateId` | read | Service credential / instance-wide |
| POST | `/v1/gates/:gateId/approve` | approve | Service credential / instance-wide |
| POST | `/v1/gates/:gateId/reject` | approve | Service credential / instance-wide |
| GET | `/v1/effects` | read | Service credential / instance-wide |
| GET | `/v1/effects/:effectId` | read | Service credential / instance-wide |
| POST | `/v1/effects/:effectId/reconcile` | reconcile | Service credential / instance-wide |

Probes `GET /health/live` and `GET /health/ready` are explicit unauthenticated exceptions that contain no private resource data. Treat readiness traffic as an exposed operational signal; restrict at ingress if moved off loopback. Unknown paths/methods deny rather than inheriting a role. All five roles are exercised for each policy cell, with no database or business-service work on denials. Credential revocation is restart/config replacement, not live revocation. Role-based per-resource/tenant IDOR tests are **not applicable to this single-instance API model** and become mandatory before multi-tenant or owner-scoped deployments.

## SICC v0.2 deployment boundary and cutover

- **CODE_SCOPE** is limited to service-principal authentication, fixed route-specific roles and a loopback-only browser console. Gate/Effect audit IDs represent service credentials, never verified individuals.
- **No public browser qualification:** no app-managed human login/session/roles, verified reverse-proxy identity, direct-origin denial, TLS ingress or end-to-end human actor propagation has been established.
- **Client cutover:** provision separate 256-bit random tokens and verifier hashes, give service clients/console their own least-privileged secrets, then switch API clients and server together. Verify 401 on absent/wrong keys and that intended calls work.
- **Safe rollback:** restore a tested authenticated API revision with the previous key set or restrict access to loopback while repairing clients. Never restore the unauthenticated Control API behind a reachable network boundary.
- **Operational gaps:** external secret manager, TLS ingress, rate limiting, issuer-backed human identity and service credential rotation/expiry procedures require independent deployment evidence. No hosted ingress has been exercised for this PR.
