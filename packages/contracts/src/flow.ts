import {
  STAGE_KINDS,
  type ActionStage,
  type AgentStage,
  type DecisionStage,
  type FlowDefinition,
  type GateStage,
  type JsonObject,
  type JsonValue,
  type SignalStage,
  type StageDefinition,
  type TaskStage,
  type TransformStage,
  type WaitStage,
} from "./domain.js";
import { ContractError } from "./errors.js";

const FLOW_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const STAGE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SYMBOLIC_NAME = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const MAX_STAGES = 256;
const MAX_DEPENDENCIES_PER_STAGE = 64;
const MAX_TEXT = 16_384;
const stageKinds = new Set<string>(STAGE_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ContractError("INVALID_FLOW", `${path} must be an object.`, { path });
  }
  return value;
}

function requireString(
  value: unknown,
  path: string,
  options: { pattern?: RegExp; maxLength?: number } = {},
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractError("INVALID_FLOW", `${path} must be a non-empty string.`, {
      path,
    });
  }
  const maxLength = options.maxLength ?? 256;
  if (value.length > maxLength) {
    throw new ContractError("INVALID_FLOW", `${path} exceeds ${maxLength} characters.`, {
      path,
    });
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    throw new ContractError("INVALID_FLOW", `${path} has an invalid format.`, { path });
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, path, { maxLength: MAX_TEXT });
}

function requirePositiveInteger(
  value: unknown,
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new ContractError(
      "INVALID_STAGE_CONFIG",
      `${path} must be a positive integer not greater than ${maximum}.`,
      { path },
    );
  }
  return value;
}

function parseStringArray(
  value: unknown,
  path: string,
  options: { maxItems: number; allowEmpty: boolean; pattern?: RegExp },
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ContractError("INVALID_FLOW", `${path} must be an array.`, { path });
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new ContractError("INVALID_FLOW", `${path} must not be empty.`, { path });
  }
  if (value.length > options.maxItems) {
    throw new ContractError(
      "INVALID_FLOW",
      `${path} exceeds ${options.maxItems} items.`,
      { path },
    );
  }

  const parsed = value.map((item, index) =>
    requireString(
      item,
      `${path}[${index}]`,
      options.pattern === undefined
        ? { maxLength: 128 }
        : { pattern: options.pattern, maxLength: 128 },
    ),
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new ContractError("INVALID_FLOW", `${path} must not contain duplicates.`, {
      path,
    });
  }
  return parsed;
}

