# AegisFlow Operator Console

The operator console is a server-rendered operations surface over the public SDK. It is not a visual workflow builder and does not introduce alternate execution semantics.

## Scope

The console provides:

- Flow list and immutable Flow Version inspection;
- execution start through the public SDK with stable idempotency identity;
- execution list, Stage status, and durable evidence timeline;
- pending Gate list with approve/reject actions and optional JSON evidence;
- Effect inspection and explicit reconciliation controls;
- execution-local Gate and Effect views.

The console does not edit Flow graphs, execute arbitrary code, access PostgreSQL directly, claim worker work, or mutate Gate/Effect records outside the public Control API.

## Run

Start PostgreSQL and the Control API, then:

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

The console and Control API do not currently provide enterprise authentication/RBAC and must remain on a trusted network or behind an authenticated reverse proxy.

Presentation safeguards include HTML escaping, Content Security Policy, clickjacking protection, protected mutation forms, bounded form bodies, local-path return redirects, and bounded operator lists.
