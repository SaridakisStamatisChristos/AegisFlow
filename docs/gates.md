# Durable Gate authority

`@aegisflow/gates` implements durable human approval authority. A Gate is not a Boolean flag passed to an Action; it is a durable record bound to a materialized Gate StageExecution and derived from the Execution's pinned immutable Flow Version.

## Lifecycle

Opening a Gate moves its Stage through:

```text
READY -> RUNNING -> WAITING
```

The Gate itself begins in `WAITING` and resolves monotonically:

```text
WAITING --APPROVE--> APPROVED   ; Gate Stage -> SUCCEEDED
WAITING --REJECT----> REJECTED  ; Gate Stage -> FAILED
WAITING --EXPIRE----> EXPIRED   ; Gate Stage -> FAILED
```

Terminal Gate states are never reopened. A duplicate matching decision is idempotent; a conflicting terminal decision fails deterministically.

## Durable decision evidence

`gate_resolutions` stores immutable terminal evidence including outcome, actor identifier for human decisions, bounded JSON evidence, and PostgreSQL resolution timestamp. Expiry is system-generated and has no human actor. Database triggers reject mutation of resolution evidence.

Actor IDs are opaque identifiers only. Authentication, identity assurance, roles, and authorization policy are separate control-plane concerns.

## Expiry

When `expiresAfterMs` is configured, PostgreSQL computes `expires_at` using the database clock. A late decision locks the Gate and checks the deadline before applying the decision. Explicit expiry operations support bounded processing.

## Protected-work enforcement

`gate_protections` links a Gate to dependent StageExecutions. Multiple Gates may protect one Stage.

Protected work may acquire an active worker Claim only when every protecting Gate is `APPROVED`. This is enforced by both the Gate service and a PostgreSQL Claim trigger. The database is the decisive fail-closed boundary.

Approval grants permission to begin protected work; it does not execute that work and does not bypass worker Claim or Effect authority.

## Current boundary

The Gate subsystem does not itself provide human identity/RBAC, notification delivery, or production deployment guarantees. The operator console is an interaction surface over the same durable Gate authority.
