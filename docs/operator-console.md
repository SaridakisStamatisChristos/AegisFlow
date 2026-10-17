# AegisFlow Operator Console

PR11 adds the first operator-facing web console after the runtime/API/SDK evidence gates established by PR1–PR10. It is intentionally an operations surface, not a visual workflow builder.

## Scope

The console provides:

- Flow list and immutable Flow Version inspection;
- execution start through the public SDK with a rendered stable idempotency key;
- execution list, Stage status, and durable evidence/event timeline;
- pending Gate list with approve/reject actions and optional JSON evidence;
- Effects list with explicit reconciliation controls for `RECONCILIATION_REQUIRED` outcomes;
- execution-local Gate and Effect inspection.

The console does not edit Flow graphs, execute arbitrary code, access PostgreSQL directly, claim worker work, or mutate Gate/Effect records outside the existing public Control API.

## Run

Start PostgreSQL and the AegisFlow Control API first. Then:

```bash
npm ci
npm run build
AEGISFLOW_BASE_URL=http://127.0.0.1:8080 ./node_modules/.bin/aegisflow-console
```

Defaults:

- Control API: `http://127.0.0.1:8080`
- console bind host: `127.0.0.1`
- console port: `8081`

Optional environment variables:

```text
AEGISFLOW_BASE_URL
AEGISFLOW_CONSOLE_HOST
AEGISFLOW_CONSOLE_PORT
```

## Trust boundary

PR11 does not add enterprise authentication/RBAC. The console and Control API must remain on a trusted network or behind an authenticated reverse proxy until a later deployment/authentication roadmap slice explicitly owns that problem.

The console adds presentation-layer safeguards that are applicable now:

- no browser JavaScript dependency;
- dynamic durable data is HTML-escaped;
- strict Content Security Policy and clickjacking protection;
- mutation forms require an unguessable process-local action token;
- form bodies are capped at 64 KiB;
- return redirects are restricted to local absolute paths;
- all operator lists are bounded to 200 records and report truncation.

These controls do not turn the console into an authentication system and do not widen the Control API's authority model.

## Public operator reads

PR11 adds bounded read endpoints used by the SDK/console:

```text
GET /v1/flows
GET /v1/executions
GET /v1/gates/pending
GET /v1/effects
```

Existing detail/action endpoints remain authoritative for Flow inspection, execution start/detail/events, Gate decisions, Effect inspection, and Effect reconciliation.

## Non-goals

No giant visual workflow editor, n8n-style canvas, Flow graph authoring, SSO/RBAC, billing, Kubernetes, Redis, or alternate execution semantics are introduced by PR11.
