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
import { PostgresPersistence, migrateUp } from "@aegisflow/persistence";
import { PostgresWorkerQueue, QueueError } from "@aegisflow/queue";
import { Pool } from "pg";
import { GateLedgerError, PostgresGateLedger } from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required for Gate integration tests.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 24 });
const persistence = new PostgresPersistence(pool);
const gates = new PostgresGateLedger(pool);
const queue = new PostgresWorkerQueue(pool);

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

function fixture(
  suffix = "aaaaaaaa",
  { expiresAfterMs = 60_000, protectedState = "READY", twoGates = false } = {},
) {
  const flowId = parseFlowId(`flow_${suffix}`);
  const flowVersionId = parseFlowVersionId(`flowv_${suffix}`);
  const executionId = parseExecutionId(`exec_${suffix}`);
  const gateStageExecutionId = parseStageExecutionId(`stagex_gate${suffix}`);
  const secondGateStageExecutionId = parseStageExecutionId(`stagex_gateb${suffix}`);
  const protectedStageExecutionId = parseStageExecutionId(`stagex_work${suffix}`);
  const freeStageExecutionId = parseStageExecutionId(`stagex_free${suffix}`);

  const gateDefinition = {
    id: "gate_a",
    type: "gate",
    dependsOn: [],
    prompt: "Approve protected work?",
    ...(expiresAfterMs === null ? {} : { expiresAfterMs }),
  };
  const stages = [gateDefinition];
  if (twoGates) {
    stages.push({
      id: "gate_b",
      type: "gate",
      dependsOn: [],
      prompt: "Second approval?",
      expiresAfterMs: 60_000,
    });
  }
  stages.push({
    id: "protected_work",
    type: "task",
    dependsOn: twoGates ? ["gate_a", "gate_b"] : ["gate_a"],
    handler: "test.protected",
  });
  stages.push({
    id: "free_work",
    type: "task",
    dependsOn: [],
    handler: "test.free",
  });

  const version = createFlowVersion({
    id: flowVersionId,
    flowId,
    version: 1,
    definition: { name: `gates-${suffix}`, stages },
  });
  const execution = { id: executionId, flowId, flowVersionId, state: "RUNNING" };
  const stageExecutions = [
    {
      id: gateStageExecutionId,
      executionId,
      stageId: "gate_a",
      state: "READY",
    },
    ...(twoGates
      ? [
          {
            id: secondGateStageExecutionId,
            executionId,
            stageId: "gate_b",
            state: "READY",
          },
        ]
      : []),
    {
      id: protectedStageExecutionId,
      executionId,
      stageId: "protected_work",
      state: protectedState,
    },
    {
      id: freeStageExecutionId,
      executionId,
      stageId: "free_work",
      state: "READY",
    },
  ];
  return {
    flowId,
    flowVersionId,
    executionId,
    gateStageExecutionId,
    secondGateStageExecutionId,
    protectedStageExecutionId,
    freeStageExecutionId,
    version,
    execution,
    stageExecutions,
  };
}

async function createFixture(options = {}) {
  const data = fixture(options.suffix ?? "aaaaaaaa", options);
  await persistence.createFlow({ id: data.flowId, name: data.version.definition.name });
  await persistence.createFlowVersion(data.version);
  await persistence.createExecutionWithStages(data.execution, data.stageExecutions);
  return data;
}

async function openGate(data, gateId = "gate_aaaaaaaa", stageExecutionId = data.gateStageExecutionId) {
  return gates.createGate({
    id: parseGateId(gateId),
    executionId: data.executionId,
    stageExecutionId,
  });
}

async function forceGateDue(gateId) {
  await pool.query(
    "UPDATE gates SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [gateId],
  );
}

async function stageState(executionId, stageExecutionId) {
  const rows = await persistence.listStageExecutions(executionId);
  return rows.find((stage) => stage.id === stageExecutionId)?.state;
}

test.before(async () => {
  await dropTestSchema();
  await migrateUp(pool);
});

