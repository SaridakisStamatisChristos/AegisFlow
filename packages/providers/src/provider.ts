import type { JsonObject, JsonValue } from "@aegisflow/contracts";
import { AgentRuntimeError } from "./errors.js";

const PROVIDER_ID = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const TOOL_NAME = PROVIDER_ID;
const MAX_TOOL_CALLS = 64;
const MAX_PROVIDER_REFERENCE = 512;
const MAX_USAGE_TOKENS = Number.MAX_SAFE_INTEGER;

export interface ProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface ProviderFinalResponse {
  readonly kind: "final";
  readonly output: JsonValue;
  readonly providerReference?: string;
  readonly usage?: ProviderUsage;
}

export interface ProviderToolCallsResponse {
  readonly kind: "tool_calls";
  readonly toolCalls: readonly ProviderToolCall[];
  readonly providerReference?: string;
  readonly usage?: ProviderUsage;
}

export type ProviderResponse = ProviderFinalResponse | ProviderToolCallsResponse;

export interface ProviderRequest {
  readonly provider: string;
  readonly instruction: string;
  readonly allowedTools: readonly string[];
  readonly maxSteps: number;
  readonly outputSchema?: JsonObject;
  readonly step: number;
}

export interface ProviderInvocationContext {
  readonly signal?: AbortSignal;
}

export interface ModelProvider {
  readonly id: string;
  generate(
    request: ProviderRequest,
    context?: ProviderInvocationContext,
  ): Promise<unknown>;
}

export type ProviderFailureClass = "KNOWN_FAILURE" | "AMBIGUOUS";

export class ProviderInvocationError extends Error {
  constructor(
    readonly classification: ProviderFailureClass,
    readonly providerCode: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ProviderInvocationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 32) {
    throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", `${path} exceeds JSON depth.`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", `${path} contains a non-finite number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024) {
      throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", `${path} has too many items.`);
    }
    return Object.freeze(value.map((item, index) => parseJson(item, `${path}[${index}]`, depth + 1)));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 1_024) {
      throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", `${path} has too many properties.`);
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of entries) {
      if (key.length === 0 || key.length > 256) {
        throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", `${path} contains an invalid key.`);
      }
      const parsed = parseJson(child, `${path}.${key}`, depth + 1);
      Object.defineProperty(output, key, {
        value: parsed,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(output);
  }
  throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", `${path} is not JSON-compatible.`);
}

function parseJsonObject(value: unknown, path: string): JsonObject {
  const parsed = parseJson(value, path);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", `${path} must be a JSON object.`);
  }
  return parsed as JsonObject;
}

function requireText(value: unknown, path: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new AgentRuntimeError(
      "MALFORMED_PROVIDER_RESPONSE",
      `${path} must be a trimmed single-line string of 1-${maximum} characters.`,
    );
  }
  return value;
}

function parseUsage(value: unknown): ProviderUsage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", "usage must be an object.");
  }
  const output: { inputTokens?: number; outputTokens?: number } = {};
  for (const key of ["inputTokens", "outputTokens"] as const) {
    const tokenValue = value[key];
    if (tokenValue === undefined) continue;
    if (
      !Number.isSafeInteger(tokenValue) ||
      (tokenValue as number) < 0 ||
      (tokenValue as number) > MAX_USAGE_TOKENS
    ) {
      throw new AgentRuntimeError(
        "MALFORMED_PROVIDER_RESPONSE",
        `usage.${key} must be a non-negative safe integer.`,
      );
    }
    output[key] = tokenValue as number;
  }
  return Object.freeze(output);
}

export function validateProviderId(value: string): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new AgentRuntimeError(
      "INVALID_INPUT",
      "provider id must match the AegisFlow symbolic-name contract.",
    );
  }
  return value;
}

export function normalizeProviderResponse(value: unknown): ProviderResponse {
  if (!isRecord(value)) {
    throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", "provider response must be an object.");
  }
  const providerReference =
    value.providerReference === undefined
      ? undefined
      : requireText(value.providerReference, "providerReference", MAX_PROVIDER_REFERENCE);
  const usage = parseUsage(value.usage);

  if (value.kind === "final") {
    if (!("output" in value)) {
      throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", "final response must contain output.");
    }
    const response: ProviderFinalResponse = Object.freeze({
      kind: "final",
      output: parseJson(value.output, "output"),
      ...(providerReference === undefined ? {} : { providerReference }),
      ...(usage === undefined ? {} : { usage }),
    });
    return response;
  }

  if (value.kind === "tool_calls") {
    if (
      !Array.isArray(value.toolCalls) ||
      value.toolCalls.length === 0 ||
      value.toolCalls.length > MAX_TOOL_CALLS
    ) {
      throw new AgentRuntimeError(
        "MALFORMED_PROVIDER_RESPONSE",
        `tool_calls response must contain between 1 and ${MAX_TOOL_CALLS} calls.`,
      );
    }
    const seen = new Set<string>();
    const toolCalls = value.toolCalls.map((raw, index) => {
      if (!isRecord(raw)) {
        throw new AgentRuntimeError(
          "MALFORMED_PROVIDER_RESPONSE",
          `toolCalls[${index}] must be an object.`,
        );
      }
      const id = requireText(raw.id, `toolCalls[${index}].id`, 128);
      if (seen.has(id)) {
        throw new AgentRuntimeError("MALFORMED_PROVIDER_RESPONSE", "tool call ids must be unique.");
      }
      seen.add(id);
      const name = requireText(raw.name, `toolCalls[${index}].name`, 128);
      if (!TOOL_NAME.test(name)) {
        throw new AgentRuntimeError(
          "MALFORMED_PROVIDER_RESPONSE",
          `toolCalls[${index}].name is not a valid symbolic name.`,
        );
      }
      return Object.freeze({
        id,
        name,
        input: parseJsonObject(raw.input, `toolCalls[${index}].input`),
      });
    });
    return Object.freeze({
      kind: "tool_calls" as const,
      toolCalls: Object.freeze(toolCalls),
      ...(providerReference === undefined ? {} : { providerReference }),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  throw new AgentRuntimeError(
    "MALFORMED_PROVIDER_RESPONSE",
    "provider response kind must be 'final' or 'tool_calls'.",
  );
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(initial: readonly ModelProvider[] = []) {
    for (const provider of initial) this.register(provider);
  }

  register(provider: ModelProvider): void {
    const id = validateProviderId(provider.id);
    if (typeof provider.generate !== "function") {
      throw new AgentRuntimeError("INVALID_INPUT", `provider '${id}' does not implement generate().`);
    }
    if (this.providers.has(id)) {
      throw new AgentRuntimeError("PROVIDER_CONFLICT", `provider '${id}' is already registered.`);
    }
    this.providers.set(id, provider);
  }

  get(id: string): ModelProvider | null {
    validateProviderId(id);
    return this.providers.get(id) ?? null;
  }

  require(id: string): ModelProvider {
    const provider = this.get(id);
    if (provider === null) {
      throw new AgentRuntimeError("PROVIDER_NOT_FOUND", `provider '${id}' is not registered.`);
    }
    return provider;
  }
}
