# AegisFlow CLI

The CLI is a thin operator/developer surface over the public TypeScript SDK. It is not a second runtime: it does not connect directly to PostgreSQL, claim work, mutate Effects directly, or bypass Gate authority.

## Build and invoke

```bash
npm ci
npm run build:cli
./node_modules/.bin/aegisflow --help
```

The default Control API URL is `http://127.0.0.1:8080`. Override it with `AEGISFLOW_BASE_URL` or `--base-url`.

## Commands

### Validate a Flow locally

```bash
./node_modules/.bin/aegisflow flow validate ./flow.json
```

Validation uses the canonical Flow contract and makes no API request.

### Submit a Flow

```bash
./node_modules/.bin/aegisflow flow submit ./flow.json
```

The definition is validated locally and then registered through the public SDK.

### Start an execution

```bash
./node_modules/.bin/aegisflow execution start flow_aaaaaaaa \
  --idempotency-key deploy-2026-10-17
```

Pin an immutable Flow Version when required:

```bash
./node_modules/.bin/aegisflow execution start flow_aaaaaaaa \
  --version flowv_aaaaaaaa \
  --idempotency-key deploy-2026-10-17
```

The idempotency key is required so caller retries preserve stable execution identity.

### Inspect an execution

```bash
./node_modules/.bin/aegisflow execution inspect exec_aaaaaaaa
```

### Approve or reject a Gate

```bash
./node_modules/.bin/aegisflow gate approve gate_aaaaaaaa --actor operator@example.test
./node_modules/.bin/aegisflow gate reject gate_aaaaaaaa --actor operator@example.test
```

Optional structured evidence may be supplied from a JSON object file.

## Input and output contract

- JSON inputs are UTF-8 and size-bounded.
- Gate evidence must be a JSON object.
- identifiers are validated before network requests;
- normal output is formatted JSON on stdout;
- errors are formatted JSON on stderr;
- exit code `0` means success, `1` means API/network/runtime failure, and `2` means invalid CLI input.

The CLI uses only the public API boundary and inherits the API's security/deployment constraints.
