# AegisFlow human authentication (AegisCore OIDC integration)

Status: repository-side **implementation candidate**. Not a production-deployment certification.

## Architecture and identity boundary

- The Control API retains the existing SHA-256 verifier for **high-entropy service credentials** and the 19 explicitly authorized protected method/route combinations.
- For console callers, mark a dedicated API credential `"requiresHuman": true`. Such credentials must present **both** the service bearer token and a distinct OIDC ID token in `x-aegisflow-human-id-token`. Authentication fails closed if the token, OIDC verifier configuration, JWKS signature, issuer, audience, expiry, subject or server-side user authorization is absent/invalid.
- Human role is derived from a server-side allowlist keyed by the IdP **subject** (`sub`), never `X-Role`, client-supplied tenant, email display name or form field. Both service role and human role must authorize an action. Unrecognized subjects are denied. Existing service-only credentials keep their previous behavior.
- Gate/Effect mutations under a verified-human credential write a stable opaque `oidc-<SHA256(issuer + NUL + sub)>` actor derived on the API. A form-provided `actorId`/`reconciledBy` does **not** determine authority in that path. Machine-only callers keep their original service-principal attribution.
- Console implements Authorization Code + PKCE S256 + state + nonce via `openid-client`. Its HTTP-only session and login transaction cookies are opaque. ID tokens and the service bearer token remain in the **server process**, never HTML or JavaScript. The console stores sessions in memory, enforces a 30-minute maximum lifetime further bounded by ID-token expiry, handles logout invalidation, validates Host/Origin and uses a per-session CSRF token.
- Console remains **loopback-only**. Do not publish, tunnel, proxy or container-forward it to an untrusted browser. OIDC login by itself does not qualify public deployment.

## Configuration (no live values in source control)

Register a **confidential OIDC web client** at your provider, enabling Authorization Code grant and PKCE and registering exactly one callback, for example `http://127.0.0.1:8081/auth/callback`. Your provider must support that loopback redirect or provide an environment supporting equivalent safe deployment. OIDC issuer and JWKS URLs **must be HTTPS**. Use a provider supporting RS256 or ES256 signed ID tokens.

Console environment (secrets come from secret storage, not the repository):

- `AEGISFLOW_OIDC_ISSUER` — e.g. `https://idp.example.net/realms/example`
- `AEGISFLOW_OIDC_CLIENT_ID` — provisioned OIDC client identifier
- `AEGISFLOW_OIDC_CLIENT_SECRET` — confidential client secret
- `AEGISFLOW_OIDC_REDIRECT_URI` — exact loopback callback matching console host/port
- `AEGISFLOW_BASE_URL` — Control API address (prefer loopback)
- `AEGISFLOW_API_TOKEN` — dedicated console **human-bound** service bearer token
- `AEGISFLOW_CONSOLE_HOST=127.0.0.1` and `AEGISFLOW_CONSOLE_PORT=8081` (defaults)

Control API environment:

- `AEGISFLOW_API_KEYS_JSON` — configure a separate key record with `"requiresHuman": true`, a hash of the console's random service token and appropriately scoped role; other workload credentials stay separate
- `AEGISFLOW_OIDC_ISSUER` — must equal provider issuer
- `AEGISFLOW_OIDC_CLIENT_ID` — audience of console ID tokens
- `AEGISFLOW_OIDC_JWKS_URI` — pinned **HTTPS** signing-keys endpoint published by this issuer
- `AEGISFLOW_HUMAN_ACCESS_JSON` — e.g. `{"operator-sub-123":"reader","approver-sub-456":"approver"}`. `sub` is the provider-issued immutable subject, not email or display name

Role vocabulary: `reader`, `operator`, `approver`, `reconciler`, `admin`. Permissions intersect with the machine key. Give the console key only the maximum capabilities it legitimately needs. Provision allowlisted `sub` values through an authorized administrator workflow, not via a browser-provided claim. Protect access to the subject allowlist, hashes, and client secrets.

## Browser flow and recovery

1. Start the API with correctly configured key hashes and verifier settings. A missing required verifier for any human-bound credential aborts startup.
2. Start the console. It discovers OIDC metadata before serving requests; missing/bad provider configuration fails startup.
3. Navigate to `/auth/login`, complete provider login and return to `/auth/callback`. State cookie + PKCE + nonce are verified and consumed once.
4. A successful login receives a fresh random session identifier and per-session CSRF token. Operator routes require an active session. API determines the human role afresh against configured allowlist on every request; browser user cannot bypass it with headers or actor fields.
5. Visit `/auth/logout` to view a POST logout form; POST with valid CSRF deletes the server session. Provider global SSO logout is not implemented. On restart, all in-memory sessions are lost.

## Security boundaries and limitations

- **Do not share a `requiresHuman:false` high-privilege service credential with the console.** That would permit access outside the human boundary from direct API clients.
- Revoking/rotating human role access in API config requires an API restart. In-flight in-memory console sessions expire or are invalidated on console restart/logout; a previously captured ID token still expires per IdP claim, and the dedicated service key must be kept secret.
- No password database, registration, password recovery or MFA implementation is added; those functions belong to the OIDC provider. MFA policy must be configured and tested at the provider.
- No tenant/resource ownership model, SCIM, SAML, dynamic account administration, central session store, account revocation events or federated logout. Those need separate design when product requirements justify them.
- ID tokens are **not used alone as generic API access tokens**; they are accepted solely with a human-bound, independently authenticated service credential to carry validated login identity from the BFF.
- A shared backend API credential authenticates a service, not a person. For human-bound operations the verified OIDC subject is persisted as a separate attribution; for ordinary service credentials audit remains `SERVICE_PRINCIPAL_ONLY`.
- The exact deployed IdP issuer, JWKS rotation, MFA settings, ingress/TLS, reverse proxy, physical port exposure, backup/recovery and end-to-end browser paths require external qualification. Public browser deployment remains **NOT_QUALIFIED**.

## Verification contract

Run `npm run verify`, `npm run test:postgres`, `npm run demo:deterministic` and `npm audit --omit=dev --audit-level=high`. The new `human-auth.test.mjs` checks JWT signatures/issuer/audience/expiry, unknown human, denied reader, missing proof, machine token failures, zero side effects and backend-derived human actor. These are mocked-key tests, **not** live IdP or real hosted browser tests.

Rollout: provision OIDC provider client and user subject grants; deploy/configure API with human-bound console credential and separately scoped workload keys; deploy local console; verify login/approval/reconciliation and logout via real browser/IdP, negative actor and role tests, and protected audit attribution. Rollback must not re-expose an unauthenticated API; disable the console rather than returning it to a shared unauthenticated browser configuration.
