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
import { PostgresEffectLedger } from "@aegisflow/effects";
import { migrateUp, PostgresPersistence, rollbackLastMigration } from "@aegisflow/persistence";
import { PostgresWorkerQueue } from "@aegisflow/queue";
import { Pool } from "pg";
import {
  AgentRuntimeError,
  PostgresAgentRuntime,
  ProviderInvocationError,
  ProviderRegistry,
  agentProviderEffectIdentity,
} from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required for provider integration tests.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 16 });
const persistence = new PostgresPersistence(pool);
const queue = new PostgresWorkerQueue(pool);
const effects = new PostgresEffectLedger(pool);

async function dropTestSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS agent_provider_results, gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
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
  await pool.query(
    "TRUNCATE agent_provider_results, gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows RESTART IDENTITY",
  );
}

function agentDefinition(provider = "test.provider", overrides = {}) {
  return {
    name: "agent-flow",
    stages: [
      {
        id: "agent_a",
        type: "agent",
        dependsOn: [],
        provider,
        instruction: "Return a status object.",
        allowedTools: [],
        maxSteps: 1,
        outputSchema: {
          type: "object",
          required: ["status"],
          properties: { status: { enum: ["ok"] } },
          additionalProperties: false,
        },
        ...overrides,
      },
    ],
  };
}

function fixture(suffix, definition = agentDefinition()) {
  const flowId = parseFlowId(`flow_${suffix}`);
  const flowVersionId = parseFlowVersionId(`flowv_${suffix}`);
  const executionId = parseExecutionId(`exec_${suffix}`);
  const stageExecutionId = parseStageExecutionId(`stagex_${suffix}`);
  const version = createFlowVersion({ id: flowVersionId, flowId, version: 1, definition });
  const execution = { id: executionId, flowId, flowVersionId, state: "RUNNING" };
  const stage = { id: stageExecutionId, executionId, stageId: definition.stages[0].id, state: "READY" };
  return { flowId, flowVersionId, executionId, stageExecutionId, version, execution, stage };
}

async function createFixture(suffix, definition = agentDefinition()) {
  const data = fixture(suffix, definition);
  await persistence.createFlow({ id: data.flowId, name: data.version.definition.name });
  await persistence.createFlowVersion(data.version);
  await persistence.createExecutionWithStages(data.execution, [data.stage]);
  return data;
}

function registryWith(generate, id = "test.provider") {
  return new ProviderRegistry([{ id, generate }]);
}

async function stageState(stageExecutionId) {
  return (await pool.query("SELECT state FROM stage_executions WHERE id = $1", [stageExecutionId])).rows[0].state;
}

function intentFor(data, stage, step = 1) {
  return {
    kind: "agent_provider_call",
    stageExecutionId: data.stageExecutionId,
    provider: stage.provider,
    instruction: stage.instruction,
    allowedTools: [...stage.allowedTools],
    maxSteps: stage.maxSteps,
    step,
    ...(stage.outputSchema === undefined ? {} : { outputSchema: stage.outputSchema }),
  };
}

test.before(async () => {
  await dropTestSchema();
  await migrateUp(pool);
});

test.after(async () => {
  await pool.end();
});

test("PR7 migration 0005 applies, rolls back, and reapplies after the full durable chain", async () => {
  await dropTestSchema();
  assert.deepEqual(await migrateUp(pool), [
    "0001_initial",
    "0002_worker_claims",
    "0003_effect_ledger",
    "0004_durable_gates",
    "0005_agent_provider_results",
  ]);
  assert.notEqual(
    (await pool.query("SELECT to_regclass('public.agent_provider_results') AS table_name")).rows[0]
      .table_name,
    null,
  );
  assert.equal(await rollbackLastMigration(pool), "0005_agent_provider_results");
  assert.equal(
    (await pool.query("SELECT to_regclass('public.agent_provider_results') AS table_name")).rows[0]
      .table_name,
    null,
  );
  assert.notEqual(
    (await pool.query("SELECT to_regclass('public.gates') AS table_name")).rows[0].table_name,
    null,
  );
  assert.deepEqual(await migrateUp(pool), ["0005_agent_provider_results"]);
});

test("Agent Stage executes one provider call, persists result, closes Effect, and succeeds", async () => {
  await resetData();
  const data = await createFixture("agenta001");
  let calls = 0;
  const runtime = new PostgresAgentRuntime(
    pool,
    registryWith(async (request) => {
      calls += 1;
      assert.equal(request.provider, "test.provider");
      assert.equal(request.step, 1);
      return { kind: "final", output: { status: "ok" }, providerReference: "resp-1", usage: { inputTokens: 4, outputTokens: 2 } };
    }),
  );

  const result = await runtime.runAgentStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_agenta001"),
    ownerId: "worker-a",
    leaseMs: 60_000,
  });

  assert.equal(calls, 1);
  assert.equal(result.providerResult.response.kind, "final");
  assert.equal(result.effect.state, "SUCCEEDED");
  assert.equal(await stageState(data.stageExecutionId), "SUCCEEDED");
  assert.deepEqual((await runtime.getProviderResult(result.effect.id)).response.output, { status: "ok" });
});

