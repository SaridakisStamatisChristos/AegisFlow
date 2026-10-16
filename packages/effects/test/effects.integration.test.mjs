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
import {
  EffectLedgerError,
  PostgresEffectLedger,
  effectIntentDigest,
} from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required for Effect ledger integration tests.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 24 });
const persistence = new PostgresPersistence(pool);
const ledger = new PostgresEffectLedger(pool);

async function dropTestSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_enforce_gate_protection();
    DROP FUNCTION IF EXISTS aegisflow_reject_gate_resolution_mutation();
    DROP FUNCTION IF EXISTS aegisflow_reject_effect_reconciliation_mutation();
    DROP FUNCTION IF EXISTS aegisflow_reject_flow_version_mutation();
    DROP TABLE IF EXISTS aegisflow_schema_migrations;
  `);
}

async function resetData() {
  await pool.query(
    "TRUNCATE gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims, execution_events, attempts, stage_executions, executions, flow_versions, flows RESTART IDENTITY",
  );
}

function fixture(suffix = "aaaaaaaa") {
  const flowId = parseFlowId(`flow_${suffix}`);
  const flowVersionId = parseFlowVersionId(`flowv_${suffix}`);
  const executionId = parseExecutionId(`exec_${suffix}`);
  const stageExecutionId = parseStageExecutionId(`stagex_${suffix}`);
  const version = createFlowVersion({
    id: flowVersionId,
    flowId,
    version: 1,
    definition: {
      name: `effects-${suffix}`,
      stages: [{ id: "action_a", type: "task", dependsOn: [], handler: "test.handler" }],
    },
  });
  const execution = { id: executionId, flowId, flowVersionId, state: "RUNNING" };
  const stage = { id: stageExecutionId, executionId, stageId: "action_a", state: "RUNNING" };
  return { flowId, flowVersionId, executionId, stageExecutionId, version, execution, stage };
}

async function createFixture(suffix = "aaaaaaaa") {
  const data = fixture(suffix);
  await persistence.createFlow({ id: data.flowId, name: data.version.definition.name });
  await persistence.createFlowVersion(data.version);
  await persistence.createExecutionWithStages(data.execution, [data.stage]);
  return data;
}

function intent(value = "alpha") {
  return {
    connector: "test",
    operation: "send",
    input: { value, nested: { enabled: true } },
  };
}

async function plan(data, id = "effect_aaaaaaaa", effectKey = "notify:primary", value = "alpha") {
  return ledger.planEffect({
    id: parseEffectId(id),
    executionId: data.executionId,
    stageExecutionId: data.stageExecutionId,
    effectKey,
    intent: intent(value),
  });
}

test.before(async () => {
  await dropTestSchema();
  await migrateUp(pool);
});

test.after(async () => {
  await pool.end();
});

test("canonical intent digest is order-stable and rejects non-JSON values", () => {
  assert.equal(
    effectIntentDigest({ b: 2, a: { z: true, y: [3, 4] } }),
    effectIntentDigest({ a: { y: [3, 4], z: true }, b: 2 }),
  );
  assert.throws(
    () => effectIntentDigest({ bad: Number.NaN }),
    (error) => error instanceof EffectLedgerError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => effectIntentDigest({ bad: undefined }),
    (error) => error instanceof EffectLedgerError && error.code === "INVALID_INPUT",
  );
});

test("concurrent duplicate planning converges on one Effect record", async () => {
  await resetData();
  const data = await createFixture();
  const plans = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      ledger.planEffect({
        id: parseEffectId(`effect_plan${String(index).padStart(4, "0")}`),
        executionId: data.executionId,
        stageExecutionId: data.stageExecutionId,
        effectKey: "notify:deduplicated",
        intent: intent("same"),
      }),
    ),
  );

  assert.equal(plans.filter((result) => result.created).length, 1);
  assert.equal(new Set(plans.map((result) => result.effect.id)).size, 1);
  const count = await pool.query("SELECT count(*)::int AS count FROM effects");
  assert.equal(count.rows[0].count, 1);
});

test("same effectKey with different canonical intent fails closed", async () => {
  await resetData();
  const data = await createFixture();
  await plan(data, "effect_mismatch1", "notify:stable", "alpha");

  await assert.rejects(
    plan(data, "effect_mismatch2", "notify:stable", "beta"),
    (error) => error instanceof EffectLedgerError && error.code === "KEY_CONFLICT",
  );
  const count = await pool.query("SELECT count(*)::int AS count FROM effects");
  assert.equal(count.rows[0].count, 1);
});

test("concurrent claim admits exactly one external-call authority", async () => {
  await resetData();
  const data = await createFixture();
  const planned = await plan(data, "effect_claim0001");

  const settled = await Promise.allSettled([
    ledger.claimEffect(planned.effect.id),
    ledger.claimEffect(planned.effect.id),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  const fulfilled = settled.find((result) => result.status === "fulfilled");
  assert.equal(fulfilled.value.disposition, "CLAIMED");
  const rejected = settled.find((result) => result.status === "rejected");
  assert.ok(rejected.reason instanceof EffectLedgerError);
  assert.equal(rejected.reason.code, "IN_FLIGHT");
});

test("successful Effect suppresses accidental replay", async () => {
  await resetData();
  const data = await createFixture();
  const planned = await plan(data, "effect_success01");
  assert.equal((await ledger.claimEffect(planned.effect.id)).disposition, "CLAIMED");
  const completed = await ledger.completeEffect(planned.effect.id, {
    outcome: "SUCCEEDED",
    resolutionCode: "HTTP_200",
    externalReference: "provider-message-123",
  });
  assert.equal(completed.effect.state, "SUCCEEDED");

  const replay = await ledger.claimEffect(planned.effect.id);
  assert.equal(replay.disposition, "SUPPRESSED_SUCCEEDED");
  assert.equal(replay.snapshot.effect.id, planned.effect.id);

  const duplicatePlan = await plan(data, "effect_success02");
  assert.equal(duplicatePlan.created, false);
  assert.equal(duplicatePlan.effect.id, planned.effect.id);
  assert.equal(duplicatePlan.effect.state, "SUCCEEDED");
});

test("known failure remains visible and is not automatically replayed", async () => {
  await resetData();
  const data = await createFixture();
  const planned = await plan(data, "effect_failure01");
  await ledger.claimEffect(planned.effect.id);
  const failed = await ledger.completeEffect(planned.effect.id, {
    outcome: "FAILED",
    resolutionCode: "HTTP_400",
  });
  assert.equal(failed.effect.state, "FAILED");

  await assert.rejects(
    ledger.claimEffect(planned.effect.id),
    (error) => error instanceof EffectLedgerError && error.code === "KNOWN_FAILED",
  );
});

test("ambiguous outcome requires reconciliation and confirmed success suppresses replay", async () => {
  await resetData();
  const data = await createFixture();
  const planned = await plan(data, "effect_ambiguity1");
  await ledger.claimEffect(planned.effect.id);
  const ambiguous = await ledger.completeEffect(planned.effect.id, {
    outcome: "AMBIGUOUS",
    resolutionCode: "TIMEOUT_AFTER_WRITE",
  });
  assert.equal(ambiguous.effect.state, "RECONCILIATION_REQUIRED");

  await assert.rejects(
    ledger.claimEffect(planned.effect.id),
    (error) =>
      error instanceof EffectLedgerError && error.code === "RECONCILIATION_REQUIRED",
  );

  const reconciled = await ledger.reconcileEffect(planned.effect.id, {
    decision: "CONFIRMED_SUCCEEDED",
    reconciledBy: "test-reconciler",
    externalReference: "provider-message-999",
  });
  assert.equal(reconciled.created, true);
  assert.equal(reconciled.reconciliation.decision, "CONFIRMED_SUCCEEDED");

  const replay = await ledger.claimEffect(planned.effect.id);
  assert.equal(replay.disposition, "SUPPRESSED_SUCCEEDED");
  assert.equal(replay.snapshot.effect.state, "RECONCILIATION_REQUIRED");
  assert.equal(replay.snapshot.reconciliation.decision, "CONFIRMED_SUCCEEDED");
});

test("reconciliation is idempotent only for the identical immutable decision", async () => {
  await resetData();
  const data = await createFixture();
  const planned = await plan(data, "effect_reconcile1");
  await ledger.claimEffect(planned.effect.id);
  await ledger.completeEffect(planned.effect.id, {
    outcome: "AMBIGUOUS",
    resolutionCode: "CONNECTION_RESET",
  });

  const first = await ledger.reconcileEffect(planned.effect.id, {
    decision: "CONFIRMED_SUCCEEDED",
    reconciledBy: "operator-a",
    externalReference: "ext-1",
  });
  const duplicate = await ledger.reconcileEffect(planned.effect.id, {
    decision: "CONFIRMED_SUCCEEDED",
    reconciledBy: "operator-a",
    externalReference: "ext-1",
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);

  await assert.rejects(
    ledger.reconcileEffect(planned.effect.id, {
      decision: "CONFIRMED_FAILED",
      reconciledBy: "operator-b",
    }),
    (error) => error instanceof EffectLedgerError && error.code === "CONFLICT",
  );
});

test("confirmed failed reconciliation remains blocked from automatic replay", async () => {
  await resetData();
  const data = await createFixture();
  const planned = await plan(data, "effect_reconcile2");
  await ledger.claimEffect(planned.effect.id);
  await ledger.completeEffect(planned.effect.id, {
    outcome: "AMBIGUOUS",
    resolutionCode: "PROVIDER_UNKNOWN",
  });
  await ledger.reconcileEffect(planned.effect.id, {
    decision: "CONFIRMED_FAILED",
    reconciledBy: "operator-a",
  });

  await assert.rejects(
    ledger.claimEffect(planned.effect.id),
    (error) => error instanceof EffectLedgerError && error.code === "KNOWN_FAILED",
  );
});

test("two completion writers cannot both resolve one claimed Effect", async () => {
  await resetData();
  const data = await createFixture();
  const planned = await plan(data, "effect_finish001");
  await ledger.claimEffect(planned.effect.id);

  const settled = await Promise.allSettled([
    ledger.completeEffect(planned.effect.id, {
      outcome: "SUCCEEDED",
      resolutionCode: "HTTP_200",
    }),
    ledger.completeEffect(planned.effect.id, {
      outcome: "SUCCEEDED",
      resolutionCode: "HTTP_200",
    }),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  const rejected = settled.find((result) => result.status === "rejected");
  assert.ok(rejected.reason instanceof EffectLedgerError);
  assert.equal(rejected.reason.code, "STALE_STATE");
});

test("Effect cannot bind an Execution to a StageExecution owned by another Execution", async () => {
  await resetData();
  const left = await createFixture("aaaaaaaa");
  const right = await createFixture("bbbbbbbb");

  await assert.rejects(
    ledger.planEffect({
      id: parseEffectId("effect_cross0001"),
      executionId: left.executionId,
      stageExecutionId: right.stageExecutionId,
      effectKey: "cross-execution",
      intent: intent(),
    }),
    (error) => error instanceof EffectLedgerError && error.code === "KEY_CONFLICT",
  );
  const count = await pool.query("SELECT count(*)::int AS count FROM effects");
  assert.equal(count.rows[0].count, 0);
});

test("reconciliation rows are database-enforced immutable evidence", async () => {
  await resetData();
  const data = await createFixture();
  const planned = await plan(data, "effect_immutable1");
  await ledger.claimEffect(planned.effect.id);
  await ledger.completeEffect(planned.effect.id, {
    outcome: "AMBIGUOUS",
    resolutionCode: "TIMEOUT_AFTER_WRITE",
  });
  await ledger.reconcileEffect(planned.effect.id, {
    decision: "CONFIRMED_SUCCEEDED",
    reconciledBy: "operator-a",
  });

  await assert.rejects(
    pool.query(
      "UPDATE effect_reconciliations SET decision = 'CONFIRMED_FAILED' WHERE effect_id = $1",
      [planned.effect.id],
    ),
    /effect_reconciliations are immutable/,
  );
  await assert.rejects(
    pool.query("DELETE FROM effect_reconciliations WHERE effect_id = $1", [planned.effect.id]),
    /effect_reconciliations are immutable/,
  );
});

test("invalid effect key fails before durable mutation", async () => {
  await resetData();
  const data = await createFixture();
  await assert.rejects(
    ledger.planEffect({
      id: parseEffectId("effect_invalid01"),
      executionId: data.executionId,
      stageExecutionId: data.stageExecutionId,
      effectKey: " bad-key ",
      intent: intent(),
    }),
    (error) => error instanceof EffectLedgerError && error.code === "INVALID_INPUT",
  );
  const count = await pool.query("SELECT count(*)::int AS count FROM effects");
  assert.equal(count.rows[0].count, 0);
});
