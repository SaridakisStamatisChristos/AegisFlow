export type StateMachineKind = "execution" | "stage" | "attempt" | "gate" | "effect";

export class InvalidStateTransitionError extends Error {
  readonly code = "INVALID_STATE_TRANSITION" as const;

  constructor(
    readonly machine: StateMachineKind,
    readonly state: string,
    readonly event: string,
  ) {
    super(`Invalid ${machine} transition: ${state} --${event}--> ?`);
    this.name = "InvalidStateTransitionError";
  }
}

export class GateDecisionConflictError extends Error {
  readonly code = "GATE_DECISION_CONFLICT" as const;

  constructor(
    readonly state: string,
    readonly event: string,
  ) {
    super(`Gate is already ${state}; ${event} conflicts with the recorded decision.`);
    this.name = "GateDecisionConflictError";
  }
}

export class StateMachineInputError extends TypeError {
  readonly code = "INVALID_STATE_MACHINE_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "StateMachineInputError";
  }
}
