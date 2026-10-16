# AegisFlow agent instructions

AegisFlow is a standalone governed automation runtime. Do not make it depend on
Workflows-N8N, AgentForge, RelayForge, n8n, or their internal contracts.

## Engineering rules

1. Preserve the product boundary: reasoning is not authority to act.
2. Domain contracts remain framework- and adapter-independent.
3. Running executions pin one immutable Flow version.
4. Do not claim exactly-once external actions. Internal work may be at-least-once;
   stale completion must eventually be fenced and external effects must become
   idempotent/reconcilable.
5. Gates, Effects, Signals, and Evidence are first-class durable concepts, not
   booleans hidden inside payloads.
6. Do not add Redis, Kafka, Kubernetes, a vector database, arbitrary code
   execution, or a giant policy DSL without an evidence-backed requirement.
7. Keep PRs small and evidence-gated. Do not skip failed verification.
8. Do not weaken tests to obtain green CI.
9. Never commit credentials or raw secret-bearing evidence.

## Current scope

PR1 owns foundation and contracts only. PostgreSQL persistence, worker leases,
Effects runtime logic, Gates runtime logic, providers, connectors, API, SDK,
CLI, and web console belong to later roadmap slices.
