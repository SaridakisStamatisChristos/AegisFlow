# R7 PR4 requirement ledger

Scope: roadmap PR4 — durable queue and worker authority only.

| ID | Requirement | Source | Criticality | Acceptance evidence | Final state |
| --- | --- | --- | --- | --- | --- |
| R4-01 | At most one active Claim exists per StageExecution | hand-off | HARD | partial unique index + concurrent-claim test | VERIFIED |
| R4-02 | Claim acquisition serializes competing workers | hand-off | HARD | Stage row lock + two-worker race has exactly one winner | VERIFIED |
| R4-03 | Lease authority uses a durable clock and bounded duration | architecture | HARD | PostgreSQL `clock_timestamp()` + input bounds | VERIFIED |
| R4-04 | Heartbeat requires exact live owner/Attempt/generation and cannot revive expiry | hand-off | HARD | wrong-generation + forced-expiry tests | VERIFIED |
| R4-05 | Reclaim increases the fencing generation monotonically | hand-off | HARD | repeated recovery yields generations 1,2,3 | VERIFIED |
| R4-06 | Abandoned Attempt is preserved and timed out before replacement | hand-off | HARD | killed-worker recovery test | VERIFIED |
| R4-07 | Stale completion after recovery is rejected | hand-off | HARD | generation-1 finisher rejected after generation 2 claim | VERIFIED |
| R4-08 | Two finishers cannot authoritatively finish one generation | hand-off | HARD | concurrent completion test: exactly one success | VERIFIED |
| R4-09 | Authoritative completion updates Attempt, StageExecution, and Claim atomically | architecture | HARD | transactional completion + observed terminal states | VERIFIED |
| R4-10 | Attempt and Claim history remains append-only across recovery | hand-off | HARD | repeated-recovery history assertions | VERIFIED |
| R4-11 | Migration `0002_worker_claims` is reversible and does not regress PR3 | R7/hand-off | HARD | full migration rollback/reapply + all PR3 DB tests | VERIFIED |
| R4-12 | Queue uses PR2 state-machine semantics rather than redefining legality | architecture | HARD | dependency boundary + transition-function calls | VERIFIED |
| R4-13 | PR5+ Effects/Gates/provider features remain outside PR4 | hand-off | HARD | package/diff inspection | VERIFIED |
| R4-14 | Exact hosted PostgreSQL 17 verification succeeds | R7 | HARD | Actions run on repaired code head | VERIFIED |

## Hard invariants

- one StageExecution has at most one active Claim;
- an active Claim is authoritative only for its exact owner, Attempt, generation,
  and unexpired lease;
- generation never decreases when abandoned work is recovered;
- recovery never reopens an old Attempt;
- stale and duplicate finishers cannot commit authoritative completion;
- Claim/Attempt history remains durable evidence;
- worker authority does not redefine the PR2 domain state machines.

## Assumptions and bounded claims

- **A4-01 (MEDIUM):** PostgreSQL 17 is the executed reference target; portability to
  other major versions is not claimed without execution.
- **A4-02 (LOW):** `READ COMMITTED` plus the declared row-lock order, conditional
  writes, and uniqueness constraints is sufficient for this PR4 authority model.
- **A4-03 (MEDIUM):** recovery is opportunistic on a later claim attempt; PR4 does
  not claim a background sweeper or scheduling latency bound.
- **A4-04 (LOW):** worker clocks may be skewed because lease authority uses the
  PostgreSQL clock.
