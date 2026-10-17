# Durable worker claims, leases, and fencing

`@aegisflow/queue` provides the worker-authority primitive for worker-owned Stage execution. A worker may claim a `READY` StageExecution, heartbeat its lease, complete it while authoritative, or recover a `RUNNING` StageExecution whose prior Claim expired.

## Claim identity and history

Each Claim belongs to exactly one Attempt and one StageExecution. Completed and expired Claims remain durable so ownership changes are auditable.

```text
Attempt 1 / generation 1 / worker A / EXPIRED
                         |
                         v
Attempt 2 / generation 2 / worker B / ACTIVE
```

The generation is a PostgreSQL `bigint` fencing token. Recovered work receives a greater generation and a new Attempt sequence.

## Acquisition

`claimStage` serializes contenders by locking the StageExecution row.

- `READY` with no active Claim: transition to `RUNNING`, create an Attempt, then create generation 1 Claim.
- `RUNNING` with an unexpired active Claim: work remains busy.
- `RUNNING` with an expired active Claim: recover the prior attempt and issue a new Attempt/Claim generation.
- other Stage states: fail as not claimable.

PostgreSQL independently enforces at most one `ACTIVE` Claim per StageExecution.

## Heartbeats and authority

A heartbeat succeeds only when StageExecution ID, Attempt ID, owner ID, generation, active state, and lease validity all agree. An expired lease cannot be revived.

## Recovery

Recovery is opportunistic: a claimant that encounters an expired Claim performs recovery transactionally. The previous Attempt becomes `TIMED_OUT`, the old Claim becomes `EXPIRED`, and a new Attempt and higher-generation Claim are created. Any failure rolls the transaction back.

## Authoritative completion

`completeClaim` requires the exact StageExecution, Attempt, owner, and generation and rejects expired or stale Claims. Attempt terminal state, StageExecution terminal state, and Claim completion commit atomically.

Authority-changing transactions use the lock order:

```text
StageExecution -> Claim -> Attempt
```

## Failure semantics

- wrong owner or generation: no authority;
- expired lease: completion rejected;
- stale recovered Claim: completion rejected;
- duplicate finisher: at most one authoritative commit;
- malformed lease/owner/generation input: rejected before durable mutation;
- inconsistent durable state: fail closed as an integrity error.

The queue does not itself provide Effect idempotency, human Gate semantics, or global scheduling policy. Those responsibilities remain in their dedicated subsystems.
