import assert from "node:assert/strict";
import test from "node:test";
import { parseEffectId, parseGateId } from "@aegisflow/contracts";
import { migrateUp } from "@aegisflow/persistence";
import { AegisFlowClient, AegisFlowSdkError } from "@aegisflow/sdk";
import { Pool } from "pg";
import { createControlServer, PostgresControlService } from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required for Control API integration tests.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const service = new PostgresControlService(pool);
const server = createControlServer(service);
let client;

async function dropTestSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS signals, api_idempotency, agent_tool_results, agent_provider_results, gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
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

function listen(serverInstance) {
  return new Promise((resolve, reject) => {
    serverInstance.once("error", reject);
    serverInstance.listen(0, "127.0.0.1", () => resolve());
  });
}

function close(serverInstance) {
  return new Promise((resolve, reject) => {
    serverInstance.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test.before(async () => {
  await dropTestSchema();
  await migrateUp(pool);
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Control API did not bind a TCP port.");
  client = new AegisFlowClient({ baseUrl: `http://127.0.0.1:${address.port}` });
});

test.after(async () => {
  await close(server);
  await pool.end();
});

test("SDK drives Flow versioning, idempotent execution submission, signals, Gates, Effects, and cancellation", async () => {
  const v1 = await client.registerFlow({
    name: "sdk-control",
    stages: [{ id: "task_a", type: "task", dependsOn: [], handler: "test.handler" }],
  });
  assert.equal(v1.created, true);
  assert.equal(v1.version.version, 1);

  const replayedRegistration = await client.registerFlow(v1.version.definition);
  assert.equal(replayedRegistration.created, false);
  assert.equal(replayedRegistration.version.id, v1.version.id);

  const v2 = await client.registerFlow({
    ...v1.version.definition,
    description: "second immutable version",
  });
  assert.equal(v2.created, true);
  assert.equal(v2.version.version, 2);
  const flow = await client.getFlow(v1.flow.id);
  assert.deepEqual(flow.versions.map((version) => version.version), [1, 2]);

  const started = await client.startExecution({
    flowId: v1.flow.id,
    idempotencyKey: "sdk-execution-1",
  });
  assert.equal(started.replayed, false);
  assert.equal(started.execution.flowVersionId, v2.version.id);
  assert.equal(started.execution.state, "RUNNING");
  assert.equal(started.stages[0].state, "READY");

  const startReplay = await client.startExecution({
    flowId: v1.flow.id,
    idempotencyKey: "sdk-execution-1",
  });
  assert.equal(startReplay.replayed, true);
  assert.equal(startReplay.execution.id, started.execution.id);
  await assert.rejects(
    client.startExecution({
      flowId: v1.flow.id,
      flowVersionId: v1.version.id,
      idempotencyKey: "sdk-execution-1",
    }),
    (error) => error instanceof AegisFlowSdkError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  const events = await client.getExecutionEvents(started.execution.id);
  assert.ok(events.events.some((event) => event.eventType === "execution.started"));

  const signalFlow = await client.registerFlow({
    name: "signal-control",
    stages: [{ id: "await_release", type: "signal", dependsOn: [], signalName: "release" }],
  });
  const signalExecution = await client.startExecution({
    flowId: signalFlow.flow.id,
    idempotencyKey: "signal-execution-1",
  });
  const signal = await client.sendSignal({
    executionId: signalExecution.execution.id,
    signalName: "release",
    idempotencyKey: "release-1",
    payload: { ticket: "INC-42" },
  });
  assert.equal(signal.replayed, false);
  assert.equal(signal.resumedStageExecutionIds.length, 1);
  const signalReplay = await client.sendSignal({
    executionId: signalExecution.execution.id,
    signalName: "release",
    idempotencyKey: "release-1",
    payload: { ticket: "INC-42" },
  });
  assert.equal(signalReplay.replayed, true);
  assert.equal(signalReplay.signal.id, signal.signal.id);
  await assert.rejects(
    client.sendSignal({
      executionId: signalExecution.execution.id,
      signalName: "release",
      idempotencyKey: "release-1",
      payload: { ticket: "INC-99" },
    }),
    (error) => error instanceof AegisFlowSdkError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  const signalState = await client.getExecution(signalExecution.execution.id);
  assert.equal(signalState.stages[0].state, "SUCCEEDED");
  assert.equal((await client.getExecutionSignals(signalExecution.execution.id)).signals.length, 1);

  const gateFlow = await client.registerFlow({
    name: "gate-control",
    stages: [
      { id: "approval", type: "gate", dependsOn: [], prompt: "Approve?" },
      { id: "after", type: "task", dependsOn: ["approval"], handler: "test.handler" },
    ],
  });
  const gateExecution = await client.startExecution({
    flowId: gateFlow.flow.id,
    idempotencyKey: "gate-execution-1",
  });
  const gateStage = gateExecution.stages.find((stage) => stage.stageId === "approval");
  assert.ok(gateStage);
  const gateId = parseGateId("gate_sdk00001");
  await service.gates.createGate({
    id: gateId,
    executionId: gateExecution.execution.id,
    stageExecutionId: gateStage.id,
  });
  const approved = await client.approveGate({ gateId, actorId: "operator-1", evidence: { ticket: "CHG-7" } });
  assert.equal(approved.snapshot.gate.state, "APPROVED");
  assert.equal((await client.getGate(gateId)).gate.state, "APPROVED");

  const cancelExecution = await client.startExecution({
    flowId: gateFlow.flow.id,
    idempotencyKey: "gate-execution-2",
  });
  const cancelGateStage = cancelExecution.stages.find((stage) => stage.stageId === "approval");
  assert.ok(cancelGateStage);
  const cancelGateId = parseGateId("gate_sdk00002");
  await service.gates.createGate({
    id: cancelGateId,
    executionId: cancelExecution.execution.id,
    stageExecutionId: cancelGateStage.id,
  });
  const cancelled = await client.cancelExecution(cancelExecution.execution.id);
  assert.equal(cancelled.execution.state, "CANCELLED");
  assert.equal(cancelled.stages.find((stage) => stage.stageId === "approval").state, "FAILED");
  assert.equal(cancelled.stages.find((stage) => stage.stageId === "after").state, "CANCELLED");
  assert.equal((await client.getGate(cancelGateId)).gate.state, "EXPIRED");
  assert.equal((await client.cancelExecution(cancelExecution.execution.id)).execution.state, "CANCELLED");

  const actionFlow = await client.registerFlow({
    name: "effect-control",
    stages: [{
      id: "notify",
      type: "action",
      dependsOn: [],
      connector: "http",
      operation: "POST",
      input: { url: "https://example.invalid/hook" },
    }],
  });
  const actionExecution = await client.startExecution({
    flowId: actionFlow.flow.id,
    idempotencyKey: "effect-execution-1",
  });
  const actionStage = actionExecution.stages[0];
  const effectId = parseEffectId("effect_sdk00001");
  await service.effects.planEffect({
    id: effectId,
    executionId: actionExecution.execution.id,
    stageExecutionId: actionStage.id,
    effectKey: "notify-once",
    intent: { url: "https://example.invalid/hook" },
  });
  await service.effects.claimEffect(effectId);
  await service.effects.completeEffect(effectId, {
    outcome: "AMBIGUOUS",
    resolutionCode: "TIMEOUT_AFTER_SEND",
  });
  assert.equal((await client.getEffect(effectId)).effect.state, "RECONCILIATION_REQUIRED");
  const reconciliation = await client.reconcileEffect({
    effectId,
    decision: "CONFIRMED_SUCCEEDED",
    reconciledBy: "operator-1",
    externalReference: "remote-42",
  });
  assert.equal(reconciliation.created, true);
  assert.equal(reconciliation.reconciliation.decision, "CONFIRMED_SUCCEEDED");
  assert.equal((await client.getExecutionEffects(actionExecution.execution.id)).effects.length, 1);
});
