import type { FlowDefinition, FlowVersion, JsonValue } from "./domain.js";
import { ContractError } from "./errors.js";
import type { FlowId, FlowVersionId } from "./ids.js";
import { validateFlowDefinition } from "./flow.js";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export function freezeFlowDefinition(definition: FlowDefinition): FlowDefinition {
  const validated = validateFlowDefinition(cloneJson(definition));
  return deepFreeze(validated);
}

export function createFlowVersion(input: {
  id: FlowVersionId;
  flowId: FlowId;
  version: number;
  definition: unknown;
}): FlowVersion {
  if (!Number.isInteger(input.version) || input.version <= 0) {
    throw new ContractError(
      "INVALID_VERSION",
      "Flow version number must be a positive integer.",
    );
  }
  const definition = freezeFlowDefinition(validateFlowDefinition(input.definition));
  return deepFreeze({
    id: input.id,
    flowId: input.flowId,
    version: input.version,
    definition,
  });
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}
