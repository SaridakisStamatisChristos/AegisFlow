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
import { migrateUp, PostgresPersistence } from "@aegisflow/persistence";
import { Pool } from "pg";
import { PostgresWorkerQueue, QueueError } from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required for queue integration tests.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 16 });
const persistence = new PostgresPersistence(pool);
const queue = new PostgresWorkerQueue(pool);

async function dropTestSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS claims, execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_reject_flow_version_mutation();
    DROP TABLE IF EXISTS aegisflow_schema_migrations;
  `);
}

async function resetData() {
  await pool.query(
    "TRUNCATE claims, execution_events, attempts, stage_executions, executions, flow_versions, flows RESTART IDENTITY",
  );
}

function fixture(suffix = "aaaaaaaa", stageState = "READY") {
  const flowId = parseFlowId(`flow_${suffix}`);
  const flowVersionId = parseFlowVersionId(`flowv_${suffix}`);
  const executionId = parseExecutionId(`exec_${suffix}`);
  const stageExecutionId = parseStageExecutionId(`stagex_${suffix}`);
  const version = createFlowVersion({
    id: flowVersionId,
    flowId,
    version: 1,
    definition: {
      name: `queue-${suffix}`,
      stages: [{ id: "task_a", type: "task", dependsOn: [], handler: "test.handler" }],
    },
  });
  const execution = { id: executionId, flowId, flowVersionId, state: "RUNNING" };
  const stage = { id: stageExecutionId, executionId, stageId: "task_a", state: stageState };
  return { flowId, flowVersionId, executionId, stageExecutionId, version, execution, stage };
}

async function createFixture(suffix = "aaaaaaaa", stageState = "READY") {
  const data = fixture(suffix, stageState);
  await persistence.createFlow({ id: data.flowId, name: data.version.definition.name });
  await persistence.createFlowVersion(data.version);
  await persistence.createExecutionWithStages(data.execution, [data.stage]);
  return data;
}

async function forceExpire(attemptId) {
  await pool.query(
    "UPDATE claims SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE attempt_id = $1",
    [attemptId],
  );
}

test.before(async () => {
  await dropTestSchema();
  await migrateUp(pool);
});

test.after(async () => {
  await pool.end();
});

test("concurrent claim admits exactly one worker", async () => {
  await resetData();
  const data = await createFixture();
  const results = await Promise.all([
    queue.claimStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: parseAttemptId("attempt_worker01"),
      ownerId: "worker-a",
      leaseMs: 60_000,
    }),
    queue.claimStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: parseAttemptId("attempt_worker02"),
      ownerId: "worker-b",
      leaseMs: 60_000,
    }),
  ]);

  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  const history = await queue.listClaimHistory(data.stageExecutionId);
  assert.equal(history.length, 1);
  assert.equal(history[0].state, "ACTIVE");
  assert.equal(history[0].generation, 1n);
  const attempts = await persistence.listAttempts(data.stageExecutionId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "RUNNING");
  assert.equal((await persistence.listStageExecutions(data.executionId))[0].state, "RUNNING");
});

test("heartbeat extends only the live authoritative claim", async () => {
  await resetData();
  const data = await createFixture();
  const acquired = await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_heartbeat"),
    ownerId: "worker-heartbeat",
    leaseMs: 60_000,
  });
  assert.ok(acquired !== null);

  const heartbeat = await queue.heartbeatClaim({
    stageExecutionId: data.stageExecutionId,
    attemptId: acquired.attempt.id,
    ownerId: acquired.claim.ownerId,
    generation: acquired.claim.generation,
    leaseMs: 120_000,
  });
  assert.ok(heartbeat !== null);
  assert.ok(heartbeat.leaseExpiresAt > acquired.claim.leaseExpiresAt);

  const wrongGeneration = await queue.heartbeatClaim({
    stageExecutionId: data.stageExecutionId,
    attemptId: acquired.attempt.id,
    ownerId: acquired.claim.ownerId,
    generation: acquired.claim.generation + 1n,
    leaseMs: 120_000,
  });
  assert.equal(wrongGeneration, null);

  await forceExpire(acquired.attempt.id);
  const expiredHeartbeat = await queue.heartbeatClaim({
    stageExecutionId: data.stageExecutionId,
    attemptId: acquired.attempt.id,
    ownerId: acquired.claim.ownerId,
    generation: acquired.claim.generation,
    leaseMs: 120_000,
  });
  assert.equal(expiredHeartbeat, null);
});

test("killed-worker recovery fences stale completion and preserves Attempt history", async () => {
  await resetData();
  const data = await createFixture();
  const first = await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_recover1"),
    ownerId: "worker-dead",
    leaseMs: 60_000,
  });
  assert.ok(first !== null);
  await forceExpire(first.attempt.id);

  const second = await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_recover2"),
    ownerId: "worker-live",
    leaseMs: 60_000,
  });
  assert.ok(second !== null);
  assert.equal(second.recovered, true);
  assert.equal(second.replacedAttemptId, first.attempt.id);
  assert.equal(second.claim.generation, 2n);
  assert.equal(second.attempt.sequence, 2);

  const attempts = await persistence.listAttempts(data.stageExecutionId);
  assert.deepEqual(
    attempts.map((attempt) => [attempt.sequence, attempt.state]),
    [[1, "TIMED_OUT"], [2, "RUNNING"]],
  );
  const claims = await queue.listClaimHistory(data.stageExecutionId);
  assert.deepEqual(
    claims.map((claim) => [claim.generation, claim.state]),
    [[1n, "EXPIRED"], [2n, "ACTIVE"]],
  );

  await assert.rejects(
    queue.completeClaim({
      stageExecutionId: data.stageExecutionId,
      attemptId: first.attempt.id,
      ownerId: first.claim.ownerId,
      generation: first.claim.generation,
      event: "SUCCEED",
    }),
    (error) => error instanceof QueueError && error.code === "STALE_CLAIM",
  );

  const completed = await queue.completeClaim({
    stageExecutionId: data.stageExecutionId,
    attemptId: second.attempt.id,
    ownerId: second.claim.ownerId,
    generation: second.claim.generation,
    event: "SUCCEED",
  });
  assert.equal(completed.attempt.state, "SUCCEEDED");
  assert.equal(completed.stage.state, "SUCCEEDED");
  assert.equal(completed.claim.state, "COMPLETED");
});

test("two finishers cannot authoritatively complete the same generation", async () => {
  await resetData();
  const data = await createFixture();
  const acquired = await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_finish01"),
    ownerId: "worker-finish",
    leaseMs: 60_000,
  });
  assert.ok(acquired !== null);

  const completion = {
    stageExecutionId: data.stageExecutionId,
    attemptId: acquired.attempt.id,
    ownerId: acquired.claim.ownerId,
    generation: acquired.claim.generation,
    event: "SUCCEED",
  };
  const settled = await Promise.allSettled([
    queue.completeClaim(completion),
    queue.completeClaim(completion),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  const rejection = settled.find((result) => result.status === "rejected");
  assert.ok(rejection.reason instanceof QueueError);
  assert.equal(rejection.reason.code, "STALE_CLAIM");
});

test("expired claim cannot complete before recovery", async () => {
  await resetData();
  const data = await createFixture();
  const acquired = await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_expired1"),
    ownerId: "worker-expired",
    leaseMs: 60_000,
  });
  assert.ok(acquired !== null);
  await forceExpire(acquired.attempt.id);

  await assert.rejects(
    queue.completeClaim({
      stageExecutionId: data.stageExecutionId,
      attemptId: acquired.attempt.id,
      ownerId: acquired.claim.ownerId,
      generation: acquired.claim.generation,
      event: "SUCCEED",
    }),
    (error) => error instanceof QueueError && error.code === "LEASE_EXPIRED",
  );
});

test("repeated recovery keeps generations monotonic and history append-only", async () => {
  await resetData();
  const data = await createFixture();
  const first = await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_chain001"),
    ownerId: "worker-1",
    leaseMs: 60_000,
  });
  assert.ok(first !== null);
  await forceExpire(first.attempt.id);
  const second = await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_chain002"),
    ownerId: "worker-2",
    leaseMs: 60_000,
  });
  assert.ok(second !== null);
  await forceExpire(second.attempt.id);
  const third = await queue.claimStage({
    stageExecutionId: data.stageExecutionId,
    attemptId: parseAttemptId("attempt_chain003"),
    ownerId: "worker-3",
    leaseMs: 60_000,
  });
  assert.ok(third !== null);

  const claims = await queue.listClaimHistory(data.stageExecutionId);
  assert.deepEqual(claims.map((claim) => claim.generation), [1n, 2n, 3n]);
  assert.deepEqual(claims.map((claim) => claim.state), ["EXPIRED", "EXPIRED", "ACTIVE"]);
  const attempts = await persistence.listAttempts(data.stageExecutionId);
  assert.deepEqual(attempts.map((attempt) => attempt.sequence), [1, 2, 3]);
  assert.deepEqual(attempts.map((attempt) => attempt.state), ["TIMED_OUT", "TIMED_OUT", "RUNNING"]);
});

test("non-ready stage is rejected without creating claim history", async () => {
  await resetData();
  const data = await createFixture("bbbbbbbb", "BLOCKED");
  await assert.rejects(
    queue.claimStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: parseAttemptId("attempt_blocked1"),
      ownerId: "worker-blocked",
      leaseMs: 60_000,
    }),
    (error) => error instanceof QueueError && error.code === "NOT_CLAIMABLE",
  );
  assert.deepEqual(await queue.listClaimHistory(data.stageExecutionId), []);
  assert.deepEqual(await persistence.listAttempts(data.stageExecutionId), []);
});

test("invalid lease configuration fails before touching durable state", async () => {
  await resetData();
  const data = await createFixture();
  await assert.rejects(
    queue.claimStage({
      stageExecutionId: data.stageExecutionId,
      attemptId: parseAttemptId("attempt_badlease"),
      ownerId: "worker-bad",
      leaseMs: 0,
    }),
    (error) => error instanceof QueueError && error.code === "INVALID_INPUT",
  );
  assert.deepEqual(await queue.listClaimHistory(data.stageExecutionId), []);
});
