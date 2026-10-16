import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRuntimeError,
  ProviderRegistry,
  assertAgentOutputMatchesSchema,
  normalizeProviderResponse,
  validateAgentOutputSchema,
} from "../dist/index.js";

test("provider registry rejects duplicate provider identity", () => {
  const provider = { id: "test.provider", async generate() { return { kind: "final", output: {} }; } };
  const registry = new ProviderRegistry([provider]);
  assert.equal(registry.require("test.provider"), provider);
  assert.throws(
    () => registry.register(provider),
    (error) => error instanceof AgentRuntimeError && error.code === "PROVIDER_CONFLICT",
  );
});

test("provider response normalization rejects malformed and duplicate tool calls", () => {
  assert.throws(
    () => normalizeProviderResponse({ kind: "final" }),
    (error) => error instanceof AgentRuntimeError && error.code === "MALFORMED_PROVIDER_RESPONSE",
  );
  assert.throws(
    () =>
      normalizeProviderResponse({
        kind: "tool_calls",
        toolCalls: [
          { id: "call-1", name: "tool.alpha", input: {} },
          { id: "call-1", name: "tool.beta", input: {} },
        ],
      }),
    (error) => error instanceof AgentRuntimeError && error.code === "MALFORMED_PROVIDER_RESPONSE",
  );
});

test("supported output schema subset accepts valid nested output", () => {
  const schema = {
    type: "object",
    required: ["status", "items"],
    additionalProperties: false,
    properties: {
      status: { enum: ["ok", "degraded"] },
      items: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
          additionalProperties: false,
        },
      },
    },
  };
  validateAgentOutputSchema(schema);
  assert.doesNotThrow(() =>
    assertAgentOutputMatchesSchema({ status: "ok", items: [{ id: 1 }] }, schema),
  );
});

test("output schema fails closed on unsupported keywords", () => {
  assert.throws(
    () => validateAgentOutputSchema({ oneOf: [{ type: "string" }, { type: "number" }] }),
    (error) => error instanceof AgentRuntimeError && error.code === "INVALID_OUTPUT_SCHEMA",
  );
});

test("output mismatch is deterministic", () => {
  const schema = {
    type: "object",
    required: ["decision"],
    properties: { decision: { const: "allow" } },
    additionalProperties: false,
  };
  assert.throws(
    () => assertAgentOutputMatchesSchema({ decision: "deny" }, schema),
    (error) => error instanceof AgentRuntimeError && error.code === "OUTPUT_SCHEMA_MISMATCH",
  );
});
