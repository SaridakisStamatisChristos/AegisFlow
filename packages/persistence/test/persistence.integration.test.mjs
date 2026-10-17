import assert from "node:assert/strict";
import test from "node:test";
import {
  createFlowVersion,
  parseAttemptId,
  parseEvidenceId,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseStageExecutionId,
} from "@aegisflow/contracts";
import { Pool } from "pg";
import {
  PersistenceError,
  PostgresPersistence,
  migrateUp,
  rollbackLastMigration,
} from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const repository = new PostgresPersistence(pool);

async function dropTestSchema() {
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
  await pool.query(
    "TRUNCATE agent_tool_results, agent_provider_results, gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows RESTART IDENTITY",
  );
}

function fixture(suffix = "aaaaaaaa") {
  const flowId = parseFlowId(`flow_${suffix}`);
  const flowVersionId = parseFlowVersionId(`flowv_${suffix}`);
  const executionId = parseExecutionId(`exec_${suffix}`);
  const stageExecutionId = parseStageExecutionId(`stagex_${suffix}`);
  const definition = {
    name: `flow-${suffix}`,
    stages: [
      {
        id: "task_a",
        type: "task",
        dependsOn: [],
        handler: "test.handler",
      },
    ],
  };
  const version = createFlowVersion({ id: flowVersionId, flowId, version: 1, definition });
  const execution = { id: executionId, flowId, flowVersionId, state: "PENDING" };
  const stage = { id: stageExecutionId, executionId, stageId: "task_a", state: "READY" };
  return { flowId, flowVersionId, executionId, stageExecutionId, version, execution, stage };
}

async function createExecutionFixture(suffix = "aaaaaaaa") {
  const data = fixture(suffix);
  await repository.createFlow({ id: data.flowId, name: data.version.definition.name });
  await repository.createFlowVersion(data.version);
  await repository.createExecutionWithStages(data.execution, [data.stage]);
  return data;
}

test.before(async () => {
  await dropTestSchema();
});

test.after(async () => {
  await pool.end();
});

