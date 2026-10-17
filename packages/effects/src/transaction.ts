import {
  EFFECT_STATES,
  parseEffectId,
  parseExecutionId,
  parseStageExecutionId,
  type EffectId,
  type EffectState,
} from "@aegisflow/contracts";
import { transitionEffect } from "@aegisflow/core";
import type { PoolClient } from "pg";
import type { DurableEffectRecord } from "./effects.js";
import { EffectLedgerError } from "./errors.js";

const MAX_METADATA_LENGTH = 512;
const MAX_CODE_LENGTH = 128;

interface EffectRow {
  readonly id: string;
  readonly execution_id: string;
  readonly stage_execution_id: string;
  readonly effect_key: string;
  readonly intent_digest: string;
  readonly state: string;
  readonly claimed_at: Date | null;
  readonly resolved_at: Date | null;
  readonly resolution_code: string | null;
  readonly external_reference: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const EFFECT_COLUMNS = `id, execution_id, stage_execution_id, effect_key, intent_digest, state,
  claimed_at, resolved_at, resolution_code, external_reference, created_at, updated_at`;

function parseEffectState(value: unknown): EffectState {
  if (typeof value !== "string" || !EFFECT_STATES.includes(value as EffectState)) {
    throw new EffectLedgerError("INTEGRITY", "Stored Effect state is invalid.");
  }
  return value as EffectState;
}

function mapEffect(row: EffectRow): DurableEffectRecord {
  return Object.freeze({
    id: parseEffectId(row.id),
    executionId: parseExecutionId(row.execution_id),
    stageExecutionId: parseStageExecutionId(row.stage_execution_id),
    effectKey: row.effect_key,
    intentDigest: row.intent_digest,
    state: parseEffectState(row.state),
    claimedAt: row.claimed_at,
    resolvedAt: row.resolved_at,
    resolutionCode: row.resolution_code,
    externalReference: row.external_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function validateBoundedText(value: string, label: string, maxLength: number): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new EffectLedgerError(
      "INVALID_INPUT",
      `${label} must be a trimmed 1-${maxLength} character single-line string.`,
    );
  }
}

/**
 * Complete one already-CLAIMED Effect inside a caller-owned PostgreSQL transaction.
 *
 * This narrow primitive exists so a runtime can commit immutable local evidence and
 * the corresponding Effect success in the same database transaction. The caller
 * owns BEGIN/COMMIT/ROLLBACK and must not reuse the returned record after rollback.
 */
export async function completeSucceededEffectInTransaction(
  client: PoolClient,
  effectId: EffectId,
  input: {
    readonly resolutionCode: string;
    readonly externalReference?: string;
  },
): Promise<DurableEffectRecord> {
  const id = parseEffectId(effectId);
  validateBoundedText(input.resolutionCode, "resolutionCode", MAX_CODE_LENGTH);
  if (input.externalReference !== undefined) {
    validateBoundedText(input.externalReference, "externalReference", MAX_METADATA_LENGTH);
  }

  try {
    const currentResult = await client.query<EffectRow>(
      `SELECT ${EFFECT_COLUMNS}
       FROM effects
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    const row = currentResult.rows[0];
    if (row === undefined) {
      throw new EffectLedgerError("NOT_FOUND", `Effect ${id} does not exist.`);
    }
    const effect = mapEffect(row);
    if (effect.state !== "CLAIMED") {
      throw new EffectLedgerError(
        "STALE_STATE",
        `Only a CLAIMED Effect can complete transactionally; stored state is ${effect.state}.`,
      );
    }

    const transition = transitionEffect(effect.state, "SUCCEED");
    const updated = await client.query<EffectRow>(
      `UPDATE effects
       SET state = $2,
           resolved_at = clock_timestamp(),
           resolution_code = $3,
           external_reference = $4,
           updated_at = clock_timestamp()
       WHERE id = $1 AND state = $5
       RETURNING ${EFFECT_COLUMNS}`,
      [
        id,
        transition.to,
        input.resolutionCode,
        input.externalReference ?? null,
        transition.from,
      ],
    );
    const updatedRow = updated.rows[0];
    if (updatedRow === undefined) {
      throw new EffectLedgerError("STALE_STATE", "Effect completion lost state authority.");
    }
    return mapEffect(updatedRow);
  } catch (error) {
    if (error instanceof EffectLedgerError) throw error;
    throw new EffectLedgerError(
      "TRANSACTION",
      "Transactional Effect completion failed.",
      { cause: error },
    );
  }
}
