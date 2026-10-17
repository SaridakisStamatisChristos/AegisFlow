import type { JsonObject, JsonValue } from "@aegisflow/contracts";
import { ConnectorInvocationError, ToolRuntimeError } from "./errors.js";

const SYMBOLIC_NAME = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const MAX_REFERENCE = 512;

export interface ConnectorExecutionContext {
  readonly effectKey: string;
  readonly signal?: AbortSignal;
}

export interface ConnectorResult {
  readonly output: JsonValue;
  readonly externalReference?: string;
}

export interface ToolConnector {
  readonly toolName: string;
  readonly authorityScope: string;
  execute(input: JsonObject, context: ConnectorExecutionContext): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 32) throw new ToolRuntimeError("INVALID_INPUT", `${path} exceeds JSON depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ToolRuntimeError("INVALID_INPUT", `${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024) throw new ToolRuntimeError("INVALID_INPUT", `${path} has too many items.`);
    return Object.freeze(value.map((item, index) => parseJson(item, `${path}[${index}]`, depth + 1)));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 1_024) throw new ToolRuntimeError("INVALID_INPUT", `${path} has too many properties.`);
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of entries) {
      if (key.length === 0 || key.length > 256) throw new ToolRuntimeError("INVALID_INPUT", `${path} contains an invalid key.`);
      Object.defineProperty(output, key, {
        value: parseJson(child, `${path}.${key}`, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(output);
  }
  throw new ToolRuntimeError("INVALID_INPUT", `${path} is not JSON-compatible.`);
}

function boundedReference(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_REFERENCE ||
    value.trim() !== value ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new ToolRuntimeError("INVALID_INPUT", "externalReference is invalid.");
  }
  return value;
}

export function validateToolName(value: string): string {
  if (typeof value !== "string" || !SYMBOLIC_NAME.test(value)) {
    throw new ToolRuntimeError("INVALID_INPUT", "toolName must match the AegisFlow symbolic-name contract.");
  }
  return value;
}

export function validateAuthorityScope(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ToolRuntimeError("INVALID_INPUT", "authorityScope must be a trimmed 1-128 character string without controls.");
  }
  return value;
}

export function normalizeConnectorResult(value: unknown): ConnectorResult {
  if (!isRecord(value) || !("output" in value)) {
    throw new ConnectorInvocationError("KNOWN_FAILURE", "malformed_connector_result", "Connector result must be an object containing output.");
  }
  const externalReference = boundedReference(value.externalReference);
  return Object.freeze({
    output: parseJson(value.output, "output"),
    ...(externalReference === undefined ? {} : { externalReference }),
  });
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, ToolConnector>();

  constructor(initial: readonly ToolConnector[] = []) {
    for (const connector of initial) this.register(connector);
  }

  register(connector: ToolConnector): void {
    const name = validateToolName(connector.toolName);
    validateAuthorityScope(connector.authorityScope);
    if (typeof connector.execute !== "function") {
      throw new ToolRuntimeError("INVALID_INPUT", `connector '${name}' does not implement execute().`);
    }
    if (this.connectors.has(name)) {
      throw new ToolRuntimeError("CONNECTOR_CONFLICT", `connector '${name}' is already registered.`);
    }
    this.connectors.set(name, connector);
  }

  get(name: string): ToolConnector | null {
    validateToolName(name);
    return this.connectors.get(name) ?? null;
  }

  require(name: string): ToolConnector {
    const connector = this.get(name);
    if (connector === null) throw new ToolRuntimeError("CONNECTOR_NOT_FOUND", `connector '${name}' is not registered.`);
    return connector;
  }
}