test.after(async () => {
  await pool.end();
});

test("Gate creation is derived from the immutable Flow and protects direct dependents", async () => {
  await resetData();
  const data = await createFixture();
  const created = await openGate(data);

  assert.equal(created.created, true);
  assert.equal(created.snapshot.gate.state, "WAITING");
  assert.equal(created.snapshot.resolution, null);
  assert.deepEqual(created.snapshot.protectedStageExecutionIds, [data.protectedStageExecutionId]);
  assert.ok(created.snapshot.gate.expiresAt instanceof Date);
  assert.equal(await stageState(data.executionId, data.gateStageExecutionId), "WAITING");

  const protectedAuth = await gates.getStageGateAuthorization(data.protectedStageExecutionId);
  assert.equal(protectedAuth.allowed, false);
  assert.equal(protectedAuth.blockers[0].state, "WAITING");
  const freeAuth = await gates.getStageGateAuthorization(data.freeStageExecutionId);
  assert.equal(freeAuth.allowed, true);
});

test("duplicate Gate creation is idempotent only for the same durable identity", async () => {
  await resetData();
  const data = await createFixture();
  const first = await openGate(data);
  const duplicate = await openGate(data);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.snapshot.gate.id, first.snapshot.gate.id);

  await assert.rejects(
    openGate(data, "gate_bbbbbbbb"),
    (error) => error instanceof GateLedgerError && error.code === "KEY_CONFLICT",
  );
});

