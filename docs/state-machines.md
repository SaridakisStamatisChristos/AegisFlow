# State-machine specification

This document defines the target vocabulary and monotonicity rules. Transition
functions are implemented in PR2; PR1 provides the enums as public contracts.

## Execution

States: `PENDING`, `RUNNING`, `WAITING`, `SUCCEEDED`, `FAILED`, `CANCELLED`.

Hard rules:

- an Execution references exactly one immutable Flow Version;
- terminal states (`SUCCEEDED`, `FAILED`, `CANCELLED`) do not become active again;
- cancellation is monotonic;
- `WAITING` means durable external progress is required (Gate, wait, Signal, or
  reconciliation), not that a worker is merely slow;
- retry does not rewrite prior attempt history.

## Stage execution

States: `BLOCKED`, `READY`, `RUNNING`, `WAITING`, `SUCCEEDED`, `FAILED`,
`SKIPPED`, `CANCELLED`.

A normal Stage may become `READY` only when its declared dependencies have met
the runtime's dependency-completion rule. Branching may mark non-selected Stages
`SKIPPED`; exact branching semantics are PR2 scope.

## Attempt

States: `CLAIMED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`.

Each retry creates a new Attempt sequence. Later lease generations must prevent
a stale worker from committing authoritative success.

## Gate

States: `WAITING`, `APPROVED`, `REJECTED`, `EXPIRED`.

`APPROVED`, `REJECTED`, and `EXPIRED` are terminal. Duplicate decisions must be
idempotent when identical and deterministic when conflicting.

## Effect

States: `PLANNED`, `CLAIMED`, `SUCCEEDED`, `FAILED`,
`RECONCILIATION_REQUIRED`.

`RECONCILIATION_REQUIRED` represents ambiguous external outcome. It is not a
synonym for retryable failure and must never trigger blind automatic replay.
