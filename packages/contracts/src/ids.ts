declare const brand: unique symbol;

type Branded<T, Name extends string> = T & { readonly [brand]: Name };

export type FlowId = Branded<string, "FlowId">;
export type FlowVersionId = Branded<string, "FlowVersionId">;
export type ExecutionId = Branded<string, "ExecutionId">;
export type StageExecutionId = Branded<string, "StageExecutionId">;
export type AttemptId = Branded<string, "AttemptId">;
export type GateId = Branded<string, "GateId">;
export type EffectId = Branded<string, "EffectId">;
export type SignalId = Branded<string, "SignalId">;
export type EvidenceId = Branded<string, "EvidenceId">;

import { ContractError } from "./errors.js";

const ID_BODY = /^[a-z0-9][a-z0-9_-]{7,95}$/;

type IdPrefix =
  | "flow"
  | "flowv"
  | "exec"
  | "stagex"
  | "attempt"
  | "gate"
  | "effect"
  | "signal"
  | "evidence";

function parsePrefixedId<Name extends string>(
  value: unknown,
  prefix: IdPrefix,
  name: Name,
): Branded<string, Name> {
  if (typeof value !== "string") {
    throw new ContractError("INVALID_ID", `${name} must be a string.`);
  }

  const expectedPrefix = `${prefix}_`;
  if (!value.startsWith(expectedPrefix)) {
    throw new ContractError(
      "INVALID_ID",
      `${name} must begin with ${expectedPrefix}.`,
    );
  }

  const body = value.slice(expectedPrefix.length);
  if (!ID_BODY.test(body)) {
    throw new ContractError(
      "INVALID_ID",
      `${name} contains an invalid opaque identifier body.`,
    );
  }

  return value as Branded<string, Name>;
}

export const parseFlowId = (value: unknown): FlowId =>
  parsePrefixedId(value, "flow", "FlowId");
export const parseFlowVersionId = (value: unknown): FlowVersionId =>
  parsePrefixedId(value, "flowv", "FlowVersionId");
export const parseExecutionId = (value: unknown): ExecutionId =>
  parsePrefixedId(value, "exec", "ExecutionId");
export const parseStageExecutionId = (value: unknown): StageExecutionId =>
  parsePrefixedId(value, "stagex", "StageExecutionId");
export const parseAttemptId = (value: unknown): AttemptId =>
  parsePrefixedId(value, "attempt", "AttemptId");
export const parseGateId = (value: unknown): GateId =>
  parsePrefixedId(value, "gate", "GateId");
export const parseEffectId = (value: unknown): EffectId =>
  parsePrefixedId(value, "effect", "EffectId");
export const parseSignalId = (value: unknown): SignalId =>
  parsePrefixedId(value, "signal", "SignalId");
export const parseEvidenceId = (value: unknown): EvidenceId =>
  parsePrefixedId(value, "evidence", "EvidenceId");
