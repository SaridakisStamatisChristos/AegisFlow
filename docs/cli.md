# AegisFlow CLI

PR10 adds a thin operator/developer CLI over the public AegisFlow TypeScript SDK. The CLI is not a second runtime: it does not connect to PostgreSQL, claim work, resolve Effects directly, or bypass Gate authority. Every remote operation goes through `@aegisflow/sdk` and the PR9 Control API.

## Build and invoke

```bash
npm ci
npm run build:cli
./node_modules/.bin/aegisflow --help
```

The CLI targets the Control API at `http://127.0.0.1:8080` by default. Override it with either:

```bash
AEGISFLOW_BASE_URL=https://aegisflow.example.internal ./node_modules/.bin/aegisflow ...
```

or:

```bash
./node_modules/.bin/aegisflow --base-url https://aegisflow.example.internal ...
```

The Control API has no authentication layer in the current roadmap slice. Keep it on a trusted network or behind an authenticated reverse proxy, as documented in `docs/control-api.md`.

## Commands

### Validate a Flow locally

```bash
./node_modules/.bin/aegisflow flow validate ./flow.json
```

Validation uses the canonical `validateFlowDefinition` contract. No API request is made when the command is only validating.

Successful output is JSON:

```json
{
  "valid": true,
  "name": "approval-demo",
  "stageCount": 2
}
```

### Submit a Flow

```bash
./node_modules/.bin/aegisflow flow submit ./flow.json
```

The definition is validated locally first, then registered through the public SDK. Identical current definitions preserve the API's stable replay behavior; changed definitions create a new immutable Flow Version.

### Start an execution

```bash
./node_modules/.bin/aegisflow execution start flow_aaaaaaaa \
  --idempotency-key deploy-2026-10-17
```

Pin an explicit immutable Flow Version when needed:

```bash
./node_modules/.bin/aegisflow execution start flow_aaaaaaaa \
  --version flowv_aaaaaaaa \
  --idempotency-key deploy-2026-10-17
```

`--idempotency-key` is required. Retrying the same canonical request with the same key uses the PR9 durable submission semantics. Reusing the key for a different Flow or Flow Version fails closed at the API.

### Inspect an execution

```bash
./node_modules/.bin/aegisflow execution inspect exec_aaaaaaaa
```

The command prints the execution and its Stage executions exactly as returned by the public SDK.

### Approve or reject a Gate

```bash
./node_modules/.bin/aegisflow gate approve gate_aaaaaaaa --actor operator@example.test
./node_modules/.bin/aegisflow gate reject gate_aaaaaaaa --actor operator@example.test
```

Attach structured evidence from a JSON object:

```bash
./node_modules/.bin/aegisflow gate approve gate_aaaaaaaa \
  --actor operator@example.test \
  --evidence ./approval-evidence.json
```

Gate resolution still belongs to the durable Gate subsystem. The CLI only submits the operator decision through the Control API.

## Input and output contract

- Flow files and Gate evidence files must be valid UTF-8 JSON and are capped at 1 MiB.
- Gate evidence must be a JSON object.
- Identifiers are checked with the canonical AegisFlow ID parsers before a request is sent.
- Normal command output is formatted JSON on stdout.
- Errors are formatted JSON on stderr.
- Exit code `0` means success, `1` means API/network/runtime failure, and `2` means invalid CLI input, identifier, JSON, or Flow definition.
- The CLI never generates a hidden execution idempotency key. Callers must supply one so retries preserve their intended identity.

## Scope boundary

PR10 intentionally does not add the PR11 operator web console, enterprise IAM/RBAC, a local execution engine, direct database access, direct Effect mutation, or alternate Gate semantics.
