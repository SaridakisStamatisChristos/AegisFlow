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

API uses `AEGISFLOW_API_HOST` (default `127.0.0.1`). Public/external binding requires TLS termination, firewall restrictions and rate limiting at the edge. SDK accepts `new AegisFlowClient({ baseUrl, apiToken })` and refuses non-loopback plaintext HTTP with tokens; CLI and console read `AEGISFLOW_API_TOKEN`. Default console binding is loopback only. For externally bound console, set `AEGISFLOW_CONSOLE_TRUSTED_PROXY=1` **only after** configuring an independently authenticated browser reverse proxy. The shared API service token used by the console does not authenticate human browser visitors.

## Authorization contract

| Role | GET/reads | Execute/start/cancel/signal/register | Gate approval | Effect reconciliation |
| --- | --- | --- | --- | --- |
| reader | yes | no | no | no |
| operator | yes | yes | no | no |
| approver | yes | no | yes | no |
| reconciler | yes | no | no | yes |
| admin | yes | yes | yes | yes |

All selected routes authorize **before** invoking service/database work. The existing required `actorId` for Gate decisions and `reconciledBy` for Effect reconciliation must match the authenticated credential ID, or the request is 403. An untrusted actor/tenant header cannot create authority. Invalid, missing, expired or revoked bearer credentials produce 401 with a WWW-Authenticate challenge; roles lacking permission produce 403. No migrations were required; execution/effect/gate logic is untouched.

This is **instance-wide access**, not tenant isolation. There is no OAuth/OIDC login, SSO, MFA, personal accounts, per-resource ownership, fine-grained grants, centralized revocation, automated credential rollover or individual browser actor trace for a shared service token. Do not claim enterprise multi-tenant safety. Tokens require high entropy because SHA-256 of a low-entropy secret is unsuitable; server config hashes are security-sensitive.

## Verification and compatibility

Authentication changes are breaking: provision token distribution before changing a running API. Previously unauthenticated SDK/CLI scripts will receive 401 until configured. API server, SDK and console require environment configuration; the console's operator attribution fields must match its API identity. Use explicit cutover and do not roll back into an exposed unauthenticated Control API.

Commands: `npm run verify`, `npm run test:postgres` and `npm run demo:deterministic`. These are CI gates. Added adversarial requests cover missing/wrong/malformed/expired credentials, forged identities, restricted capabilities, authorized operations and invalid configuration. Local endpoint tests use controlled fixtures; no live identity provider is configured or tested. Proxy browser-auth, TLS, secrets manager, revocation procedures and hosted qualifications remain deployment tasks.
