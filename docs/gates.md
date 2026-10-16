# Durable Gate authority

PR6 implements durable human Gates for the PostgreSQL 17 reference target.

## Authority model

A Gate is not a Boolean parameter passed to an Action. It is a durable authority
record bound to one materialized Gate StageExecution. The Execution's pinned
immutable Flow version remains the source of truth for:

- whether the Stage is actually type `gate`;
- the Gate's optional `expiresAfterMs` deadline;
- which direct dependent Stages are protected by that Gate.

The caller cannot invent a different protection set or deadline when opening the
Gate.

## Gate and Stage lifecycle

PR2 remains authoritative for legal transitions.

Opening a new Gate requires its StageExecution to be `READY`. The Gate service uses
PR2 transitions to move the Gate Stage:

```text
READY -> RUNNING -> WAITING
```

The durable Gate itself begins in `WAITING`.

Resolution is monotonic:

```text
WAITING --APPROVE--> APPROVED   ; Gate Stage -> SUCCEEDED
WAITING --REJECT----> REJECTED  ; Gate Stage -> FAILED
WAITING --EXPIRE----> EXPIRED   ; Gate Stage -> FAILED
```

Terminal Gate states are never reopened. A duplicate matching decision is
idempotent and returns the existing evidence. A conflicting terminal decision is a
deterministic conflict.

## Durable decision evidence

`gate_resolutions` stores one immutable record for a terminal Gate:

- outcome (`APPROVED`, `REJECTED`, or `EXPIRED`);
- actor identifier for human approval/rejection;
- bounded JSON evidence;
- PostgreSQL resolution timestamp.

Expiry is system-generated and therefore has a null actor. A database trigger
rejects UPDATE or DELETE of resolution evidence.

PR6 treats actor IDs as opaque strings only. Authentication, identity assurance,
roles, and authorization policy are later control-plane concerns and are not
claimed here.

## Expiry

When `expiresAfterMs` is configured, PostgreSQL computes `expires_at` using the
database clock. A late human decision locks the Gate and checks the deadline before
applying the decision. If the deadline already elapsed, PR6 durably commits
`EXPIRED` first and then returns a decision conflict to the caller.

`expireGateIfDue` and bounded `expireDueGates` operations support explicit expiry
processing. PR6 does not claim a continuously running background sweeper or a bound
on expiry-processing latency.

## Protected-work enforcement

`gate_protections` links a Gate to the materialized direct dependent
StageExecutions. Multiple Gates may protect the same StageExecution.

Protected work may acquire an `ACTIVE` worker Claim only when every protecting Gate
is `APPROVED`. This is enforced twice:

1. the Gate service exposes an authorization query/assertion surface;
2. PostgreSQL has a Claim trigger that rejects an `ACTIVE` Claim while any
   protecting Gate is not approved.

The database check is the decisive fail-closed boundary: bypassing the Gate service
and attempting a direct Claim insert still fails.

Approval grants permission to begin protected Stage work; it does not execute that
work. If the Stage later performs an external side effect, PR5 Effect authority is
still required before the connector call.

## Scope boundaries

PR6 does not implement:

- authentication or authorization of human identities;
- approval notifications, inboxes, or UI;
- provider/model execution;
- connectors;
- automatic graph scheduling/unblocking beyond Gate worker-authority enforcement;
- background sweeper service guarantees;
- production HA, backup, deployment, or performance claims.
