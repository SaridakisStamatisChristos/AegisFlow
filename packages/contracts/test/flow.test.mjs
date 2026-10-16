import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractError,
  createFlowVersion,
  parseFlowId,
  parseFlowVersionId,
  validateFlowDefinition,
} from "../dist/index.js";

const validFlow = {
  name: "incident-response",
  description: "Governed incident response",
  stages: [
    {
      id: "classify",
      type: "agent",
      provider: "deterministic",
      instruction: "Classify the incident severity.",
      allowedTools: [],
      maxSteps: 1,
    },
    {
      id: "approval",
      type: "gate",
      dependsOn: ["classify"],
      prompt: "Approve high-severity response?",
    },
    {
      id: "notify",
      type: "action",
      dependsOn: ["approval"],
      connector: "slack",
      operation: "send_message",
      input: { channel: "ops" },
    },
  ],
};

test("valid flow is normalized and accepted", () => {
  const flow = validateFlowDefinition(validFlow);
  assert.equal(flow.name, "incident-response");
  assert.deepEqual(flow.stages[0].dependsOn, []);
  assert.equal(flow.stages[1].type, "gate");
});

test("unknown stage kinds are rejected", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "bad-flow",
        stages: [{ id: "oops", type: "shell", command: "rm -rf /" }],
      }),
    (error) => error instanceof ContractError && error.code === "UNKNOWN_STAGE_KIND",
  );
});

test("duplicate stage IDs are rejected", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "duplicate-stage",
        stages: [
          { id: "same", type: "task", handler: "a" },
          { id: "same", type: "task", handler: "b" },
        ],
      }),
    (error) => error instanceof ContractError && error.code === "DUPLICATE_STAGE_ID",
  );
});

test("unknown dependencies are rejected", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "missing-dependency",
        stages: [
          { id: "only", type: "task", handler: "a", dependsOn: ["missing"] },
        ],
      }),
    (error) => error instanceof ContractError && error.code === "UNKNOWN_DEPENDENCY",
  );
});

test("dependency cycles are rejected", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "cycle",
        stages: [
          { id: "alpha", type: "task", handler: "a", dependsOn: ["beta"] },
          { id: "beta", type: "task", handler: "b", dependsOn: ["alpha"] },
        ],
      }),
    (error) => error instanceof ContractError && error.code === "CYCLE_DETECTED",
  );
});

test("wait stages require exactly one durable wake-up mode", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "bad-wait",
        stages: [{ id: "pause", type: "wait", delayMs: 1000, resumeAt: "2030-01-01T00:00:00Z" }],
      }),
    (error) => error instanceof ContractError && error.code === "INVALID_STAGE_CONFIG",
  );
});

test("non-finite JSON values are rejected", () => {
  assert.throws(
    () =>
      validateFlowDefinition({
        name: "bad-number",
        stages: [
          {
            id: "notify",
            type: "action",
            connector: "http",
            operation: "post",
            input: { timeout: Number.POSITIVE_INFINITY },
          },
        ],
      }),
    (error) => error instanceof ContractError && error.code === "INVALID_STAGE_CONFIG",
  );
});

test("flow versions pin an immutable validated snapshot", () => {
  const source = structuredClone(validFlow);
  const version = createFlowVersion({
    id: parseFlowVersionId("flowv_00000001"),
    flowId: parseFlowId("flow_00000001"),
    version: 1,
    definition: source,
  });

  source.name = "mutated-after-versioning";
  assert.equal(version.definition.name, "incident-response");
  assert.equal(Object.isFrozen(version), true);
  assert.equal(Object.isFrozen(version.definition), true);
  assert.equal(Object.isFrozen(version.definition.stages), true);
  assert.throws(() => {
    version.definition.stages[0].dependsOn.push("later");
  }, TypeError);
});
