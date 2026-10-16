import type { JsonObject, JsonValue } from "@aegisflow/contracts";
import { AgentRuntimeError } from "./errors.js";

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_PROPERTIES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failSchema(path: string, message: string): never {
  throw new AgentRuntimeError("INVALID_OUTPUT_SCHEMA", `${path}: ${message}`);
}

function validateIntegerKeyword(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    failSchema(path, "must be a non-negative safe integer.");
  }
}

function validateNumberKeyword(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failSchema(path, "must be a finite number.");
  }
}

function validateSchemaNode(value: unknown, path: string, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) failSchema(path, "exceeds maximum schema depth.");
  if (!isRecord(value)) failSchema(path, "must be an object.");
  const entries = Object.entries(value);
  if (entries.length > MAX_SCHEMA_PROPERTIES) failSchema(path, "has too many keywords.");

  for (const [keyword] of entries) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      failSchema(path, `unsupported keyword '${keyword}'.`);
    }
  }

  if (value.type !== undefined) {
    if (typeof value.type !== "string" || !TYPES.has(value.type)) {
      failSchema(`${path}.type`, "must be one supported JSON type string.");
    }
  }

  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) failSchema(`${path}.properties`, "must be an object.");
    const properties = Object.entries(value.properties);
    if (properties.length > MAX_SCHEMA_PROPERTIES) {
      failSchema(`${path}.properties`, "has too many properties.");
    }
    for (const [key, child] of properties) {
      if (key.length === 0 || key.length > 256) {
        failSchema(`${path}.properties`, "contains an invalid property name.");
      }
      validateSchemaNode(child, `${path}.properties.${key}`, depth + 1);
    }
  }

  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.length > MAX_SCHEMA_PROPERTIES) {
      failSchema(`${path}.required`, "must be an array of property names.");
    }
    const seen = new Set<string>();
    for (const [index, entry] of value.required.entries()) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) {
        failSchema(`${path}.required[${index}]`, "must be a non-empty property name.");
      }
      if (seen.has(entry)) failSchema(`${path}.required`, "must not contain duplicates.");
      seen.add(entry);
    }
  }

  if (value.additionalProperties !== undefined) {
    if (typeof value.additionalProperties !== "boolean") {
      validateSchemaNode(value.additionalProperties, `${path}.additionalProperties`, depth + 1);
    }
  }

  if (value.items !== undefined) {
    validateSchemaNode(value.items, `${path}.items`, depth + 1);
  }

  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 256) {
      failSchema(`${path}.enum`, "must contain between 1 and 256 JSON values.");
    }
  }

  if (value.minLength !== undefined) validateIntegerKeyword(value.minLength, `${path}.minLength`);
  if (value.maxLength !== undefined) validateIntegerKeyword(value.maxLength, `${path}.maxLength`);
  if (
    typeof value.minLength === "number" &&
    typeof value.maxLength === "number" &&
    value.minLength > value.maxLength
  ) {
    failSchema(path, "minLength must not exceed maxLength.");
  }

  if (value.minimum !== undefined) validateNumberKeyword(value.minimum, `${path}.minimum`);
  if (value.maximum !== undefined) validateNumberKeyword(value.maximum, `${path}.maximum`);
  if (
    typeof value.minimum === "number" &&
    typeof value.maximum === "number" &&
    value.minimum > value.maximum
  ) {
    failSchema(path, "minimum must not exceed maximum.");
  }

  if (value.minItems !== undefined) validateIntegerKeyword(value.minItems, `${path}.minItems`);
  if (value.maxItems !== undefined) validateIntegerKeyword(value.maxItems, `${path}.maxItems`);
  if (
    typeof value.minItems === "number" &&
    typeof value.maxItems === "number" &&
    value.minItems > value.maxItems
  ) {
    failSchema(path, "minItems must not exceed maxItems.");
  }
}

function jsonType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return "undefined";
}

function matchesType(value: JsonValue, expected: string): boolean {
  const actual = jsonType(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function assertMatch(value: JsonValue, schema: Record<string, unknown>, path: string): void {
  if (typeof schema.type === "string" && !matchesType(value, schema.type)) {
    throw new AgentRuntimeError(
      "OUTPUT_SCHEMA_MISMATCH",
      `${path} expected type ${schema.type} but received ${jsonType(value)}.`,
    );
  }

  if (Array.isArray(schema.enum)) {
    const encoded = canonical(value);
    if (!schema.enum.some((candidate) => canonical(candidate) === encoded)) {
      throw new AgentRuntimeError(
        "OUTPUT_SCHEMA_MISMATCH",
        `${path} is not one of the allowed enum values.`,
      );
    }
  }
  if ("const" in schema && canonical(schema.const) !== canonical(value)) {
    throw new AgentRuntimeError(
      "OUTPUT_SCHEMA_MISMATCH",
      `${path} does not equal the required const value.`,
    );
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      throw new AgentRuntimeError("OUTPUT_SCHEMA_MISMATCH", `${path} is shorter than minLength.`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      throw new AgentRuntimeError("OUTPUT_SCHEMA_MISMATCH", `${path} exceeds maxLength.`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      throw new AgentRuntimeError("OUTPUT_SCHEMA_MISMATCH", `${path} is below minimum.`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      throw new AgentRuntimeError("OUTPUT_SCHEMA_MISMATCH", `${path} exceeds maximum.`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      throw new AgentRuntimeError("OUTPUT_SCHEMA_MISMATCH", `${path} has fewer than minItems.`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      throw new AgentRuntimeError("OUTPUT_SCHEMA_MISMATCH", `${path} has more than maxItems.`);
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) =>
        assertMatch(item, schema.items as Record<string, unknown>, `${path}[${index}]`),
      );
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) {
          throw new AgentRuntimeError("OUTPUT_SCHEMA_MISMATCH", `${path}.${key} is required.`);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isRecord(propertySchema)) {
        assertMatch(child as JsonValue, propertySchema, `${path}.${key}`);
        continue;
      }
      if (schema.additionalProperties === false) {
        throw new AgentRuntimeError("OUTPUT_SCHEMA_MISMATCH", `${path}.${key} is not allowed.`);
      }
      if (isRecord(schema.additionalProperties)) {
        assertMatch(child as JsonValue, schema.additionalProperties, `${path}.${key}`);
      }
    }
  }
}

export function validateAgentOutputSchema(schema: JsonObject): void {
  validateSchemaNode(schema, "outputSchema", 0);
}

export function assertAgentOutputMatchesSchema(output: JsonValue, schema: JsonObject): void {
  validateAgentOutputSchema(schema);
  assertMatch(output, schema as Record<string, unknown>, "output");
}
