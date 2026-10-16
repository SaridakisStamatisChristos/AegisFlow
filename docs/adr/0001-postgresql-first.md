# ADR-0001: PostgreSQL-first V1 durability

**Status:** accepted for V1 design; implementation begins in PR3.

## Context

AegisFlow needs durable Flow versions, executions, attempts, claims, Gates,
Signals, Effects, and ordered evidence. The V1 architecture should minimize
moving parts while supporting transactional ownership and recovery semantics.

## Decision

Use PostgreSQL as the reference durable substrate and initial work-claim/queue
mechanism. Do not add Redis, Kafka, RabbitMQ, NATS, or Kubernetes without a
specific requirement that PostgreSQL cannot reasonably satisfy.

## Consequences

- fewer cross-system consistency boundaries;
- queue/lease semantics can share transactions with execution state;
- V1 scalability is intentionally bounded by a single relational durability
  model until measurements justify another subsystem;
- later infrastructure additions require a new ADR and evidence.
