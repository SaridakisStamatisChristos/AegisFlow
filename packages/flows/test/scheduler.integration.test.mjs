import assert from "node:assert/strict";
import test from "node:test";
import {
  createFlowVersion,
  parseAttemptId,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseGateId,
  parseStageExecutionId,
} from "@aegisflow/contracts";
import { PostgresGateLedger } from "@aegisflow/gates";
import { migrateUp, PostgresPersistence } from "@aegisflow/persistence";
import { PostgresWorkerQueue } from "@aegisflow/queue";
import { Pool } from "pg";
import { PostgresFlowScheduler } from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for scheduler integration tests.");

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const persistence = new PostgresPersistence(pool);
const queue = new PostgresWorkerQueue(pool);
const gates = new PostgresGateLedger(pool);
const scheduler = new PostgresFlowScheduler(pool);

async function dropSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS signals, api_idempotency, agent_tool_results, agent_provider_results,
      gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims,
      execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_quarantine_claimed_effects_on_stage_cancel();
    DROP FUNCTION IF EXISTS aegisflow_reject_signal_mutation();
    DROP FUNCTION IF EXISTS aegisflow_validate_signal_execution();
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
    "TRUNCATE signals, api_idempotency, agent_tool_results, agent_provider_results, gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows RESTART IDENTITY",
  );
}

async function createExecution(suffix, definition) {
  const flowId = parseFlowId(`flow_sched${suffix}`);
  const flowVersionId = parseFlowVersionId(`flowv_sched${suffix}`);
  const executionId = parseExecutionId(`exec_sched${suffix}`);
  const version = createFlowVersion({ id: flowVersionId, flowId, version: 1, definition });
  await persistence.createFlow({ id: flowId, name: definition.name });
  await persistence.createFlowVersion(version);
  const stages = definition.stages.map((stage, index) => ({
    id: parseStageExecutionId(`stagex_${suffix}${String(index).padStart(4, "0")}`),
    executionId,
    stageId: stage.id,
    state: stage.dependsOn.length === 0 ? "READY" : "BLOCKED",
  }));
  await persistence.createExecutionWithStages(
    { id: executionId, flowId, flowVersionId, state: "RUNNING" },
    stages,
  );
  return { executionId, stages };
}

async function stageStates(executionId) {
  const result = await pool.query(
    "SELECT stage_id, state FROM stage_executions WHERE execution_id = $1 ORDER BY stage_id",
    [executionId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.stage_id, row.state]));
}

async function executionState(executionId) {
  return (await pool.query("SELECT state FROM executions WHERE id = $1", [executionId])).rows[0].state;
}

async function completeTask(stageExecutionId, suffix, event = "SUCCEED") {
  const acquisition = await queue.claimStage({
    stageExecutionId,
    attemptId: parseAttemptId(`attempt_${suffix}`),
    ownerId: `worker-${suffix}`,
    leaseMs: 60_000,
  });
  assert.ok(acquisition);
  await queue.completeClaim({
    stageExecutionId,
    attemptId: acquisition.attempt.id,
    ownerId: acquisition.claim.ownerId,
    generation: acquisition.claim.generation,
    event,
  });
}

test.before(async () => {
  await dropSchema();
  await migrateUp(pool);
});

test.after(async () => {
  await pool.end();
});

test("durable early Signal is consumed when its blocked Stage later becomes eligible", async () => {
  await resetData();
  const data = await createExecution("sig00001", {
    name: "scheduler-signal",
    stages: [
      { id: "prepare", type: "task", dependsOn: [], handler: "test.handler" },
      { id: "release", type: "signal", dependsOn: ["prepare"], signalName: "release" },
    ],
  });
  const prepare = data.stages.find((stage) => stage.stageId === "prepare");
  assert.ok(prepare);

  await pool.query(
    `INSERT INTO signals (id, execution_id, signal_name, idempotency_key, request_hash, payload)
     VALUES ($1, $2, 'release', 'early-1', $3, '{}'::jsonb)`,
    ["signal_schedsig00001", data.executionId, "a".repeat(64)],
  );
  assert.equal((await stageStates(data.executionId)).release, "BLOCKED");

  await completeTask(prepare.id, "schedsig00001");
  const result = await scheduler.reconcileExecution(data.executionId);
  assert.equal(result.state, "SUCCEEDED");
  assert.deepEqual(await stageStates(data.executionId), { prepare: "SUCCEEDED", release: "SUCCEEDED" });
  assert.equal(await executionState(data.executionId), "SUCCEEDED");
});

test("Wait Stage durably enters WAITING and later completes from its persisted timestamp", async () => {
  await resetData();
  const data = await createExecution("wait0001", {
    name: "scheduler-wait",
    stages: [{ id: "pause", type: "wait", dependsOn: [], delayMs: 5 }],
  });

  const first = await scheduler.reconcileExecution(data.executionId);
  assert.equal(first.state, "WAITING");
  assert.equal((await stageStates(data.executionId)).pause, "WAITING");
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await scheduler.reconcileExecution(data.executionId);
  assert.equal(second.state, "SUCCEEDED");
  assert.equal((await stageStates(data.executionId)).pause, "SUCCEEDED");
});

test("Gate Stage is materialized automatically and releases dependent work only after approval", async () => {
  await resetData();
  const data = await createExecution("gate0001", {
    name: "scheduler-gate",
    stages: [
      { id: "approval", type: "gate", dependsOn: [], prompt: "Approve deployment?" },
      { id: "deploy", type: "task", dependsOn: ["approval"], handler: "test.handler" },
    ],
  });

  const first = await scheduler.reconcileExecution(data.executionId);
  assert.equal(first.state, "WAITING");
  assert.deepEqual(await stageStates(data.executionId), { approval: "WAITING", deploy: "BLOCKED" });
  const gateRow = (await pool.query(
    "SELECT id FROM gates WHERE execution_id = $1 AND state = 'WAITING'",
    [data.executionId],
  )).rows[0];
  assert.ok(gateRow);

  await gates.resolveGate(parseGateId(gateRow.id), {
    event: "APPROVE",
    actorId: "operator-test",
    evidence: { ticket: "CHG-14" },
  });
  const released = await scheduler.reconcileExecution(data.executionId);
  assert.equal(released.state, "RUNNING");
  assert.equal((await stageStates(data.executionId)).deploy, "READY");

  const deploy = data.stages.find((stage) => stage.stageId === "deploy");
  assert.ok(deploy);
  await completeTask(deploy.id, "schedgate0001");
  const final = await scheduler.reconcileExecution(data.executionId);
  assert.equal(final.state, "SUCCEEDED");
});

test("failed dependency skips blocked descendants and terminalizes the Execution as FAILED", async () => {
  await resetData();
  const data = await createExecution("fail0001", {
    name: "scheduler-failure",
    stages: [
      { id: "root", type: "task", dependsOn: [], handler: "test.handler" },
      { id: "child", type: "task", dependsOn: ["root"], handler: "test.handler" },
      { id: "grandchild", type: "task", dependsOn: ["child"], handler: "test.handler" },
    ],
  });
  const root = data.stages.find((stage) => stage.stageId === "root");
  assert.ok(root);
  await completeTask(root.id, "schedfail0001", "FAIL");

  const result = await scheduler.reconcileExecution(data.executionId);
  assert.equal(result.state, "FAILED");
  assert.deepEqual(await stageStates(data.executionId), {
    child: "SKIPPED",
    grandchild: "SKIPPED",
    root: "FAILED",
  });
});