test("provider result evidence is database-enforced immutable", async () => {
  await resetData();
  const data = await createFixture("agenta002");
  const runtime = new PostgresAgentRuntime(
    pool,
    registryWith(async () => ({ kind: "final", output: { status: "ok" } })),
  );
  const result = await runtime.runAgentStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_agenta002"),
    ownerId: "worker-a",
    leaseMs: 60_000,
  });

  await assert.rejects(
    pool.query("UPDATE agent_provider_results SET provider = 'evil' WHERE effect_id = $1", [result.effect.id]),
    /agent_provider_results are immutable/,
  );
  await assert.rejects(
    pool.query("DELETE FROM agent_provider_results WHERE effect_id = $1", [result.effect.id]),
    /agent_provider_results are immutable/,
  );
});

test("database validation rejects provider evidence bound to a different StageExecution", async () => {
  await resetData();
  const first = await createFixture("agenta012");
  const second = await createFixture("agenta013");
  const identity = agentProviderEffectIdentity(first.stageExecutionId, 1);
  const stage = first.version.definition.stages[0];
  await effects.planEffect({
    id: identity.effectId,
    executionId: first.executionId,
    stageExecutionId: first.stageExecutionId,
    effectKey: identity.effectKey,
    intent: intentFor(first, stage),
  });
  await assert.rejects(
    pool.query(
      `INSERT INTO agent_provider_results (effect_id, stage_execution_id, step, provider, response)
       VALUES ($1, $2, 1, 'test.provider', '{"kind":"final","output":{}}'::jsonb)`,
      [identity.effectId, second.stageExecutionId],
    ),
    /StageExecution does not own Effect/,
  );
});

test("schema mismatch fails the Stage but preserves successful provider evidence", async () => {
  await resetData();
  const data = await createFixture("agenta003");
  const runtime = new PostgresAgentRuntime(
    pool,
    registryWith(async () => ({ kind: "final", output: { status: "wrong" } })),
  );

  await assert.rejects(
    runtime.runAgentStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: parseAttemptId("attempt_agenta003"),
      ownerId: "worker-a",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "OUTPUT_SCHEMA_MISMATCH",
  );
  assert.equal(await stageState(data.stageExecutionId), "FAILED");
  const identity = agentProviderEffectIdentity(data.stageExecutionId, 1);
  assert.equal((await effects.getEffect(identity.effectId)).effect.state, "SUCCEEDED");
  assert.notEqual(await runtime.getProviderResult(identity.effectId), null);
});

test("tool request is durably recorded but execution remains fail-closed until PR8", async () => {
  await resetData();
  const definition = agentDefinition("test.provider", { allowedTools: ["http.get"] });
  const data = await createFixture("agenta004", definition);
  const runtime = new PostgresAgentRuntime(
    pool,
    registryWith(async () => ({
      kind: "tool_calls",
      toolCalls: [{ id: "call-0001", name: "http.get", input: { url: "https://example.test" } }],
    })),
  );

  await assert.rejects(
    runtime.runAgentStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: parseAttemptId("attempt_agenta004"),
      ownerId: "worker-a",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "TOOL_EXECUTION_UNAVAILABLE",
  );
  assert.equal(await stageState(data.stageExecutionId), "FAILED");
  const identity = agentProviderEffectIdentity(data.stageExecutionId, 1);
  assert.equal((await effects.getEffect(identity.effectId)).effect.state, "SUCCEEDED");
});

test("provider cannot request a tool outside the immutable Stage allow-list", async () => {
  await resetData();
  const data = await createFixture("agenta005");
  const runtime = new PostgresAgentRuntime(
    pool,
    registryWith(async () => ({
      kind: "tool_calls",
      toolCalls: [{ id: "call-0001", name: "shell.exec", input: {} }],
    })),
  );

  await assert.rejects(
    runtime.runAgentStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: parseAttemptId("attempt_agenta005"),
      ownerId: "worker-a",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "TOOL_NOT_ALLOWED",
  );
});

test("recovery reuses a durable provider result without invoking the provider again", async () => {
  await resetData();
  const data = await createFixture("agenta006");
  const stage = data.version.definition.stages[0];
  const oldAttempt = parseAttemptId("attempt_oldagent6");
  const oldClaim = await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: oldAttempt,
    ownerId: "old-worker",
    leaseMs: 60_000,
  });
  assert.notEqual(oldClaim, null);

  const identity = agentProviderEffectIdentity(data.stageExecutionId, 1);
  await effects.planEffect({
    id: identity.effectId,
    executionId: data.executionId,
    stageExecutionId: data.stageExecutionId,
    effectKey: identity.effectKey,
    intent: intentFor(data, stage),
  });
  await effects.claimEffect(identity.effectId);
  await pool.query(
    `INSERT INTO agent_provider_results (effect_id, stage_execution_id, step, provider, response)
     VALUES ($1, $2, 1, $3, $4::jsonb)`,
    [identity.effectId, data.stageExecutionId, stage.provider, JSON.stringify({ kind: "final", output: { status: "ok" } })],
  );
  await pool.query(
    "UPDATE claims SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE attempt_id = $1",
    [oldAttempt],
  );

  let calls = 0;
  const runtime = new PostgresAgentRuntime(
    pool,
    registryWith(async () => {
      calls += 1;
      return { kind: "final", output: { status: "ok" } };
    }),
  );
  const result = await runtime.runAgentStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_newagent6"),
    ownerId: "new-worker",
    leaseMs: 60_000,
  });
  assert.equal(calls, 0);
  assert.equal(result.acquisition.recovered, true);
  assert.equal(result.effect.state, "SUCCEEDED");
  assert.equal(await stageState(data.stageExecutionId), "SUCCEEDED");
});