test("non-Gate StageExecution cannot create Gate authority", async () => {
  await resetData();
  const data = await createFixture();
  await assert.rejects(
    openGate(data, "gate_notgate01", data.protectedStageExecutionId),
    (error) => error instanceof GateLedgerError && error.code === "NOT_GATE_STAGE",
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM gates")).rows[0].count, 0);
});

test("Gate creation fails if protected work already started", async () => {
  await resetData();
  const data = await createFixture({ protectedState: "RUNNING" });
  await assert.rejects(
    openGate(data),
    (error) => error instanceof GateLedgerError && error.code === "STALE_STATE",
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM gates")).rows[0].count, 0);
  assert.equal(await stageState(data.executionId, data.gateStageExecutionId), "READY");
});

test("approval persists immutable actor/evidence and duplicate approval does not overwrite it", async () => {
  await resetData();
  const data = await createFixture();
  const created = await openGate(data);
  const approved = await gates.resolveGate(created.snapshot.gate.id, {
    event: "APPROVE",
    actorId: "operator-a",
    evidence: { ticket: "CHG-123", reason: "reviewed" },
  });
  assert.equal(approved.changed, true);
  assert.equal(approved.snapshot.gate.state, "APPROVED");
  assert.equal(approved.snapshot.resolution.actorId, "operator-a");
  assert.deepEqual(approved.snapshot.resolution.evidence, {
    ticket: "CHG-123",
    reason: "reviewed",
  });
  assert.equal(await stageState(data.executionId, data.gateStageExecutionId), "SUCCEEDED");
  assert.equal((await gates.getStageGateAuthorization(data.protectedStageExecutionId)).allowed, true);

  const duplicate = await gates.resolveGate(created.snapshot.gate.id, {
    event: "APPROVE",
    actorId: "operator-b",
    evidence: { attempt: "overwrite" },
  });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.snapshot.resolution.actorId, "operator-a");
  assert.deepEqual(duplicate.snapshot.resolution.evidence, {
    ticket: "CHG-123",
    reason: "reviewed",
  });
});

test("concurrent conflicting decisions produce one durable winner and one deterministic conflict", async () => {
  await resetData();
  const data = await createFixture();
  const created = await openGate(data);
  const settled = await Promise.allSettled([
    gates.resolveGate(created.snapshot.gate.id, {
      event: "APPROVE",
      actorId: "operator-a",
    }),
    gates.resolveGate(created.snapshot.gate.id, {
      event: "REJECT",
      actorId: "operator-b",
    }),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  const rejected = settled.find((result) => result.status === "rejected");
  assert.ok(rejected.reason instanceof GateLedgerError);
  assert.equal(rejected.reason.code, "DECISION_CONFLICT");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM gate_resolutions")).rows[0].count, 1);
});

test("elapsed deadline commits EXPIRED before a late human decision is rejected", async () => {
  await resetData();
  const data = await createFixture();
  const created = await openGate(data);
  await forceGateDue(created.snapshot.gate.id);

  await assert.rejects(
    gates.resolveGate(created.snapshot.gate.id, {
      event: "APPROVE",
      actorId: "late-operator",
    }),
    (error) => error instanceof GateLedgerError && error.code === "DECISION_CONFLICT",
  );
  const stored = await gates.getGate(created.snapshot.gate.id);
  assert.equal(stored.gate.state, "EXPIRED");
  assert.equal(stored.resolution.outcome, "EXPIRED");
  assert.equal(stored.resolution.actorId, null);
  assert.deepEqual(stored.resolution.evidence, { reason: "deadline" });
  assert.equal(await stageState(data.executionId, data.gateStageExecutionId), "FAILED");
  assert.equal((await gates.getStageGateAuthorization(data.protectedStageExecutionId)).allowed, false);
});

test("expiry sweep is due-aware, terminal, and idempotent", async () => {
  await resetData();
  const data = await createFixture();
  const created = await openGate(data);
  assert.equal((await gates.expireGateIfDue(created.snapshot.gate.id)).changed, false);
  await forceGateDue(created.snapshot.gate.id);
  const expired = await gates.expireGateIfDue(created.snapshot.gate.id);
  assert.equal(expired.changed, true);
  assert.equal(expired.snapshot.gate.state, "EXPIRED");
  assert.equal((await gates.expireGateIfDue(created.snapshot.gate.id)).changed, false);
});

test("Gate resolution rows are database-enforced immutable evidence", async () => {
  await resetData();
  const data = await createFixture();
  const created = await openGate(data);
  await gates.resolveGate(created.snapshot.gate.id, {
    event: "APPROVE",
    actorId: "operator-a",
  });

  await assert.rejects(
    pool.query("UPDATE gate_resolutions SET outcome = 'REJECTED' WHERE gate_id = $1", [
      created.snapshot.gate.id,
    ]),
    /gate_resolutions are immutable/,
  );
  await assert.rejects(
    pool.query("DELETE FROM gate_resolutions WHERE gate_id = $1", [created.snapshot.gate.id]),
    /gate_resolutions are immutable/,
  );
});

test("invalid actor or evidence fails before mutating the WAITING Gate", async () => {
  await resetData();
  const data = await createFixture();
  const created = await openGate(data);
  await assert.rejects(
    gates.resolveGate(created.snapshot.gate.id, {
      event: "APPROVE",
      actorId: " operator ",
    }),
    (error) => error instanceof GateLedgerError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    gates.resolveGate(created.snapshot.gate.id, {
      event: "APPROVE",
      actorId: "operator-a",
      evidence: { bad: undefined },
    }),
    (error) => error instanceof GateLedgerError && error.code === "INVALID_INPUT",
  );
  assert.equal((await gates.getGate(created.snapshot.gate.id)).gate.state, "WAITING");
});

test("database Gate protection blocks queue authority until approval and rolls back the failed claim", async () => {
  await resetData();
  const data = await createFixture();
  const created = await openGate(data);

  await assert.rejects(
    queue.claimStage({
      stageExecutionId: data.protectedStageExecutionId,
      attemptId: parseAttemptId("attempt_gateblk01"),
      ownerId: "worker-blocked",
      leaseMs: 60_000,
    }),
    (error) => error instanceof QueueError && error.code === "INTEGRITY",
  );
  assert.deepEqual(await persistence.listAttempts(data.protectedStageExecutionId), []);
  assert.deepEqual(await queue.listClaimHistory(data.protectedStageExecutionId), []);
  assert.equal(await stageState(data.executionId, data.protectedStageExecutionId), "READY");

  await gates.resolveGate(created.snapshot.gate.id, {
    event: "APPROVE",
    actorId: "operator-a",
  });
  const claim = await queue.claimStage({
    stageExecutionId: data.protectedStageExecutionId,
    attemptId: parseAttemptId("attempt_gateok001"),
    ownerId: "worker-approved",
    leaseMs: 60_000,
  });
  assert.ok(claim !== null);
  assert.equal(claim.attempt.state, "RUNNING");
});

test("multiple protecting Gates require unanimous approval before worker authority", async () => {
  await resetData();
  const data = await createFixture({ twoGates: true });
  const first = await openGate(data, "gate_multia001", data.gateStageExecutionId);
  const second = await openGate(data, "gate_multib001", data.secondGateStageExecutionId);

  await gates.resolveGate(first.snapshot.gate.id, {
    event: "APPROVE",
    actorId: "operator-a",
  });
  const afterOne = await gates.getStageGateAuthorization(data.protectedStageExecutionId);
  assert.equal(afterOne.allowed, false);
  assert.equal(afterOne.blockers.length, 1);
  assert.equal(afterOne.blockers[0].gateId, second.snapshot.gate.id);

  await assert.rejects(
    queue.claimStage({
      stageExecutionId: data.protectedStageExecutionId,
      attemptId: parseAttemptId("attempt_multi001"),
      ownerId: "worker-too-early",
      leaseMs: 60_000,
    }),
    (error) => error instanceof QueueError && error.code === "INTEGRITY",
  );

  await gates.resolveGate(second.snapshot.gate.id, {
    event: "APPROVE",
    actorId: "operator-b",
  });
  assert.equal((await gates.getStageGateAuthorization(data.protectedStageExecutionId)).allowed, true);
});

test("Gate cannot cross-bind an Execution to another Execution's StageExecution", async () => {
  await resetData();
  const left = await createFixture({ suffix: "aaaaaaaa" });
  const right = await createFixture({ suffix: "bbbbbbbb" });

  await assert.rejects(
    gates.createGate({
      id: parseGateId("gate_cross0001"),
      executionId: left.executionId,
      stageExecutionId: right.gateStageExecutionId,
    }),
    (error) => error instanceof GateLedgerError && error.code === "KEY_CONFLICT",
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM gates")).rows[0].count, 0);
});

test("replacement ledger instance reconstructs the durable terminal Gate snapshot", async () => {
  await resetData();
  const data = await createFixture();
  const created = await openGate(data);
  await gates.resolveGate(created.snapshot.gate.id, {
    event: "REJECT",
    actorId: "operator-restart",
    evidence: { reason: "risk" },
  });

  const replacement = new PostgresGateLedger(pool);
  const restored = await replacement.getGate(created.snapshot.gate.id);
  assert.equal(restored.gate.state, "REJECTED");
  assert.equal(restored.resolution.actorId, "operator-restart");
  assert.deepEqual(restored.resolution.evidence, { reason: "risk" });
  assert.equal(await stageState(data.executionId, data.gateStageExecutionId), "FAILED");
});

test("database trigger rejects direct ACTIVE Claim bypass while Gate is unresolved", async () => {
  await resetData();
  const data = await createFixture();
  await openGate(data);
  const attemptId = parseAttemptId("attempt_direct001");
  await persistence.createAttempt({
    id: attemptId,
    stageExecutionId: data.protectedStageExecutionId,
    sequence: 1,
    state: "RUNNING",
  });

  await assert.rejects(
    pool.query(
      `INSERT INTO claims (
         attempt_id, stage_execution_id, owner_id, generation, state,
         lease_expires_at, heartbeat_at
       ) VALUES ($1, $2, 'direct-bypass', 1, 'ACTIVE',
                 clock_timestamp() + interval '1 minute', clock_timestamp())`,
      [attemptId, data.protectedStageExecutionId],
    ),
    /blocked by unresolved Gate authority/,
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM claims")).rows[0].count, 0);
});
