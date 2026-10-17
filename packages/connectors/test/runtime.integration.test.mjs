import assert from "node:assert/strict";
import test from "node:test";
import {
  createFlowVersion,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseStageExecutionId,
} from "@aegisflow/contracts";
import { PostgresEffectLedger } from "@aegisflow/effects";
import { migrateUp, PostgresPersistence, rollbackLastMigration } from "@aegisflow/persistence";
import { Pool } from "pg";
import {
  ConnectorInvocationError,
  ConnectorRegistry,
  PostgresToolRuntime,
  ToolRuntimeError,
  agentToolEffectIdentity,
} from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for connector integration tests.");
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const persistence = new PostgresPersistence(pool);
const effects = new PostgresEffectLedger(pool);

async function dropSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS agent_tool_results, agent_provider_results, gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_quarantine_claimed_effects_on_stage_cancel();
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

function fixture(suffix) {
  const flowId = parseFlowId(`flow_${suffix}`);
  const flowVersionId = parseFlowVersionId(`flowv_${suffix}`);
  const executionId = parseExecutionId(`exec_${suffix}`);
  const stageExecutionId = parseStageExecutionId(`stagex_${suffix}`);
  const definition = {
    name: `agent-${suffix}`,
    stages: [{
      id: "agent_a", type: "agent", dependsOn: [], provider: "test.provider",
      instruction: "Use a tool.", allowedTools: ["test.tool"], maxSteps: 2,
    }],
  };
  const version = createFlowVersion({ id: flowVersionId, flowId, version: 1, definition });
  return {
    flowId, flowVersionId, executionId, stageExecutionId, version,
    execution: { id: executionId, flowId, flowVersionId, state: "RUNNING" },
    stage: { id: stageExecutionId, executionId, stageId: "agent_a", state: "RUNNING" },
  };
}

async function createFixture(suffix) {
  const data = fixture(suffix);
  await persistence.createFlow({ id: data.flowId, name: data.version.definition.name });
  await persistence.createFlowVersion(data.version);
  await persistence.createExecutionWithStages(data.execution, [data.stage]);
  return data;
}

function fakeRegistry(execute) {
  return new ConnectorRegistry([{ toolName: "test.tool", authorityScope: "test:scope", execute }]);
}

test.before(async () => { await dropSchema(); await migrateUp(pool); });
test.after(async () => { await pool.end(); });

test("PR8 migration 0006 rolls back and reapplies without removing PR7 provider evidence schema", async () => {
  await dropSchema();
  assert.deepEqual(await migrateUp(pool), [
    "0001_initial", "0002_worker_claims", "0003_effect_ledger", "0004_durable_gates",
    "0005_agent_provider_results", "0006_agent_tool_results", "0008_cancel_claimed_effects",
  ]);
  assert.notEqual((await pool.query("SELECT to_regclass('public.agent_tool_results') AS t")).rows[0].t, null);
  assert.equal(await rollbackLastMigration(pool), "0008_cancel_claimed_effects");
  assert.equal(await rollbackLastMigration(pool), "0006_agent_tool_results");
  assert.equal((await pool.query("SELECT to_regclass('public.agent_tool_results') AS t")).rows[0].t, null);
  assert.notEqual((await pool.query("SELECT to_regclass('public.agent_provider_results') AS t")).rows[0].t, null);
  assert.deepEqual(await migrateUp(pool), ["0006_agent_tool_results", "0008_cancel_claimed_effects"]);
});

test("tool execution persists immutable evidence before Effect success and suppresses replay", async () => {
  await resetData();
  const data = await createFixture("conn0001");
  let calls = 0;
  const runtime = new PostgresToolRuntime(pool, fakeRegistry(async () => {
    calls += 1;
    return { output: { status: "ok" }, externalReference: "remote-1" };
  }));
  const input = {
    executionId: data.executionId,
    stageExecutionId: data.stageExecutionId,
    providerStep: 1,
    call: { id: "call-1", name: "test.tool", input: { value: 7 } },
    recovered: false,
  };
  const first = await runtime.executeToolCall(input);
  const second = await runtime.executeToolCall(input);
  assert.equal(calls, 1);
  assert.equal(first.effect.state, "SUCCEEDED");
  assert.deepEqual(second.result.output, { status: "ok" });
  assert.equal(second.result.externalReference, "remote-1");
  await assert.rejects(pool.query("UPDATE agent_tool_results SET tool_name = 'evil.tool' WHERE effect_id = $1", [first.effect.id]), /agent_tool_results are immutable/);
  await assert.rejects(pool.query("DELETE FROM agent_tool_results WHERE effect_id = $1", [first.effect.id]), /agent_tool_results are immutable/);
});

