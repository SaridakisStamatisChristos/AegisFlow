import assert from "node:assert/strict";
import test from "node:test";

import { ContractError, STAGE_KINDS, validateFlowDefinition } from "../dist/index.js";

test("public Stage-kind contract stays intentionally bounded", () => {
  assert.deepEqual(STAGE_KINDS, [
    "task",
    "agent",
    "decision",
    "action",
    "gate",
    "wait",
    "signal",
    "transform",
  ]);
  assert.equal(STAGE_KINDS.includes("script"), false);
  assert.equal(STAGE_KINDS.includes("shell"), false);
});

test("self dependencies are rejected as cycles", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "self-cycle",
        stages: [{ id: "alpha", type: "task", handler: "run", dependsOn: ["alpha"] }],
      }),
    (error) => error instanceof ContractError && error.code === "CYCLE_DETECTED",
  );
});

test("duplicate dependency declarations are rejected", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "duplicate-dependency",
        stages: [
          { id: "alpha", type: "task", handler: "run" },
          { id: "beta", type: "task", handler: "run", dependsOn: ["alpha", "alpha"] },
        ],
      }),
    ContractError,
  );
});

test("agent maxSteps is bounded", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "unbounded-agent",
        stages: [
          {
            id: "agent",
            type: "agent",
            provider: "deterministic",
            instruction: "loop forever",
            allowedTools: [],
            maxSteps: 1_000_000,
          },
        ],
      }),
    (error) => error instanceof ContractError && error.code === "INVALID_STAGE_CONFIG",
  );
});

test("oversized JSON arrays are rejected", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "oversized-payload",
        stages: [
          {
            id: "call",
            type: "action",
            connector: "http",
            operation: "post",
            input: { values: Array.from({ length: 1_025 }, (_, i) => i) },
          },
        ],
      }),
    (error) => error instanceof ContractError && error.code === "INVALID_STAGE_CONFIG",
  );
});

test("JSON objects cannot prototype-pollute validated payloads", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}');
  const flow = validateFlowDefinition({
    name: "prototype-boundary",
    stages: [
      {
        id: "call",
        type: "action",
        connector: "http",
        operation: "post",
        input,
      },
    ],
  });
  const actionInput = flow.stages[0].input;
  assert.equal(Object.getPrototypeOf(actionInput), null);
  assert.equal(Object.hasOwn(actionInput, "__proto__"), true);
  assert.equal({}.polluted, undefined);
});
