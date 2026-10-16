import type {
  AttemptId,
  EffectId,
  ExecutionId,
  FlowId,
  FlowVersionId,
  GateId,
  StageExecutionId,
} from "./ids.js";

export const STAGE_KINDS = [
  "task",
  "agent",
  "decision",
  "action",
  "gate",
  "wait",
  "signal",
  "transform",
] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface StageBase {
  readonly id: string;
  readonly type: StageKind;
  readonly dependsOn: readonly string[];
}

export interface TaskStage extends StageBase {
  readonly type: "task";
  readonly handler: string;
}

export interface AgentStage extends StageBase {
  readonly type: "agent";
  readonly provider: string;
  readonly instruction: string;
  readonly allowedTools: readonly string[];
  readonly maxSteps: number;
  readonly outputSchema?: JsonObject;
}

export interface DecisionStage extends StageBase {
  readonly type: "decision";
  readonly selector: string;
  readonly choices: readonly string[];
}

export interface ActionStage extends StageBase {
  readonly type: "action";
  readonly connector: string;
  readonly operation: string;
  readonly input: JsonObject;
}

export interface GateStage extends StageBase {
  readonly type: "gate";
  readonly prompt: string;
  readonly expiresAfterMs?: number;
}

export interface WaitStage extends StageBase {
  readonly type: "wait";
  readonly delayMs?: number;
  readonly resumeAt?: string;
}

export interface SignalStage extends StageBase {
  readonly type: "signal";
  readonly signalName: string;
}

export interface TransformStage extends StageBase {
  readonly type: "transform";
  readonly assign: Readonly<Record<string, string>>;
}

export type StageDefinition =
  | TaskStage
  | AgentStage
  | DecisionStage
  | ActionStage
  | GateStage
  | WaitStage
  | SignalStage
  | TransformStage;

export interface FlowDefinition {
  readonly name: string;
  readonly description?: string;
  readonly stages: readonly StageDefinition[];
}

export interface FlowVersion {
  readonly id: FlowVersionId;
  readonly flowId: FlowId;
  readonly version: number;
  readonly definition: FlowDefinition;
}

export const EXECUTION_STATES = [
  "PENDING",
  "RUNNING",
  "WAITING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const STAGE_EXECUTION_STATES = [
  "BLOCKED",
  "READY",
  "RUNNING",
  "WAITING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
] as const;
export type StageExecutionState = (typeof STAGE_EXECUTION_STATES)[number];

export const ATTEMPT_STATES = [
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const GATE_STATES = [
  "WAITING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
] as const;
export type GateState = (typeof GATE_STATES)[number];

export const EFFECT_STATES = [
  "PLANNED",
  "CLAIMED",
  "SUCCEEDED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

export interface Execution {
  readonly id: ExecutionId;
  readonly flowId: FlowId;
  readonly flowVersionId: FlowVersionId;
  readonly state: ExecutionState;
}

export interface StageExecution {
  readonly id: StageExecutionId;
  readonly executionId: ExecutionId;
  readonly stageId: string;
  readonly state: StageExecutionState;
}

export interface Attempt {
  readonly id: AttemptId;
  readonly stageExecutionId: StageExecutionId;
  readonly sequence: number;
  readonly state: AttemptState;
}

export interface GateRecord {
  readonly id: GateId;
  readonly executionId: ExecutionId;
  readonly stageExecutionId: StageExecutionId;
  readonly state: GateState;
}

export interface EffectRecord {
  readonly id: EffectId;
  readonly executionId: ExecutionId;
  readonly stageExecutionId: StageExecutionId;
  readonly effectKey: string;
  readonly state: EffectState;
}
