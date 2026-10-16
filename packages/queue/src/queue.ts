import {
  ATTEMPT_STATES,
  STAGE_EXECUTION_STATES,
  parseAttemptId,
  parseExecutionId,
  parseStageExecutionId,
  type Attempt,
  type AttemptId,
  type AttemptState,
  type StageExecution,
  type StageExecutionId,
  type StageExecutionState,
} from "@aegisflow/contracts";
import {
  transitionAttempt,
  transitionStageExecution,
} from "@aegisflow/core";
import { withTransaction } from "@aegisflow/persistence";
import { Pool, type PoolClient } from "pg";
import { QueueError } from "./errors.js";

const MAX_LEASE_MS = 86_400_000;
const MAX_GENERATION = 9_223_372_036_854_775_807n;

export const CLAIM_STATES = ["ACTIVE", "COMPLETED", "EXPIRED"] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export interface ClaimRecord {
  readonly attemptId: AttemptId;
  readonly stageExecutionId: StageExecutionId;
  readonly ownerId: string;
  readonly generation: bigint;
  readonly state: ClaimState;
  readonly leaseExpiresAt: Date;
  readonly heartbeatAt: Date;
  readonly claimedAt: Date;
  readonly finishedAt: Date | null;
}

export interface ClaimAcquisition {
  readonly claim: ClaimRecord;
  readonly attempt: Attempt;
  readonly recovered: boolean;
  readonly replacedAttemptId: AttemptId | null;
}

export type ClaimCompletionEvent = "SUCCEED" | "FAIL" | "CANCEL";

export interface ClaimCompletion {
  readonly claim: ClaimRecord;
  readonly attempt: Attempt;
  readonly stage: StageExecution;
}

interface StageRow {
  readonly id: string;
  readonly execution_id: string;
  readonly stage_id: string;
  readonly state: string;
}

interface AttemptRow {
  readonly id: string;
  readonly stage_execution_id: string;
  readonly sequence: number;
  readonly state: string;
}

interface ClaimRow {
  readonly attempt_id: string;
  readonly stage_execution_id: string;
  readonly owner_id: string;
  readonly generation: string;
  readonly state: string;
  readonly lease_expires_at: Date;
  readonly heartbeat_at: Date;
  readonly claimed_at: Date;
  readonly finished_at: Date | null;
}

interface ActiveClaimRow extends ClaimRow {
  readonly expired: boolean;
}

function parseState<State extends string>(
  value: unknown,
  states: readonly State[],
  label: string,
): State {
  if (typeof value !== "string" || !states.includes(value as State)) {
    throw new QueueError("INTEGRITY", `Stored ${label} state is invalid.`);
  }
  return value as State;
}

function mapStage(row: StageRow): StageExecution {
  return Object.freeze({
    id: parseStageExecutionId(row.id),
    executionId: parseExecutionId(row.execution_id),
    stageId: row.stage_id,
    state: parseState<StageExecutionState>(row.state, STAGE_EXECUTION_STATES, "StageExecution"),
  });
}

function mapAttempt(row: AttemptRow): Attempt {
  return Object.freeze({
    id: parseAttemptId(row.id),
    stageExecutionId: parseStageExecutionId(row.stage_execution_id),
    sequence: row.sequence,
    state: parseState<AttemptState>(row.state, ATTEMPT_STATES, "Attempt"),
  });
}

function mapClaim(row: ClaimRow): ClaimRecord {
  const state = parseState<ClaimState>(row.state, CLAIM_STATES, "Claim");
  const generation = BigInt(row.generation);
  if (generation <= 0n || generation > MAX_GENERATION) {
    throw new QueueError("INTEGRITY", "Stored Claim generation is invalid.");
  }
  return Object.freeze({
    attemptId: parseAttemptId(row.attempt_id),
    stageExecutionId: parseStageExecutionId(row.stage_execution_id),
    ownerId: row.owner_id,
    generation,
    state,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
  });
}

function validateOwnerId(ownerId: string): void {
  if (
    typeof ownerId !== "string" ||
    ownerId.length < 1 ||
    ownerId.length > 128 ||
    ownerId.trim() !== ownerId
  ) {
    throw new QueueError("INVALID_INPUT", "ownerId must be a trimmed 1-128 character string.");
  }
}

function validateLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
    throw new QueueError(
      "INVALID_INPUT",
      `leaseMs must be an integer between 1 and ${MAX_LEASE_MS}.`,
    );
  }
}

function validateGeneration(generation: bigint): void {
  if (typeof generation !== "bigint" || generation <= 0n || generation > MAX_GENERATION) {
    throw new QueueError("INVALID_INPUT", "generation must be a positive PostgreSQL bigint.");
  }
}