test("same stable tool identity with different canonical intent fails before another external call", async () => {
  await resetData();
  const data = await createFixture("conn0002");
  let calls = 0;
  const runtime = new PostgresToolRuntime(pool, fakeRegistry(async () => { calls += 1; return { output: { ok: true } }; }));
  await runtime.executeToolCall({
    executionId: data.executionId, stageExecutionId: data.stageExecutionId, providerStep: 1,
    call: { id: "same-call", name: "test.tool", input: { value: 1 } }, recovered: false,
  });
  await assert.rejects(
    runtime.executeToolCall({
      executionId: data.executionId, stageExecutionId: data.stageExecutionId, providerStep: 1,
      call: { id: "same-call", name: "test.tool", input: { value: 2 } }, recovered: false,
    }),
    (error) => error instanceof ToolRuntimeError && error.code === "INTEGRITY",
  );
  assert.equal(calls, 1);
});

test("known connector failure is terminal while unknown transport outcome requires reconciliation", async () => {
  await resetData();
  const known = await createFixture("conn0003");
  const knownRuntime = new PostgresToolRuntime(pool, fakeRegistry(async () => {
    throw new ConnectorInvocationError("KNOWN_FAILURE", "remote_rejected", "request rejected");
  }));
  await assert.rejects(
    knownRuntime.executeToolCall({ executionId: known.executionId, stageExecutionId: known.stageExecutionId, providerStep: 1, call: { id: "known", name: "test.tool", input: {} }, recovered: false }),
    (error) => error instanceof ToolRuntimeError && error.code === "KNOWN_FAILURE",
  );
  assert.equal((await effects.getEffect(agentToolEffectIdentity(known.stageExecutionId, 1, "known").effectId)).effect.state, "FAILED");

  await resetData();
  const ambiguous = await createFixture("conn0004");
  const ambiguousRuntime = new PostgresToolRuntime(pool, fakeRegistry(async () => { throw new Error("socket vanished after write"); }));
  await assert.rejects(
    ambiguousRuntime.executeToolCall({ executionId: ambiguous.executionId, stageExecutionId: ambiguous.stageExecutionId, providerStep: 1, call: { id: "ambiguous", name: "test.tool", input: {} }, recovered: false }),
    (error) => error instanceof ToolRuntimeError && error.code === "AMBIGUOUS",
  );
  assert.equal((await effects.getEffect(agentToolEffectIdentity(ambiguous.stageExecutionId, 1, "ambiguous").effectId)).effect.state, "RECONCILIATION_REQUIRED");
});

test("recovered in-flight tool call without durable evidence is quarantined and never replayed", async () => {
  await resetData();
  const data = await createFixture("conn0005");
  const identity = agentToolEffectIdentity(data.stageExecutionId, 1, "orphan");
  await effects.planEffect({
    id: identity.effectId, executionId: data.executionId, stageExecutionId: data.stageExecutionId,
    effectKey: identity.effectKey,
    intent: { kind: "agent_tool_call", stageExecutionId: data.stageExecutionId, providerStep: 1, callId: "orphan", toolName: "test.tool", authorityScope: "test:scope", input: {} },
  });
  await effects.claimEffect(identity.effectId);
  let calls = 0;
  const runtime = new PostgresToolRuntime(pool, fakeRegistry(async () => { calls += 1; return { output: {} }; }));
  await assert.rejects(
    runtime.executeToolCall({ executionId: data.executionId, stageExecutionId: data.stageExecutionId, providerStep: 1, call: { id: "orphan", name: "test.tool", input: {} }, recovered: true }),
    (error) => error instanceof ToolRuntimeError && error.code === "RECONCILIATION_REQUIRED",
  );
  assert.equal(calls, 0);
  assert.equal((await effects.getEffect(identity.effectId)).effect.state, "RECONCILIATION_REQUIRED");
});

test("database rejects durable tool evidence cross-bound to another StageExecution", async () => {
  await resetData();
  const left = await createFixture("conn0006");
  const right = await createFixture("conn0007");
  const identity = agentToolEffectIdentity(left.stageExecutionId, 1, "cross");
  await effects.planEffect({
    id: identity.effectId, executionId: left.executionId, stageExecutionId: left.stageExecutionId,
    effectKey: identity.effectKey,
    intent: { kind: "agent_tool_call", stageExecutionId: left.stageExecutionId, providerStep: 1, callId: "cross", toolName: "test.tool", authorityScope: "test:scope", input: {} },
  });
  await effects.claimEffect(identity.effectId);
  await assert.rejects(
    pool.query(`INSERT INTO agent_tool_results (effect_id, stage_execution_id, provider_step, call_id, tool_name, output) VALUES ($1,$2,1,'cross','test.tool','{}'::jsonb)`, [identity.effectId, right.stageExecutionId]),
    /StageExecution does not own Effect/,
  );
});
