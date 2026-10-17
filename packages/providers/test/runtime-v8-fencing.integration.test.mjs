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
import { ConnectorRegistry } from "@aegisflow/connectors";
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
if (!databaseUrl) throw new Error("DATABASE_URL is required for PR8 fencing integration tests.");
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
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

async function fixture() {
  const flowId = parseFlowId("flow_fence801");
  const flowVersionId = parseFlowVersionId("flowv_fence801");
  const executionId = parseExecutionId("exec_fence801");
  const stageExecutionId = parseStageExecutionId("stagex_fence801");
  const definition = {
    name: "fencing-agent",
    stages: [{
      id: "agent_a",
      type: "agent",
      dependsOn: [],
      provider: "test.provider",
      instruction: "Return status.",
      allowedTools: [],
      maxSteps: 1,
      outputSchema: {
        type: "object",
        required: ["status"],
        properties: { status: { enum: ["ok"] } },
        additionalProperties: false,
      },
    }],
  };
  const version = createFlowVersion({ id: flowVersionId, flowId, version: 1, definition });
  await persistence.createFlow({ id: flowId, name: definition.name });
  await persistence.createFlowVersion(version);
  await persistence.createExecutionWithStages(
    { id: executionId, flowId, flowVersionId, state: "RUNNING" },
    [{ id: stageExecutionId, executionId, stageId: "agent_a", state: "READY" }],
  );
  return { executionId, stageExecutionId };
}

test.before(async () => { await dropSchema(); await migrateUp(pool); });
test.after(async () => { await pool.end(); });

test("worker authority lost after provider return cannot commit success and recovery never replays", async () => {
  const data = await fixture();
  const firstAttempt = parseAttemptId("attempt_fence801a");
  let providerCalls = 0;
  const providers = new ProviderRegistry([{
    id: "test.provider",
    async generate() {
      providerCalls += 1;
      await pool.query(
        "UPDATE claims SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE attempt_id = $1",
        [firstAttempt],
      );
      return { kind: "final", output: { status: "ok" }, providerReference: "returned-but-stale" };
    },
  }]);
  const runtime = new PostgresAgentRuntime(pool, providers, new ConnectorRegistry());

  await assert.rejects(
    runtime.runAgentStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: firstAttempt,
      ownerId: "worker-old",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "STALE_AUTHORITY",
  );

  const identity = agentProviderEffectIdentity(data.stageExecutionId, 1);
  assert.equal(providerCalls, 1);
  assert.equal((await effects.getEffect(identity.effectId)).effect.state, "CLAIMED");
  assert.equal(await runtime.getProviderResult(identity.effectId), null);
  assert.equal(
    (await pool.query("SELECT state FROM stage_executions WHERE id = $1", [data.stageExecutionId])).rows[0].state,
    "RUNNING",
  );

  const recoveryProviders = new ProviderRegistry([{
    id: "test.provider",
    async generate() {
      providerCalls += 1;
      return { kind: "final", output: { status: "ok" } };
    },
  }]);
  const recovery = new PostgresAgentRuntime(pool, recoveryProviders, new ConnectorRegistry());
  await assert.rejects(
    recovery.runAgentStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: parseAttemptId("attempt_fence801b"),
      ownerId: "worker-new",
      leaseMs: 60_000,
    }),
    (error) => error instanceof AgentRuntimeError && error.code === "PROVIDER_RECONCILIATION_REQUIRED",
  );

  assert.equal(providerCalls, 1);
  assert.equal((await effects.getEffect(identity.effectId)).effect.state, "RECONCILIATION_REQUIRED");
  assert.equal(await recovery.getProviderResult(identity.effectId), null);
});
