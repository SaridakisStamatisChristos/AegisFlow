import assert from "node:assert/strict";
import test from "node:test";
import {
  createFlowVersion,
  parseEffectId,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseStageExecutionId,
} from "@aegisflow/contracts";
import { migrateUp, PostgresPersistence } from "@aegisflow/persistence";
import { Pool } from "pg";
import { PostgresEffectLedger } from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for cancellation quarantine integration tests.");

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const persistence = new PostgresPersistence(pool);
const effects = new PostgresEffectLedger(pool);

async function dropSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS signals, api_idempotency, agent_tool_results, agent_provider_results,
      gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims,
      execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
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

test.before(async () => {
  await dropSchema();
  await migrateUp(pool);
});

test.after(async () => {
  await pool.end();
});

test("cancelling a Stage quarantines every still-CLAIMED Effect", async () => {
  const flowId = parseFlowId("flow_cancelq01");
  const flowVersionId = parseFlowVersionId("flowv_cancelq01");
  const executionId = parseExecutionId("exec_cancelq01");
  const stageExecutionId = parseStageExecutionId("stagex_cancelq01");
  const version = createFlowVersion({
    id: flowVersionId,
    flowId,
    version: 1,
    definition: {
      name: "cancel-quarantine",
      stages: [{ id: "work", type: "task", dependsOn: [], handler: "test.handler" }],
    },
  });

  await persistence.createFlow({ id: flowId, name: version.definition.name });
  await persistence.createFlowVersion(version);
  await persistence.createExecutionWithStages(
    { id: executionId, flowId, flowVersionId, state: "RUNNING" },
    [{ id: stageExecutionId, executionId, stageId: "work", state: "RUNNING" }],
  );

  const planned = await effects.planEffect({
    id: parseEffectId("effect_cancelq01"),
    executionId,
    stageExecutionId,
    effectKey: "cancel:claimed",
    intent: { operation: "remote-write" },
  });
  await effects.claimEffect(planned.effect.id);

  await pool.query(
    "UPDATE stage_executions SET state = 'CANCELLED', updated_at = clock_timestamp() WHERE id = $1",
    [stageExecutionId],
  );

  const snapshot = await effects.getEffect(planned.effect.id);
  assert.ok(snapshot);
  assert.equal(snapshot.effect.state, "RECONCILIATION_REQUIRED");
  assert.equal(snapshot.effect.resolutionCode, "stage_cancelled_while_claimed");
  assert.ok(snapshot.effect.resolvedAt instanceof Date);
});