function parseJsonValue(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 32) {
    throw new ContractError("INVALID_STAGE_CONFIG", `${path} exceeds maximum JSON depth.`, {
      path,
    });
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 65_536) {
      throw new ContractError(
        "INVALID_STAGE_CONFIG",
        `${path} exceeds the maximum JSON string length.`,
        { path },
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ContractError(
        "INVALID_STAGE_CONFIG",
        `${path} must not contain NaN or Infinity.`,
        { path },
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024) {
      throw new ContractError(
        "INVALID_STAGE_CONFIG",
        `${path} exceeds the maximum JSON array length.`,
        { path },
      );
    }
    return value.map((item, index) => parseJsonValue(item, `${path}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 1_024) {
      throw new ContractError(
        "INVALID_STAGE_CONFIG",
        `${path} exceeds the maximum JSON object size.`,
        { path },
      );
    }
    const output = Object.create(null) as Record<string, JsonValue>;
    for (const [key, child] of entries) {
      if (key.length === 0 || key.length > 256) {
        throw new ContractError("INVALID_STAGE_CONFIG", `${path} contains an invalid key.`, {
          path,
        });
      }
      output[key] = parseJsonValue(child, `${path}.${key}`, depth + 1);
    }
    return output;
  }
  throw new ContractError("INVALID_STAGE_CONFIG", `${path} must be JSON-compatible.`, {
    path,
  });
}

function parseJsonObject(value: unknown, path: string): JsonObject {
  const parsed = parseJsonValue(value, path);
  if (!isRecord(parsed)) {
    throw new ContractError("INVALID_STAGE_CONFIG", `${path} must be a JSON object.`, {
      path,
    });
  }
  return parsed as JsonObject;
}

function parseDependsOn(value: unknown, path: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return parseStringArray(value, path, {
    maxItems: MAX_DEPENDENCIES_PER_STAGE,
    allowEmpty: true,
    pattern: STAGE_ID,
  });
}

function parseCommonStage(
  record: Record<string, unknown>,
  index: number,
): { id: string; type: string; dependsOn: readonly string[] } {
  const basePath = `stages[${index}]`;
  const id = requireString(record.id, `${basePath}.id`, {
    pattern: STAGE_ID,
    maxLength: 64,
  });
  const type = requireString(record.type, `${basePath}.type`, { maxLength: 64 });
  if (!stageKinds.has(type)) {
    throw new ContractError(
      "UNKNOWN_STAGE_KIND",
      `Unknown stage kind '${type}' at ${basePath}.type.`,
      { path: `${basePath}.type`, details: { type } },
    );
  }
  const dependsOn = parseDependsOn(record.dependsOn, `${basePath}.dependsOn`);
  return { id, type, dependsOn };
}

function parseTask(
  record: Record<string, unknown>,
  common: { id: string; dependsOn: readonly string[] },
  index: number,
): TaskStage {
  return {
    ...common,
    type: "task",
    handler: requireString(record.handler, `stages[${index}].handler`, {
      pattern: SYMBOLIC_NAME,
      maxLength: 128,
    }),
  };
}

function parseAgent(
  record: Record<string, unknown>,
  common: { id: string; dependsOn: readonly string[] },
  index: number,
): AgentStage {
  const outputSchema =
    record.outputSchema === undefined
      ? undefined
      : parseJsonObject(record.outputSchema, `stages[${index}].outputSchema`);
  const result: AgentStage = {
    ...common,
    type: "agent",
    provider: requireString(record.provider, `stages[${index}].provider`, {
      pattern: SYMBOLIC_NAME,
      maxLength: 128,
    }),
    instruction: requireString(record.instruction, `stages[${index}].instruction`, {
      maxLength: MAX_TEXT,
    }),
    allowedTools:
      record.allowedTools === undefined
        ? []
        : parseStringArray(record.allowedTools, `stages[${index}].allowedTools`, {
            maxItems: 64,
            allowEmpty: true,
            pattern: SYMBOLIC_NAME,
          }),
    maxSteps:
      record.maxSteps === undefined
        ? 1
        : requirePositiveInteger(record.maxSteps, `stages[${index}].maxSteps`, 32),
  };
  return outputSchema === undefined ? result : { ...result, outputSchema };
}

function parseDecision(
  record: Record<string, unknown>,
  common: { id: string; dependsOn: readonly string[] },
  index: number,
): DecisionStage {
  return {
    ...common,
    type: "decision",
    selector: requireString(record.selector, `stages[${index}].selector`, {
      maxLength: 512,
    }),
    choices: parseStringArray(record.choices, `stages[${index}].choices`, {
      maxItems: 32,
      allowEmpty: false,
      pattern: SYMBOLIC_NAME,
    }),
  };
}

function parseAction(
  record: Record<string, unknown>,
  common: { id: string; dependsOn: readonly string[] },
  index: number,
): ActionStage {
  return {
    ...common,
    type: "action",
    connector: requireString(record.connector, `stages[${index}].connector`, {
      pattern: SYMBOLIC_NAME,
      maxLength: 128,
    }),
    operation: requireString(record.operation, `stages[${index}].operation`, {
      pattern: SYMBOLIC_NAME,
      maxLength: 128,
    }),
    input:
      record.input === undefined
        ? {}
        : parseJsonObject(record.input, `stages[${index}].input`),
  };
}

function parseGate(
  record: Record<string, unknown>,
  common: { id: string; dependsOn: readonly string[] },
  index: number,
): GateStage {
  const expiresAfterMs =
    record.expiresAfterMs === undefined
      ? undefined
      : requirePositiveInteger(
          record.expiresAfterMs,
          `stages[${index}].expiresAfterMs`,
          31_536_000_000,
        );
  const result: GateStage = {
    ...common,
    type: "gate",
    prompt: requireString(record.prompt, `stages[${index}].prompt`, {
      maxLength: MAX_TEXT,
    }),
  };
  return expiresAfterMs === undefined ? result : { ...result, expiresAfterMs };
}

function parseWait(
  record: Record<string, unknown>,
  common: { id: string; dependsOn: readonly string[] },
  index: number,
): WaitStage {
  const hasDelay = record.delayMs !== undefined;
  const hasResumeAt = record.resumeAt !== undefined;
  if (hasDelay === hasResumeAt) {
    throw new ContractError(
      "INVALID_STAGE_CONFIG",
      `stages[${index}] wait stage requires exactly one of delayMs or resumeAt.`,
      { path: `stages[${index}]` },
    );
  }
  if (hasDelay) {
    return {
      ...common,
      type: "wait",
      delayMs: requirePositiveInteger(
        record.delayMs,
        `stages[${index}].delayMs`,
        31_536_000_000,
      ),
    };
  }
  const resumeAt = requireString(record.resumeAt, `stages[${index}].resumeAt`, {
    maxLength: 64,
  });
  if (!Number.isFinite(Date.parse(resumeAt))) {
    throw new ContractError(
      "INVALID_STAGE_CONFIG",
      `stages[${index}].resumeAt must be an ISO-compatible timestamp.`,
      { path: `stages[${index}].resumeAt` },
    );
  }
  return { ...common, type: "wait", resumeAt };
}

function parseSignal(
  record: Record<string, unknown>,
  common: { id: string; dependsOn: readonly string[] },
  index: number,
): SignalStage {
  return {
    ...common,
    type: "signal",
    signalName: requireString(record.signalName, `stages[${index}].signalName`, {
      pattern: SYMBOLIC_NAME,
      maxLength: 128,
    }),
  };
}

function parseTransform(
  record: Record<string, unknown>,
  common: { id: string; dependsOn: readonly string[] },
  index: number,
): TransformStage {
  const assignRecord = requireRecord(record.assign, `stages[${index}].assign`);
  const assign: Record<string, string> = {};
  const entries = Object.entries(assignRecord);
  if (entries.length === 0 || entries.length > 128) {
    throw new ContractError(
      "INVALID_STAGE_CONFIG",
      `stages[${index}].assign must contain between 1 and 128 mappings.`,
      { path: `stages[${index}].assign` },
    );
  }
  for (const [target, source] of entries) {
    if (!SYMBOLIC_NAME.test(target)) {
      throw new ContractError(
        "INVALID_STAGE_CONFIG",
        `stages[${index}].assign contains an invalid target '${target}'.`,
        { path: `stages[${index}].assign` },
      );
    }
    assign[target] = requireString(source, `stages[${index}].assign.${target}`, {
      maxLength: 512,
    });
  }
  return { ...common, type: "transform", assign };
}

function parseStage(value: unknown, index: number): StageDefinition {
  const record = requireRecord(value, `stages[${index}]`);
  const { id, type, dependsOn } = parseCommonStage(record, index);
  const common = { id, dependsOn };
  switch (type) {
    case "task":
      return parseTask(record, common, index);
    case "agent":
      return parseAgent(record, common, index);
    case "decision":
      return parseDecision(record, common, index);
    case "action":
      return parseAction(record, common, index);
    case "gate":
      return parseGate(record, common, index);
    case "wait":
      return parseWait(record, common, index);
    case "signal":
      return parseSignal(record, common, index);
    case "transform":
      return parseTransform(record, common, index);
    default:
      throw new ContractError("UNKNOWN_STAGE_KIND", `Unknown stage kind '${type}'.`);
  }
}

function validateGraph(stages: readonly StageDefinition[]): void {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  if (byId.size !== stages.length) {
    const seen = new Set<string>();
    const duplicate = stages.find((stage) => {
      if (seen.has(stage.id)) return true;
      seen.add(stage.id);
      return false;
    });
    throw new ContractError(
      "DUPLICATE_STAGE_ID",
      `Duplicate stage id '${duplicate?.id ?? "unknown"}'.`,
      { details: { stageId: duplicate?.id } },
    );
  }

  for (const stage of stages) {
    for (const dependency of stage.dependsOn) {
      if (dependency === stage.id) {
        throw new ContractError(
          "CYCLE_DETECTED",
          `Stage '${stage.id}' cannot depend on itself.`,
          { details: { stageId: stage.id } },
        );
      }
      if (!byId.has(dependency)) {
        throw new ContractError(
          "UNKNOWN_DEPENDENCY",
          `Stage '${stage.id}' depends on unknown stage '${dependency}'.`,
          { details: { stageId: stage.id, dependency } },
        );
      }
    }
  }

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const stage of stages) {
    indegree.set(stage.id, stage.dependsOn.length);
    outgoing.set(stage.id, []);
  }
  for (const stage of stages) {
    for (const dependency of stage.dependsOn) {
      outgoing.get(dependency)?.push(stage.id);
    }
  }
  const queue = stages.filter((stage) => stage.dependsOn.length === 0).map((stage) => stage.id);
  let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) continue;
    visited += 1;
    for (const child of outgoing.get(current) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (visited !== stages.length) {
    const cyclic = stages
      .filter((stage) => (indegree.get(stage.id) ?? 0) > 0)
      .map((stage) => stage.id)
      .sort();
    throw new ContractError(
      "CYCLE_DETECTED",
      `Flow graph contains a dependency cycle involving: ${cyclic.join(", ")}.`,
      { details: { stageIds: cyclic } },
    );
  }
}

export function validateFlowDefinition(input: unknown): FlowDefinition {
  const record = requireRecord(input, "flow");
  const name = requireString(record.name, "flow.name", {
    pattern: FLOW_NAME,
    maxLength: 64,
  });
  if (!Array.isArray(record.stages)) {
    throw new ContractError("INVALID_FLOW", "flow.stages must be an array.", {
      path: "flow.stages",
    });
  }
  if (record.stages.length === 0 || record.stages.length > MAX_STAGES) {
    throw new ContractError(
      "INVALID_FLOW",
      `flow.stages must contain between 1 and ${MAX_STAGES} stages.`,
      { path: "flow.stages" },
    );
  }
  const stages = record.stages.map((stage, index) => parseStage(stage, index));
  validateGraph(stages);
  const description = optionalString(record.description, "flow.description");
  return description === undefined ? { name, stages } : { name, description, stages };
}
