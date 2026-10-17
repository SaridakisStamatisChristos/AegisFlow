# Deterministic demo and verification suite

The deterministic scenario suite validates AegisFlow's execution and recovery semantics. It is not a synthetic throughput contest and makes no latency or performance-superiority claim.

## Run

```bash
npm ci --ignore-scripts
DATABASE_URL=postgresql://aegisflow:aegisflow@localhost:5432/aegisflow_test npm run demo:deterministic
```

The command builds the monorepo, recreates a disposable PostgreSQL test schema, starts the real Control API on a loopback ephemeral port, drives it through `@aegisflow/sdk`, exercises production queue/provider/connector/Gate/Effect authorities, and exits non-zero if any required scenario fails.

The suite prints a JSON report. `elapsedMs` is diagnostic only; there is no timing threshold.

## Covered scenarios

1. **Flagship Flow contract** — the checked-in Incident Response Flow validates and materializes correctly.
2. **Deterministic Flow** — API start, worker claim, durable completion, SDK inspection, and evidence.
3. **Agent reasoning** — deterministic provider, schema-validated output, and durable provider Effect evidence.
4. **Human Gate** — durable wait, approval evidence, authority release, and deterministic duplicate decision handling.
5. **External Effect** — stable Effect identity suppresses duplicate external execution.
6. **Transient failure and retry** — expired lease produces a timed-out Attempt and a new recovered Attempt.
7. **Worker crash and recovery** — a separate Node worker is killed and replacement ownership recovers after lease expiry.
8. **Stale-worker fencing** — an obsolete generation cannot commit authoritative completion.
9. **Wait/signal resume** — durable Signal delivery resumes waiting work and duplicate delivery is idempotent.
10. **Ambiguous side effect** — uncertain external outcome becomes `RECONCILIATION_REQUIRED` and requires explicit reconciliation.

## Flagship path

```text
validate -> classify -> approval -> GitHub issue -> Slack alert -> summary
```

The scenario runner composes the public API and durable runtime primitives. Direct SQL is used only for explicit fault injection or verification inside the test harness.

## Reproducibility

CI runs the same deterministic suite against PostgreSQL after normal regression tests. The worker-crash scenario uses an actual child-process termination on the Linux CI target rather than simply editing a claim row to resemble a crash.
