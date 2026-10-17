# PR12 Demo and Benchmark Suite

PR12 closes the AegisFlow master handoff with an executable semantic-correctness suite. It is deliberately not a synthetic throughput contest and makes no latency/SOTA claim.

## Run

```bash
npm ci --ignore-scripts
DATABASE_URL=postgresql://aegisflow:aegisflow@localhost:5432/aegisflow_test npm run demo:pr12
```

The command builds the monorepo, recreates the disposable PostgreSQL test schema, starts the real Control API on a loopback ephemeral port, drives it with `@aegisflow/sdk`, exercises the production queue/provider/connector/Gate/Effect authorities, and exits non-zero if any required scenario fails.

The suite prints a JSON report. `elapsedMs` is observational diagnostics only; there is no timing threshold and no performance claim.

## Required scenarios

The suite covers the handoff's PR12 acceptance surface:

1. **Deterministic Flow** — public API registration/start, worker claim, durable Attempt/Claim completion, SDK inspection and evidence event.
2. **Agent reasoning Flow** — deterministic provider, schema-validated structured output, durable provider Effect evidence, no external AI credential.
3. **Human Gate** — durable WAITING state, approval evidence, authority release, deterministic duplicate approval.
4. **External Effect** — connector call creates a durable Effect and the same stable identity suppresses a duplicate external action.
5. **Transient failure and retry** — an expired lease converts Attempt 1 to `TIMED_OUT`; recovery creates Attempt 2 and succeeds.
6. **Worker crash and recovery** — a separate Node worker process claims work, is killed with `SIGKILL`, its lease expires, and a replacement worker recovers and completes it.
7. **Stale-worker fencing** — the old generation is rejected with `STALE_CLAIM` after recovery establishes a newer authoritative generation.
8. **Wait/signal resume** — durable Signal delivery completes the waiting Signal Stage; duplicate delivery with the same idempotency key is replayed rather than duplicated.
9. **Ambiguous side effect** — connector ambiguity moves the Effect to `RECONCILIATION_REQUIRED`; no blind retry occurs; an operator must record an explicit reconciliation decision.

The suite also validates and registers `examples/incident-response.flow.json`, the flagship high-severity incident path requested by the handoff.

## Flagship demo boundary

The checked-in Incident Response example represents the **high-severity path** as a valid immutable AegisFlow Flow contract:

```text
validate -> classify -> approval -> GitHub issue -> Slack alert -> summary
```

PR12 does not pretend that a test harness is a new production scheduler. The scenario runner composes the already-merged public API and durable runtime primitives to prove their semantics. It does not introduce a second state model, direct database mutation for production outcomes, or a visual workflow builder. Direct SQL is used only for explicit fault injection/verification inside the benchmark (for example forcing a lease timestamp into the past).

## Reproducibility and evidence

CI runs the same `npm run demo:pr12` command against PostgreSQL after the full normal regression suite. A green workflow file is not treated as evidence; the R7 PR12 evidence record names the observed successful workflow run and exact commit after verification.

The worker-crash scenario is designed for the Linux CI target and uses an actual child process termination rather than merely editing a claim row to look crashed.