function translateQueueError(error: unknown, context: string): never {
  if (error instanceof QueueError) throw error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "23505") {
      throw new QueueError("CONFLICT", `${context}: uniqueness conflict.`, { cause: error });
    }
    if (code === "23503" || code === "23514" || code === "22P02") {
      throw new QueueError("INTEGRITY", `${context}: database integrity violation.`, {
        cause: error,
      });
    }
  }
  throw new QueueError("TRANSACTION", `${context}: PostgreSQL operation failed.`, { cause: error });
}

async function lockStage(client: PoolClient, id: StageExecutionId): Promise<StageExecution> {
  const result = await client.query<StageRow>(
    `SELECT id, execution_id, stage_id, state
     FROM stage_executions
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new QueueError("NOT_CLAIMABLE", `StageExecution ${id} does not exist.`);
  }
  return mapStage(row);
}

async function getActiveClaimForUpdate(
  client: PoolClient,
  stageExecutionId: StageExecutionId,
): Promise<ActiveClaimRow | null> {
  const result = await client.query<ActiveClaimRow>(
    `SELECT attempt_id, stage_execution_id, owner_id, generation::text, state,
            lease_expires_at, heartbeat_at, claimed_at, finished_at,
            lease_expires_at <= clock_timestamp() AS expired
     FROM claims
     WHERE stage_execution_id = $1 AND state = 'ACTIVE'
     FOR UPDATE`,
    [stageExecutionId],
  );
  return result.rows[0] ?? null;
}

async function nextGeneration(
  client: PoolClient,
  stageExecutionId: StageExecutionId,
): Promise<bigint> {
  const result = await client.query<{ generation: string }>(
    `SELECT COALESCE(max(generation), 0)::text AS generation
     FROM claims
     WHERE stage_execution_id = $1`,
    [stageExecutionId],
  );
  const current = BigInt(result.rows[0]?.generation ?? "0");
  if (current >= MAX_GENERATION) {
    throw new QueueError("INTEGRITY", "Claim generation exhausted PostgreSQL bigint range.");
  }
  return current + 1n;
}

async function nextAttemptNumber(
  client: PoolClient,
  stageExecutionId: StageExecutionId,
): Promise<number> {
  const result = await client.query<{ sequence: number }>(
    `SELECT COALESCE(max(sequence), 0)::int AS sequence
     FROM attempts
     WHERE stage_execution_id = $1`,
    [stageExecutionId],
  );
  const current = result.rows[0]?.sequence ?? 0;
  if (!Number.isSafeInteger(current) || current < 0 || current >= 2_147_483_647) {
    throw new QueueError("INTEGRITY", "Attempt sequence exhausted PostgreSQL integer range.");
  }
  return current + 1;
}

async function loadAttemptForUpdate(client: PoolClient, attemptId: AttemptId): Promise<Attempt> {
  const result = await client.query<AttemptRow>(
    `SELECT id, stage_execution_id, sequence, state
     FROM attempts
     WHERE id = $1
     FOR UPDATE`,
    [attemptId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new QueueError("INTEGRITY", `Claim references missing Attempt ${attemptId}.`);
  }
  return mapAttempt(row);
}

async function timeoutExpiredClaim(
  client: PoolClient,
  row: ActiveClaimRow,
): Promise<AttemptId> {
  const attemptId = parseAttemptId(row.attempt_id);
  const attempt = await loadAttemptForUpdate(client, attemptId);
  let timedOut: AttemptState;
  try {
    timedOut = transitionAttempt(attempt.state, "TIMEOUT").to;
  } catch (error) {
    throw new QueueError("INTEGRITY", "Expired Claim points at a non-timeoutable Attempt.", {
      cause: error,
    });
  }

  const attemptUpdate = await client.query(
    `UPDATE attempts
     SET state = $2, updated_at = clock_timestamp()
     WHERE id = $1 AND state = $3`,
    [attempt.id, timedOut, attempt.state],
  );
  if (attemptUpdate.rowCount !== 1) {
    throw new QueueError("CONFLICT", "Expired Attempt changed while recovering its Claim.");
  }

  const claimUpdate = await client.query(
    `UPDATE claims
     SET state = 'EXPIRED', finished_at = clock_timestamp()
     WHERE attempt_id = $1 AND generation = $2::bigint AND state = 'ACTIVE'`,
    [row.attempt_id, row.generation],
  );
  if (claimUpdate.rowCount !== 1) {
    throw new QueueError("CONFLICT", "Expired Claim changed while being recovered.");
  }
  return attemptId;
}

export class PostgresWorkerQueue {
  constructor(readonly pool: Pool) {}

  async claimStage(input: {
    readonly stageExecutionId: StageExecutionId;
    readonly attemptId: AttemptId;
    readonly ownerId: string;
    readonly leaseMs: number;
  }): Promise<ClaimAcquisition | null> {
    validateOwnerId(input.ownerId);
    validateLeaseMs(input.leaseMs);

    try {
      return await withTransaction(this.pool, async (client) => {
        const stage = await lockStage(client, input.stageExecutionId);
        const active = await getActiveClaimForUpdate(client, input.stageExecutionId);
        let recovered = false;
        let replacedAttemptId: AttemptId | null = null;

        if (stage.state === "READY") {
          if (active !== null) {
            throw new QueueError("INTEGRITY", "READY StageExecution unexpectedly has an active Claim.");
          }
          const started = transitionStageExecution(stage.state, "START").to;
          const updated = await client.query(
            `UPDATE stage_executions
             SET state = $2, updated_at = clock_timestamp()
             WHERE id = $1 AND state = $3`,
            [stage.id, started, stage.state],
          );
          if (updated.rowCount !== 1) {
            throw new QueueError("CONFLICT", "StageExecution changed while being claimed.");
          }
        } else if (stage.state === "RUNNING") {
          if (active === null) {
            throw new QueueError(
              "INTEGRITY",
              "RUNNING StageExecution has no active Claim to recover.",
            );
          }
          if (!active.expired) return null;
          replacedAttemptId = await timeoutExpiredClaim(client, active);
          recovered = true;
        } else {
          throw new QueueError(
            "NOT_CLAIMABLE",
            `StageExecution ${stage.id} in state ${stage.state} is not worker-claimable.`,
          );
        }

        const generation = await nextGeneration(client, input.stageExecutionId);
        const sequence = await nextAttemptNumber(client, input.stageExecutionId);
        const runningAttemptState = transitionAttempt("CLAIMED", "START").to;

        const attemptResult = await client.query<AttemptRow>(
          `INSERT INTO attempts (id, stage_execution_id, sequence, state)
           VALUES ($1, $2, $3, $4)
           RETURNING id, stage_execution_id, sequence, state`,
          [input.attemptId, input.stageExecutionId, sequence, runningAttemptState],
        );
        const attemptRow = attemptResult.rows[0];
        if (attemptRow === undefined) {
          throw new QueueError("TRANSACTION", "Attempt insert returned no row.");
        }

        const claimResult = await client.query<ClaimRow>(
          `INSERT INTO claims (
             attempt_id, stage_execution_id, owner_id, generation, state,
             lease_expires_at, heartbeat_at, claimed_at
           )
           VALUES (
             $1, $2, $3, $4::bigint, 'ACTIVE',
             clock_timestamp() + ($5::bigint * interval '1 millisecond'),
             clock_timestamp(), clock_timestamp()
           )
           RETURNING attempt_id, stage_execution_id, owner_id, generation::text, state,
                     lease_expires_at, heartbeat_at, claimed_at, finished_at`,
          [input.attemptId, input.stageExecutionId, input.ownerId, generation.toString(), input.leaseMs],
        );
        const claimRow = claimResult.rows[0];
        if (claimRow === undefined) {
          throw new QueueError("TRANSACTION", "Claim insert returned no row.");
        }

        return Object.freeze({
          claim: mapClaim(claimRow),
          attempt: mapAttempt(attemptRow),
          recovered,
          replacedAttemptId,
        });
      });
    } catch (error) {
      return translateQueueError(error, "Claim StageExecution");
    }
  }

  async heartbeatClaim(input: {
    readonly stageExecutionId: StageExecutionId;
    readonly attemptId: AttemptId;
    readonly ownerId: string;
    readonly generation: bigint;
    readonly leaseMs: number;
  }): Promise<ClaimRecord | null> {
    validateOwnerId(input.ownerId);
    validateGeneration(input.generation);
    validateLeaseMs(input.leaseMs);

    try {
      const result = await this.pool.query<ClaimRow>(
        `UPDATE claims
         SET heartbeat_at = clock_timestamp(),
             lease_expires_at = clock_timestamp() + ($5::bigint * interval '1 millisecond')
         WHERE stage_execution_id = $1
           AND attempt_id = $2
           AND owner_id = $3
           AND generation = $4::bigint
           AND state = 'ACTIVE'
           AND lease_expires_at > clock_timestamp()
         RETURNING attempt_id, stage_execution_id, owner_id, generation::text, state,
                   lease_expires_at, heartbeat_at, claimed_at, finished_at`,
        [
          input.stageExecutionId,
          input.attemptId,
          input.ownerId,
          input.generation.toString(),
          input.leaseMs,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapClaim(row);
    } catch (error) {
      return translateQueueError(error, "Heartbeat Claim");
    }
  }

  async completeClaim(input: {
    readonly stageExecutionId: StageExecutionId;
    readonly attemptId: AttemptId;
    readonly ownerId: string;
    readonly generation: bigint;
    readonly event: ClaimCompletionEvent;
  }): Promise<ClaimCompletion> {
    validateOwnerId(input.ownerId);
    validateGeneration(input.generation);

    try {
      return await withTransaction(this.pool, async (client) => {
        const stage = await lockStage(client, input.stageExecutionId);
        const claimResult = await client.query<ActiveClaimRow>(
          `SELECT attempt_id, stage_execution_id, owner_id, generation::text, state,
                  lease_expires_at, heartbeat_at, claimed_at, finished_at,
                  lease_expires_at <= clock_timestamp() AS expired
           FROM claims
           WHERE stage_execution_id = $1
             AND attempt_id = $2
             AND generation = $3::bigint
           FOR UPDATE`,
          [input.stageExecutionId, input.attemptId, input.generation.toString()],
        );
        const claimRow = claimResult.rows[0];
        if (claimRow === undefined || claimRow.owner_id !== input.ownerId || claimRow.state !== "ACTIVE") {
          throw new QueueError("STALE_CLAIM", "Claim is no longer authoritative.");
        }
        if (claimRow.expired) {
          throw new QueueError("LEASE_EXPIRED", "Claim lease expired before completion.");
        }

        const attempt = await loadAttemptForUpdate(client, input.attemptId);
        if (attempt.stageExecutionId !== stage.id) {
          throw new QueueError("INTEGRITY", "Claim Attempt belongs to a different StageExecution.");
        }

        let nextAttemptState: AttemptState;
        let nextStageState: StageExecutionState;
        try {
          nextAttemptState = transitionAttempt(attempt.state, input.event).to;
          nextStageState = transitionStageExecution(stage.state, input.event).to;
        } catch (error) {
          throw new QueueError(
            "INTEGRITY",
            "Claim points at states that cannot be authoritatively completed.",
            { cause: error },
          );
        }

        const attemptUpdate = await client.query(
          `UPDATE attempts
           SET state = $2, updated_at = clock_timestamp()
           WHERE id = $1 AND state = $3`,
          [attempt.id, nextAttemptState, attempt.state],
        );
        const stageUpdate = await client.query(
          `UPDATE stage_executions
           SET state = $2, updated_at = clock_timestamp()
           WHERE id = $1 AND state = $3`,
          [stage.id, nextStageState, stage.state],
        );
        if (attemptUpdate.rowCount !== 1 || stageUpdate.rowCount !== 1) {
          throw new QueueError("CONFLICT", "Attempt or StageExecution changed during completion.");
        }

        const finalClaimResult = await client.query<ClaimRow>(
          `UPDATE claims
           SET state = 'COMPLETED', finished_at = clock_timestamp()
           WHERE attempt_id = $1
             AND stage_execution_id = $2
             AND generation = $3::bigint
             AND owner_id = $4
             AND state = 'ACTIVE'
           RETURNING attempt_id, stage_execution_id, owner_id, generation::text, state,
                     lease_expires_at, heartbeat_at, claimed_at, finished_at`,
          [input.attemptId, input.stageExecutionId, input.generation.toString(), input.ownerId],
        );
        const finalClaimRow = finalClaimResult.rows[0];
        if (finalClaimRow === undefined) {
          throw new QueueError("STALE_CLAIM", "Claim lost authority during completion.");
        }

        return Object.freeze({
          claim: mapClaim(finalClaimRow),
          attempt: Object.freeze({ ...attempt, state: nextAttemptState }),
          stage: Object.freeze({ ...stage, state: nextStageState }),
        });
      });
    } catch (error) {
      return translateQueueError(error, "Complete Claim");
    }
  }

  async listClaimHistory(stageExecutionId: StageExecutionId): Promise<readonly ClaimRecord[]> {
    try {
      const result = await this.pool.query<ClaimRow>(
        `SELECT attempt_id, stage_execution_id, owner_id, generation::text, state,
                lease_expires_at, heartbeat_at, claimed_at, finished_at
         FROM claims
         WHERE stage_execution_id = $1
         ORDER BY generation ASC`,
        [stageExecutionId],
      );
      return Object.freeze(result.rows.map(mapClaim));
    } catch (error) {
      return translateQueueError(error, "List Claim history");
    }
  }
}
