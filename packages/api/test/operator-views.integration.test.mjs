import assert from "node:assert/strict";
import test from "node:test";
import { parseEffectId, parseGateId } from "@aegisflow/contracts";
import { migrateUp } from "@aegisflow/persistence";
import { createHash } from "node:crypto";
import { AegisFlowClient } from "@aegisflow/sdk";
import { Pool } from "pg";
import { createControlServer, PostgresControlService } from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error("DATABASE_URL is required for operator-view integration tests.");
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const service = new PostgresControlService(pool); const apiToken = "aegisflowTestToken_xxxxxxxxxxxxxxxxxxxxx"; const server = createControlServer(service, [{ id: "operator", sha256: createHash("sha256").update(apiToken).digest("hex"), role: "admin" }]); let client;
async function dropTestSchema() {
  await pool.query(`DROP TABLE IF EXISTS signals, api_idempotency, agent_tool_results, agent_provider_results, gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_reject_signal_mutation(); DROP FUNCTION IF EXISTS aegisflow_validate_signal_execution();
    DROP FUNCTION IF EXISTS aegisflow_reject_agent_tool_result_mutation(); DROP FUNCTION IF EXISTS aegisflow_validate_agent_tool_result();
    DROP FUNCTION IF EXISTS aegisflow_reject_agent_provider_result_mutation(); DROP FUNCTION IF EXISTS aegisflow_validate_agent_provider_result();
    DROP FUNCTION IF EXISTS aegisflow_enforce_gate_protection(); DROP FUNCTION IF EXISTS aegisflow_reject_gate_resolution_mutation();
    DROP FUNCTION IF EXISTS aegisflow_reject_effect_reconciliation_mutation(); DROP FUNCTION IF EXISTS aegisflow_reject_flow_version_mutation();
    DROP TABLE IF EXISTS aegisflow_schema_migrations;`);
}
function listen(s) { return new Promise((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", resolve); }); }
function close(s) { return new Promise((resolve, reject) => s.close((error) => error === undefined ? resolve() : reject(error))); }
test.before(async () => { await dropTestSchema(); await migrateUp(pool); await listen(server); const address = server.address(); if (address === null || typeof address === "string") throw new Error("Control API did not bind."); client = new AegisFlowClient({ baseUrl: `http://127.0.0.1:${address.port}`, apiToken }); });
test.after(async () => { await close(server); await pool.end(); });

test("operator read endpoints expose bounded durable state without bypassing ledgers", async () => {
  const alpha = await client.registerFlow({ name: "operator-alpha", stages: [{ id: "approval", type: "gate", dependsOn: [], prompt: "Ship?" }] });
  const betaV1 = await client.registerFlow({ name: "operator-beta", stages: [{ id: "task", type: "task", dependsOn: [], handler: "test.handler" }] });
  await client.registerFlow({ ...betaV1.version.definition, description: "v2" });
  const flows = await client.listFlows();
  assert.equal(flows.truncated, false); assert.deepEqual(flows.flows.map((flow) => flow.name).sort(), ["operator-alpha", "operator-beta"]);
  assert.equal(flows.flows.find((flow) => flow.name === "operator-beta")?.latestVersion, 2);

  const execution = await client.startExecution({ flowId: alpha.flow.id, idempotencyKey: "operator-console-execution" });
  const executions = await client.listExecutions();
  assert.equal(executions.truncated, false); assert.equal(executions.executions[0].id, execution.execution.id); assert.equal(executions.executions[0].flowName, "operator-alpha");

  const gateStage = execution.stages.find((stage) => stage.stageId === "approval"); assert.ok(gateStage);
  const gateId = parseGateId("gate_operator01");
  await service.gates.createGate({ id: gateId, executionId: execution.execution.id, stageExecutionId: gateStage.id });
  const pending = await client.listPendingGates();
  assert.equal(pending.gates.length, 1); assert.equal(pending.gates[0].id, gateId); assert.equal(pending.gates[0].stageId, "approval");
  await client.approveGate({ gateId, actorId: "operator" }); assert.equal((await client.listPendingGates()).gates.length, 0);

  const effectId = parseEffectId("effect_operator01");
  await service.effects.planEffect({ id: effectId, executionId: execution.execution.id, stageExecutionId: gateStage.id, effectKey: "operator-effect", intent: { action: "test" } });
  await service.effects.claimEffect(effectId);
  await service.effects.completeEffect(effectId, { outcome: "AMBIGUOUS", resolutionCode: "UNKNOWN_REMOTE_OUTCOME" });
  const effects = await client.listEffects();
  assert.equal(effects.truncated, false); assert.equal(effects.effects[0].id, effectId); assert.equal(effects.effects[0].state, "RECONCILIATION_REQUIRED");
});
