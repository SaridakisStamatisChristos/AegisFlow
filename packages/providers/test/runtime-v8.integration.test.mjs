import assert from "node:assert/strict";
import test from "node:test";
import {
  createFlowVersion,
  parseAttemptId,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseStageExecutionId,
} from "@aegisflow/contracts";
import { ConnectorInvocationError, ConnectorRegistry, agentToolEffectIdentity } from "@aegisflow/connectors";
import { PostgresEffectLedger } from "@aegisflow/effects";
import { migrateUp, PostgresPersistence } from "@aegisflow/persistence";
import { Pool } from "pg";
import {
  AgentRuntimeError,
  PostgresAgentRuntime,
  ProviderRegistry,
  agentProviderEffectIdentity,
} from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PR8 provider integration tests.");
const pool = new Pool({ connectionString: databaseUrl, max: 16 });
const persistence = new PostgresPersistence(pool);
const effects = new PostgresEffectLedger(pool);

async function dropSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS agent_tool_results, agent_provider_results, gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_reject_agent_tool_result_mutation();
    DROP FUNCTION IF EXISTS aegisflow_validate_agent_tool_result();
    DROP FUNCTION IF EXISTS aegisflow_reject_agent_provider_result_mutation();
    DROP FUNCTION IF EXISTS aegisflow_validate_agent_provider_result();
    DROP FUNCTION IF EXISTS aegisflow_enforce_gate_protection();
    DROP FUNCTION IF EXISTS aegisflow_reject_gate_resolution_mutation();
    DROP FUNCTION IF EXISTS aegisflow_reject_effect_reconciliation_mutation();
    DROP FUNCTION IF EXISTS aegisflow_reject_flow_version_mutation();
    DROP TABLE IF EXISTS aegisflow_schema_migrations;
  `);
}

async function resetData() {
  await pool.query("TRUNCATE agent_tool_results, agent_provider_results, gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows RESTART IDENTITY");
}

function definition(overrides = {}) {
  return {
    name: "tool-agent",
    stages: [{
      id: "agent_a", type: "agent", dependsOn: [], provider: "test.provider",
      instruction: "Use tools, then return status.", allowedTools: ["test.tool"], maxSteps: 2,
      outputSchema: { type: "object", required: ["status"], properties: { status: { enum: ["ok"] } }, additionalProperties: false },
      ...overrides,
    }],
  };
}

async function fixture(suffix, flowDefinition = definition()) {
  const flowId = parseFlowId(`flow_${suffix}`);
  const flowVersionId = parseFlowVersionId(`flowv_${suffix}`);
  const executionId = parseExecutionId(`exec_${suffix}`);
  const stageExecutionId = parseStageExecutionId(`stagex_${suffix}`);
  const version = createFlowVersion({ id: flowVersionId, flowId, version: 1, definition: flowDefinition });
  await persistence.createFlow({ id: flowId, name: flowDefinition.name });
  await persistence.createFlowVersion(version);
  await persistence.createExecutionWithStages(
    { id: executionId, flowId, flowVersionId, state: "RUNNING" },
    [{ id: stageExecutionId, executionId, stageId: "agent_a", state: "READY" }],
  );
  return { flowId, flowVersionId, executionId, stageExecutionId, version };
}

function providers(generate) {
  return new ProviderRegistry([{ id: "test.provider", generate }]);
}

function connectors(entries) {
  return new ConnectorRegistry(entries.map((entry) => ({
    toolName: entry.name,
    authorityScope: entry.scope ?? `scope:${entry.name}`,
    execute: entry.execute,
  })));
}

async function stageState(id) {
  return (await pool.query("SELECT state FROM stage_executions WHERE id = $1", [id])).rows[0].state;
}

test.before(async () => { await dropSchema(); await migrateUp(pool); });
test.after(async () => { await pool.end(); });

test("Agent Stage executes provider -> durable tool -> provider and succeeds with tool context", async () => {
  await resetData();
  const data = await fixture("agent801");
  const requests = [];
  let toolCalls = 0;
  const runtime = new PostgresAgentRuntime(
    pool,
    providers(async (request) => {
      requests.push(request);
      if (request.step === 1) {
        return { kind: "tool_calls", toolCalls: [{ id: "call-1", name: "test.tool", input: { value: 7 } }] };
      }
      assert.deepEqual(request.toolResults, [{ callId: "call-1", name: "test.tool", output: { observed: 7 } }]);
      return { kind: "final", output: { status: "ok" }, providerReference: "provider-final" };
    }),
    connectors([{ name: "test.tool", execute: async (input) => { toolCalls += 1; return { output: { observed: input.value }, externalReference: "tool-remote" }; } }]),
  );

  const result = await runtime.runAgentStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_agent801"),
    ownerId: "worker-pr8",
    leaseMs: 60_000,
  });
  assert.equal(requests.length, 2);
  assert.equal(toolCalls, 1);
  assert.equal(result.providerResult.response.kind, "final");
  assert.equal(result.toolResults.length, 1);
  assert.equal(await stageState(data.stageExecutionId), "SUCCEEDED");
  assert.equal((await effects.getEffect(agentProviderEffectIdentity(data.stageExecutionId, 1).effectId)).effect.state, "SUCCEEDED");
  assert.equal((await effects.getEffect(agentProviderEffectIdentity(data.stageExecutionId, 2).effectId)).effect.state, "SUCCEEDED");
  assert.equal((await effects.getEffect(agentToolEffectIdentity(data.stageExecutionId, 1, "call-1").effectId)).effect.state, "SUCCEEDED");
});

test("all requested tools are preflighted before the first side effect", async () => {
  await resetData();
  const data = await fixture("agent802", definition({ allowedTools: ["test.tool", "missing.tool"] }));
  let toolCalls = 0;
  const runtime = new PostgresAgentRuntime(
    pool,
    providers(async () => ({
      kind: "tool_calls",
      toolCalls: [
        { id: "call-a", name: "test.tool", input: {} },
        { id: "call-b", name: "missing.tool", input: {} },
      ],
    })),
    connectors([{ name: "test.tool", execute: async () => { toolCalls += 1; return { output: {} }; } }]),
  );
  await assert.rejects(
    runtime.runAgentStage({ stageExecutionId: data.stageExecutionId, attemptId: parseAttemptId("attempt_agent802"), ownerId: "worker-pr8", leaseMs: 60_000 }),
    (error) => error instanceof AgentRuntimeError && error.code === "TOOL_EXECUTION_UNAVAILABLE",
  );
  assert.equal(toolCalls, 0);
  assert.equal(await stageState(data.stageExecutionId), "FAILED");
});

test("maxSteps exhaustion prevents tool side effects", async () => {
  await resetData();
  const data = await fixture("agent803", definition({ maxSteps: 1 }));
  let toolCalls = 0;
  const runtime = new PostgresAgentRuntime(
    pool,
    providers(async () => ({ kind: "tool_calls", toolCalls: [{ id: "late", name: "test.tool", input: {} }] })),
    connectors([{ name: "test.tool", execute: async () => { toolCalls += 1; return { output: {} }; } }]),
  );
  await assert.rejects(
    runtime.runAgentStage({ stageExecutionId: data.stageExecutionId, attemptId: parseAttemptId("attempt_agent803"), ownerId: "worker-pr8", leaseMs: 60_000 }),
    (error) => error instanceof AgentRuntimeError && error.code === "TOOL_EXECUTION_UNAVAILABLE",
  );
  assert.equal(toolCalls, 0);
});

test("tool outside immutable Agent allow-list fails before connector execution", async () => {
  await resetData();
  const data = await fixture("agent804");
  let toolCalls = 0;
  const runtime = new PostgresAgentRuntime(
    pool,
    providers(async () => ({ kind: "tool_calls", toolCalls: [{ id: "denied", name: "other.tool", input: {} }] })),
    connectors([{ name: "other.tool", execute: async () => { toolCalls += 1; return { output: {} }; } }]),
  );
  await assert.rejects(
    runtime.runAgentStage({ stageExecutionId: data.stageExecutionId, attemptId: parseAttemptId("attempt_agent804"), ownerId: "worker-pr8", leaseMs: 60_000 }),
    (error) => error instanceof AgentRuntimeError && error.code === "TOOL_NOT_ALLOWED",
  );
  assert.equal(toolCalls, 0);
});

test("ambiguous connector outcome quarantines the tool Effect and fails closed", async () => {
  await resetData();
  const data = await fixture("agent805");
  const runtime = new PostgresAgentRuntime(
    pool,
    providers(async () => ({ kind: "tool_calls", toolCalls: [{ id: "amb", name: "test.tool", input: {} }] })),
    connectors([{ name: "test.tool", execute: async () => { throw new ConnectorInvocationError("AMBIGUOUS", "socket_unknown", "unknown outcome"); } }]),
  );
  await assert.rejects(
    runtime.runAgentStage({ stageExecutionId: data.stageExecutionId, attemptId: parseAttemptId("attempt_agent805"), ownerId: "worker-pr8", leaseMs: 60_000 }),
    (error) => error instanceof AgentRuntimeError && error.code === "PROVIDER_RECONCILIATION_REQUIRED",
  );
  assert.equal((await effects.getEffect(agentToolEffectIdentity(data.stageExecutionId, 1, "amb").effectId)).effect.state, "RECONCILIATION_REQUIRED");
  assert.equal(await stageState(data.stageExecutionId), "FAILED");
});
