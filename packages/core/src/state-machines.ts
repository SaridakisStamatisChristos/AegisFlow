import type {
  AttemptState,
  EffectState,
  ExecutionState,
  GateState,
  StageExecutionState,
} from "@aegisflow/contracts";
import {
  GateDecisionConflictError,
  InvalidStateTransitionError,
  StateMachineInputError,
  type StateMachineKind,
} from "./errors.js";

export interface TransitionResult<State extends string, Event extends string> {
  readonly from: State;
  readonly event: Event;
  readonly to: State;
  readonly changed: boolean;
}

type TransitionTable<State extends string, Event extends string> = Readonly<
  Record<State, Readonly<Partial<Record<Event, State>>>>
>;

function transition<State extends string, Event extends string>(
  machine: StateMachineKind,
  table: TransitionTable<State, Event>,
  state: State,
  event: Event,
): TransitionResult<State, Event> {
  const row = (table as Readonly<Record<string, Readonly<Record<string, State | undefined>>>>)[
    state
  ];
  const next = row?.[event];
  if (next === undefined) {
    throw new InvalidStateTransitionError(machine, String(state), String(event));
  }
  return Object.freeze({ from: state, event, to: next, changed: next !== state });
}

function canTransition<State extends string, Event extends string>(
  table: TransitionTable<State, Event>,
  state: State,
  event: Event,
): boolean {
  const row = (table as Readonly<Record<string, Readonly<Record<string, State | undefined>>>>)[
    state
  ];
  return row?.[event] !== undefined;
}

export type ExecutionEvent = "START" | "WAIT" | "RESUME" | "SUCCEED" | "FAIL" | "CANCEL";

const executionTransitions: TransitionTable<ExecutionState, ExecutionEvent> = {
  PENDING: { START: "RUNNING", CANCEL: "CANCELLED" },
  RUNNING: {
    WAIT: "WAITING",
    SUCCEED: "SUCCEEDED",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
  },
  WAITING: { RESUME: "RUNNING", FAIL: "FAILED", CANCEL: "CANCELLED" },
  SUCCEEDED: {},
  FAILED: {},
  CANCELLED: {},
};

export const TERMINAL_EXECUTION_STATES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly ExecutionState[]);

const terminalExecutionStates = new Set<ExecutionState>(TERMINAL_EXECUTION_STATES);

export function transitionExecution(
  state: ExecutionState,
  event: ExecutionEvent,
): TransitionResult<ExecutionState, ExecutionEvent> {
  return transition("execution", executionTransitions, state, event);
}

export function canTransitionExecution(state: ExecutionState, event: ExecutionEvent): boolean {
  return canTransition(executionTransitions, state, event);
}

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return terminalExecutionStates.has(state);
}

export type StageExecutionEvent =
  | "UNBLOCK"
  | "START"
  | "WAIT"
  | "RESUME"
  | "SUCCEED"
  | "FAIL"
  | "SKIP"
  | "CANCEL";

const stageTransitions: TransitionTable<StageExecutionState, StageExecutionEvent> = {
  BLOCKED: { UNBLOCK: "READY", SKIP: "SKIPPED", CANCEL: "CANCELLED" },
  READY: { START: "RUNNING", SKIP: "SKIPPED", CANCEL: "CANCELLED" },
  RUNNING: {
    WAIT: "WAITING",
    SUCCEED: "SUCCEEDED",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
  },
  WAITING: { RESUME: "RUNNING", FAIL: "FAILED", CANCEL: "CANCELLED" },
  SUCCEEDED: {},
  FAILED: {},
  SKIPPED: {},
  CANCELLED: {},
};

export const TERMINAL_STAGE_EXECUTION_STATES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
] as const satisfies readonly StageExecutionState[]);

const terminalStageExecutionStates = new Set<StageExecutionState>(
  TERMINAL_STAGE_EXECUTION_STATES,
);

export function transitionStageExecution(
  state: StageExecutionState,
  event: StageExecutionEvent,
): TransitionResult<StageExecutionState, StageExecutionEvent> {
  return transition("stage", stageTransitions, state, event);
}

export function canTransitionStageExecution(
  state: StageExecutionState,
  event: StageExecutionEvent,
): boolean {
  return canTransition(stageTransitions, state, event);
}

export function isTerminalStageExecutionState(state: StageExecutionState): boolean {
  return terminalStageExecutionStates.has(state);
}

export type AttemptEvent = "START" | "SUCCEED" | "FAIL" | "TIMEOUT" | "CANCEL";

const attemptTransitions: TransitionTable<AttemptState, AttemptEvent> = {
  CLAIMED: { START: "RUNNING", TIMEOUT: "TIMED_OUT", CANCEL: "CANCELLED" },
  RUNNING: {
    SUCCEED: "SUCCEEDED",
    FAIL: "FAILED",
    TIMEOUT: "TIMED_OUT",
    CANCEL: "CANCELLED",
  },
  SUCCEEDED: {},
  FAILED: {},
  TIMED_OUT: {},
  CANCELLED: {},
};