test("orphaned in-flight provider call is quarantined instead of blindly replayed", async () => {
  await resetData();
  const data = await createFixture("agenta007");
  const stage = data.version.definition.stages[0];
  const oldAttempt = parseAttemptId("attempt_oldagent7");
  await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: oldAttempt,
    ownerId: "old-worker",
    leaseMs: 60_000,
  });
  const identity = agentProviderEffectIdentity(data.stageExecutionId, 1);
  await effects.planEffect({
    id: identity.effectId,
    executionId: data.executionId,
    stageExecutionId: data.stageExecutionId,
    effectKey: identity.effectKey,
    intent: intentFor(data, stage),
  });
  await effects.claimEffect(identity.effectId);
  await pool.query(
    "UPDATE claims SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE attempt_id = $1",
    [oldAttempt],
  );

  let calls = 0;
  const runtime = new PostgresAgentRuntime(
    pool,
    registryWith(async () => {
      calls += 1;
      return { kind: "final", output: { status: "ok" } };
    }),
  );
  await assert.rejects(
    runtime.runAgentStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: parseAttemptId("attempt_newagent7"),
      ownerId: "new-worker",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "PROVIDER_RECONCILIATION_REQUIRED",
  );
  assert.equal(calls, 0);
  assert.equal((await effects.getEffect(identity.effectId)).effect.state, "RECONCILIATION_REQUIRED");
  assert.equal(await stageState(data.stageExecutionId), "FAILED");
});

test("known and ambiguous provider failures map to distinct durable Effect outcomes", async () => {
  await resetData();
  const knownData = await createFixture("agenta008");
  const knownRuntime = new PostgresAgentRuntime(
    pool,
    registryWith(async () => {
      throw new ProviderInvocationError("KNOWN_FAILURE", "rate_limited", "provider rejected request");
    }),
  );
  await assert.rejects(
    knownRuntime.runAgentStage({
      stageExecutionId: knownData.stageExecutionId,
      attemptId: parseAttemptId("attempt_agenta008"),
      ownerId: "worker-a",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "PROVIDER_FAILED",
  );
  assert.equal(
    (await effects.getEffect(agentProviderEffectIdentity(knownData.stageExecutionId, 1).effectId)).effect.state,
    "FAILED",
  );

  await resetData();
  const ambiguousData = await createFixture("agenta009");
  const ambiguousRuntime = new PostgresAgentRuntime(
    pool,
    registryWith(async () => {
      throw new Error("socket vanished after write");
    }),
  );
  await assert.rejects(
    ambiguousRuntime.runAgentStage({
      stageExecutionId: ambiguousData.stageExecutionId,
      attemptId: parseAttemptId("attempt_agenta009"),
      ownerId: "worker-a",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "PROVIDER_AMBIGUOUS",
  );
  assert.equal(
    (await effects.getEffect(agentProviderEffectIdentity(ambiguousData.stageExecutionId, 1).effectId)).effect.state,
    "RECONCILIATION_REQUIRED",
  );
});

test("non-Agent Stage and missing provider fail before worker authority is created", async () => {
  await resetData();
  const taskDefinition = {
    name: "task-only",
    stages: [{ id: "task_a", type: "task", dependsOn: [], handler: "test.handler" }],
  };
  const taskData = await createFixture("agenta010", taskDefinition);
  const runtime = new PostgresAgentRuntime(pool, registryWith(async () => ({ kind: "final", output: {} })));
  await assert.rejects(
    runtime.runAgentStage({
      stageExecutionId: taskData.stageExecutionId,
      attemptId: parseAttemptId("attempt_agenta010"),
      ownerId: "worker-a",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "NOT_AGENT_STAGE",
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM attempts")).rows[0].count, 0);

  await resetData();
  const missingData = await createFixture("agenta011", agentDefinition("missing.provider"));
  const missingRuntime = new PostgresAgentRuntime(pool, new ProviderRegistry());
  await assert.rejects(
    missingRuntime.runAgentStage({
      stageExecutionId: missingData.stageExecutionId,
      attemptId: parseAttemptId("attempt_agenta011"),
      ownerId: "worker-a",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "PROVIDER_NOT_FOUND",
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM attempts")).rows[0].count, 0);
});