test("clean migration chain applies, rolls back, and reapplies", async () => {
  const expected = [
    "0001_initial",
    "0002_worker_claims",
    "0003_effect_ledger",
    "0004_durable_gates",
    "0005_agent_provider_results",
    "0006_agent_tool_results",
  ];
  assert.deepEqual(await migrateUp(pool), expected);

  const tables = await pool.query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename IN ('flows', 'flow_versions', 'executions', 'stage_executions', 'attempts', 'execution_events', 'claims', 'effects', 'effect_reconciliations', 'gates', 'gate_protections', 'gate_resolutions', 'agent_provider_results', 'agent_tool_results')
     ORDER BY tablename`,
  );
  assert.equal(tables.rowCount, 14);

  assert.equal(await rollbackLastMigration(pool), "0006_agent_tool_results");
  assert.equal((await pool.query("SELECT to_regclass('public.agent_tool_results') AS table_name")).rows[0].table_name, null);
  assert.notEqual((await pool.query("SELECT to_regclass('public.agent_provider_results') AS table_name")).rows[0].table_name, null);

  assert.equal(await rollbackLastMigration(pool), "0005_agent_provider_results");
  assert.equal((await pool.query("SELECT to_regclass('public.agent_provider_results') AS table_name")).rows[0].table_name, null);
  assert.notEqual((await pool.query("SELECT to_regclass('public.gates') AS table_name")).rows[0].table_name, null);

  assert.equal(await rollbackLastMigration(pool), "0004_durable_gates");
  assert.equal((await pool.query("SELECT to_regclass('public.gates') AS table_name")).rows[0].table_name, null);
  assert.equal((await pool.query("SELECT to_regclass('public.gate_protections') AS table_name")).rows[0].table_name, null);
  assert.equal((await pool.query("SELECT to_regclass('public.gate_resolutions') AS table_name")).rows[0].table_name, null);
  assert.notEqual((await pool.query("SELECT to_regclass('public.effects') AS table_name")).rows[0].table_name, null);

  assert.equal(await rollbackLastMigration(pool), "0003_effect_ledger");
  assert.equal((await pool.query("SELECT to_regclass('public.effects') AS table_name")).rows[0].table_name, null);
  assert.equal((await pool.query("SELECT to_regclass('public.effect_reconciliations') AS table_name")).rows[0].table_name, null);
  assert.notEqual((await pool.query("SELECT to_regclass('public.claims') AS table_name")).rows[0].table_name, null);

  assert.equal(await rollbackLastMigration(pool), "0002_worker_claims");
  assert.equal((await pool.query("SELECT to_regclass('public.claims') AS table_name")).rows[0].table_name, null);
  assert.notEqual((await pool.query("SELECT to_regclass('public.flows') AS table_name")).rows[0].table_name, null);

  assert.equal(await rollbackLastMigration(pool), "0001_initial");
  assert.equal((await pool.query("SELECT to_regclass('public.flows') AS table_name")).rows[0].table_name, null);
  assert.deepEqual(await migrateUp(pool), expected);
});

test("Flow, immutable FlowVersion, Execution, StageExecution, Attempt, and event round-trip", async () => {
  await resetData();
  const data = await createExecutionFixture();
  assert.equal((await repository.getFlow(data.flowId)).name, data.version.definition.name);
  assert.deepEqual(await repository.getFlowVersion(data.flowVersionId), data.version);
  assert.deepEqual(await repository.getExecution(data.executionId), data.execution);
  assert.deepEqual(await repository.listStageExecutions(data.executionId), [data.stage]);
  const attempt = { id: parseAttemptId("attempt_aaaaaaaa"), stageExecutionId: data.stageExecutionId, sequence: 1, state: "CLAIMED" };
  assert.deepEqual(await repository.createAttempt(attempt), attempt);
  assert.deepEqual(await repository.listAttempts(data.stageExecutionId), [attempt]);
  const event = await repository.appendExecutionEvent({
    id: parseEvidenceId("evidence_aaaaaaaa"), executionId: data.executionId,
    eventType: "EXECUTION_CREATED", payload: { source: "integration-test" },
  });
  assert.equal(event.position, 1n);
  assert.equal(event.eventType, "EXECUTION_CREATED");
  assert.deepEqual(event.payload, { source: "integration-test" });
  assert.deepEqual(await repository.listExecutionEvents(data.executionId), [event]);
});

test("FlowVersion rows are database-enforced append-only", async () => {
  await resetData();
  const data = fixture();
  await repository.createFlow({ id: data.flowId, name: data.version.definition.name });
  await repository.createFlowVersion(data.version);
  await assert.rejects(pool.query("UPDATE flow_versions SET version = 2 WHERE id = $1", [data.flowVersionId]), /flow_versions are immutable/);
  await assert.rejects(pool.query("DELETE FROM flow_versions WHERE id = $1", [data.flowVersionId]), /flow_versions are immutable/);
  assert.equal((await repository.getFlowVersion(data.flowVersionId)).version, 1);
});

test("Execution plus initial Stage materialization is atomic on mid-transaction conflict", async () => {
  await resetData();
  const data = fixture();
  await repository.createFlow({ id: data.flowId, name: data.version.definition.name });
  await repository.createFlowVersion(data.version);
  const conflictingStage = { id: parseStageExecutionId("stagex_bbbbbbbb"), executionId: data.executionId, stageId: data.stage.stageId, state: "BLOCKED" };
  await assert.rejects(
    repository.createExecutionWithStages(data.execution, [data.stage, conflictingStage]),
    (error) => error instanceof PersistenceError && error.code === "CONFLICT",
  );
  assert.equal(await repository.getExecution(data.executionId), null);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM stage_executions")).rows[0].count, 0);
});

test("Execution cannot pin a FlowVersion from a different Flow", async () => {
  await resetData();
  const left = fixture("aaaaaaaa");
  const right = fixture("bbbbbbbb");
  await repository.createFlow({ id: left.flowId, name: left.version.definition.name });
  await repository.createFlow({ id: right.flowId, name: right.version.definition.name });
  await repository.createFlowVersion(right.version);
  const invalidExecution = { ...left.execution, flowVersionId: right.flowVersionId };
  await assert.rejects(
    repository.createExecutionWithStages(invalidExecution, []),
    (error) => error instanceof PersistenceError && error.code === "INTEGRITY",
  );
  assert.equal(await repository.getExecution(left.executionId), null);
});

test("concurrent compare-and-set admits exactly one authoritative state write", async () => {
  await resetData();
  const data = await createExecutionFixture();
  const results = await Promise.all([
    repository.compareAndSetExecutionState(data.executionId, "PENDING", "RUNNING"),
    repository.compareAndSetExecutionState(data.executionId, "PENDING", "CANCELLED"),
  ]);
  assert.deepEqual([...results].sort(), [false, true]);
  const stored = await repository.getExecution(data.executionId);
  assert.ok(stored.state === "RUNNING" || stored.state === "CANCELLED");
});

test("concurrent event appends lose no evidence and preserve a total database order", async () => {
  await resetData();
  const data = await createExecutionFixture();
  const count = 24;
  await Promise.all(Array.from({ length: count }, (_, index) => repository.appendExecutionEvent({
    id: parseEvidenceId(`evidence_event${String(index).padStart(4, "0")}`),
    executionId: data.executionId,
    eventType: "CONCURRENT_APPEND",
    payload: { index },
  })));
  const events = await repository.listExecutionEvents(data.executionId);
  assert.equal(events.length, count);
  assert.equal(new Set(events.map((event) => event.id)).size, count);
  for (let index = 1; index < events.length; index += 1) assert.ok(events[index - 1].position < events[index].position);
});

test("Attempt sequence uniqueness prevents retry history overwrite", async () => {
  await resetData();
  const data = await createExecutionFixture();
  await repository.createAttempt({ id: parseAttemptId("attempt_aaaaaaaa"), stageExecutionId: data.stageExecutionId, sequence: 1, state: "FAILED" });
  await assert.rejects(
    repository.createAttempt({ id: parseAttemptId("attempt_bbbbbbbb"), stageExecutionId: data.stageExecutionId, sequence: 1, state: "CLAIMED" }),
    (error) => error instanceof PersistenceError && error.code === "CONFLICT",
  );
  const attempts = await repository.listAttempts(data.stageExecutionId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].id, parseAttemptId("attempt_aaaaaaaa"));
});