export const TERMINAL_ATTEMPT_STATES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
] as const satisfies readonly AttemptState[]);

const terminalAttemptStates = new Set<AttemptState>(TERMINAL_ATTEMPT_STATES);

export function transitionAttempt(
  state: AttemptState,
  event: AttemptEvent,
): TransitionResult<AttemptState, AttemptEvent> {
  return transition("attempt", attemptTransitions, state, event);
}

export function canTransitionAttempt(state: AttemptState, event: AttemptEvent): boolean {
  return canTransition(attemptTransitions, state, event);
}

export function isTerminalAttemptState(state: AttemptState): boolean {
  return terminalAttemptStates.has(state);
}

export function nextAttemptSequence(lastSequence: number | null): number {
  if (lastSequence === null) {
    return 1;
  }
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 1) {
    throw new StateMachineInputError("lastSequence must be a positive safe integer or null.");
  }
  if (lastSequence === Number.MAX_SAFE_INTEGER) {
    throw new StateMachineInputError("Attempt sequence cannot exceed Number.MAX_SAFE_INTEGER.");
  }
  return lastSequence + 1;
}

export type GateEvent = "APPROVE" | "REJECT" | "EXPIRE";

const gateResolution: Readonly<Record<GateEvent, Exclude<GateState, "WAITING">>> = {
  APPROVE: "APPROVED",
  REJECT: "REJECTED",
  EXPIRE: "EXPIRED",
};

export const TERMINAL_GATE_STATES = Object.freeze([
  "APPROVED",
  "REJECTED",
  "EXPIRED",
] as const satisfies readonly GateState[]);

const terminalGateStates = new Set<GateState>(TERMINAL_GATE_STATES);

export function transitionGate(
  state: GateState,
  event: GateEvent,
): TransitionResult<GateState, GateEvent> {
  const resolved = (gateResolution as Readonly<Record<string, GateState | undefined>>)[event];
  const knownState = state === "WAITING" || terminalGateStates.has(state);
  if (!knownState || resolved === undefined) {
    throw new InvalidStateTransitionError("gate", String(state), String(event));
  }
  if (state === "WAITING") {
    return Object.freeze({ from: state, event, to: resolved, changed: true });
  }
  if (state === resolved) {
    return Object.freeze({ from: state, event, to: state, changed: false });
  }
  throw new GateDecisionConflictError(state, event);
}

export function canTransitionGate(state: GateState, event: GateEvent): boolean {
  const resolved = (gateResolution as Readonly<Record<string, GateState | undefined>>)[event];
  return resolved !== undefined && (state === "WAITING" || state === resolved);
}

export function isTerminalGateState(state: GateState): boolean {
  return terminalGateStates.has(state);
}

export type EffectEvent = "CLAIM" | "SUCCEED" | "FAIL" | "REQUIRE_RECONCILIATION";

const effectTransitions: TransitionTable<EffectState, EffectEvent> = {
  PLANNED: { CLAIM: "CLAIMED" },
  CLAIMED: {
    SUCCEED: "SUCCEEDED",
    FAIL: "FAILED",
    REQUIRE_RECONCILIATION: "RECONCILIATION_REQUIRED",
  },
  SUCCEEDED: {},
  FAILED: {},
  RECONCILIATION_REQUIRED: {},
};

export const TERMINAL_EFFECT_STATES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
] as const satisfies readonly EffectState[]);

const terminalEffectStates = new Set<EffectState>(TERMINAL_EFFECT_STATES);

export function transitionEffect(
  state: EffectState,
  event: EffectEvent,
): TransitionResult<EffectState, EffectEvent> {
  return transition("effect", effectTransitions, state, event);
}

export function canTransitionEffect(state: EffectState, event: EffectEvent): boolean {
  return canTransition(effectTransitions, state, event);
}

export function isTerminalEffectState(state: EffectState): boolean {
  return terminalEffectStates.has(state);
}

export interface DecisionBranchResolution {
  readonly selected: string;
  readonly skipped: readonly string[];
}

export function resolveDecisionBranch(
  choices: readonly string[],
  selected: string,
): DecisionBranchResolution {
  if (choices.length === 0) {
    throw new StateMachineInputError("Decision choices must not be empty.");
  }
  const unique = new Set<string>();
  for (const choice of choices) {
    if (typeof choice !== "string" || choice.length === 0) {
      throw new StateMachineInputError("Decision choices must be non-empty strings.");
    }
    if (unique.has(choice)) {
      throw new StateMachineInputError(`Decision choices contain duplicate '${choice}'.`);
    }
    unique.add(choice);
  }
  if (!unique.has(selected)) {
    throw new StateMachineInputError(`Selected decision '${selected}' is not a declared choice.`);
  }
  return Object.freeze({
    selected,
    skipped: Object.freeze(choices.filter((choice) => choice !== selected)),
  });
}
