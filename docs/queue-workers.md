# Durable worker claims, leases, and fencing

PR4 defines the V1 worker-authority primitive. It is intentionally smaller than a
full scheduler: a worker may claim a `READY` StageExecution, heartbeat its lease,
complete it while authoritative, or recover a `RUNNING` StageExecution whose prior
Claim has expired.

## Claim identity and history

A Claim is not a mutable lock detached from execution history. Each Claim belongs to
exactly one Attempt and one StageExecution. The database retains completed and
expired Claims so ownership changes remain auditable.

For one StageExecution:

```text
Attempt 1 / generation 1 / worker A / EXPIRED
                         |
                         v
Attempt 2 / generation 2 / worker B / ACTIVE
```

The generation is a PostgreSQL `bigint` fencing token. Recovered work always gets a
larger generation and a new Attempt sequence.

## Acquisition

`claimStage` serializes contenders by locking the StageExecution row.

- `READY` with no active Claim: transition StageExecution to `RUNNING`, create a new
  running Attempt, then create generation 1 Claim.
- `RUNNING` with an unexpired active Claim: work is busy; no second Claim is issued.
- `RUNNING` with an expired active Claim: recover it, then issue a new Attempt and
  next generation.
- other Stage states: fail as not claimable.

PostgreSQL also independently enforces at most one `ACTIVE` Claim per StageExecution.

## Lease and heartbeat

Lease decisions use PostgreSQL `clock_timestamp()`. A heartbeat succeeds only when
all authority coordinates still match:

- StageExecution ID;
- Attempt ID;
- owner ID;
- generation;
- Claim is `ACTIVE`;
- lease has not expired.

An expired lease cannot be revived by heartbeat.

## Recovery

Recovery is currently **opportunistic**: the next claimant encountering an expired
Claim performs recovery in the claim transaction. PR4 does not add a background
recovery sweeper.

Recovery performs:

1. lock StageExecution;
2. lock active Claim;
3. lock referenced Attempt;
4. transition old Attempt to `TIMED_OUT` using PR2 semantics;
5. mark old Claim `EXPIRED`;
6. create the next Attempt sequence;
7. create a new `ACTIVE` Claim with a greater generation.

If any step fails, the transaction rolls back.

## Authoritative completion

`completeClaim` requires the exact StageExecution, Attempt, owner, and generation.
The Claim must still be `ACTIVE` and unexpired. PR2 transition functions determine
whether the requested `SUCCEED`, `FAIL`, or `CANCEL` event is legal for both Attempt
and StageExecution.

The Attempt terminal state, StageExecution terminal state, and Claim `COMPLETED`
state commit atomically. A stale or duplicate finisher cannot authoritatively
complete the same generation.

## Lock order

Authority-changing transactions use one conceptual lock order:

```text
StageExecution -> Claim -> Attempt
```

This prevents the queue implementation from creating an obvious opposing lock
order between claim/recovery and completion paths.

## Failure semantics

- wrong owner or generation: no authority;
- expired lease: completion rejected;
- stale recovered Claim: completion rejected;
- duplicate finisher: at most one authoritative commit;
- malformed lease/owner/generation input: rejected before durable mutation;
- inconsistent durable state, such as `RUNNING` StageExecution without an active
  Claim in a claim path: fail closed as integrity error.

## Explicit non-goals of PR4

PR4 does not implement:

- Effect execution/idempotency/reconciliation;
- human Gates;
- provider or connector workers;
- global scheduling/fairness/priority;
- background sweeping;
- distributed rate limits;
- production HA, backup, or capacity policy.
