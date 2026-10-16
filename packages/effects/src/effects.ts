import {
  EFFECT_STATES,
  parseEffectId,
  parseExecutionId,
  parseStageExecutionId,
  type EffectId,
  type EffectState,
  type ExecutionId,
  type JsonObject,
  type StageExecutionId,
} from "@aegisflow/contracts";
import { transitionEffect, type EffectEvent } from "@aegisflow/core";
import { withTransaction } from "@aegisflow/persistence";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EffectLedgerError } from "./errors.js";

const MAX_EFFECT_KEY_LENGTH = 256;
const MAX_METADATA_LENGTH = 512;
const MAX_CODE_LENGTH = 128;
const MAX_INTENT_DEPTH = 64;
const MAX_INTENT_ITEMS = 10_000;
const MAX_CANONICAL_INTENT_BYTES = 1_048_576;

export type ReconciliationDecision = "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED";
export type EffectCompletionOutcome = "SUCCEEDED" | "FAILED" | "AMBIGUOUS";

export interface DurableEffectRecord {
  readonly id: EffectId;
  readonly executionId: ExecutionId;
  readonly stageExecutionId: StageExecutionId;
  readonly effectKey: string;
  readonly intentDigest: string;
  readonly state: EffectState;
  readonly claimedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly resolutionCode: string | null;
  readonly externalReference: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EffectReconciliationRecord {
  readonly effectId: EffectId;
  readonly decision: ReconciliationDecision;
  readonly reconciledBy: string;
  readonly externalReference: string | null;
  readonly reconciledAt: Date;
}

export interface EffectSnapshot {
  readonly effect: DurableEffectRecord;
  readonly reconciliation: EffectReconciliationRecord | null;
}

export interface PlanEffectInput {
  readonly id: EffectId;
  readonly executionId: ExecutionId;
  readonly stageExecutionId: StageExecutionId;
  readonly effectKey: string;
  readonly intent: JsonObject;
}

export interface PlanEffectResult {
  readonly effect: DurableEffectRecord;
  readonly created: boolean;
}

export type EffectClaimDisposition = "CLAIMED" | "SUPPRESSED_SUCCEEDED";

export interface EffectClaimResult {
  readonly disposition: EffectClaimDisposition;
  readonly snapshot: EffectSnapshot;
}

export interface CompleteEffectInput {
  readonly outcome: EffectCompletionOutcome;
  readonly resolutionCode: string;
  readonly externalReference?: string;
}

export interface ReconcileEffectInput {
  readonly decision: ReconciliationDecision;
  readonly reconciledBy: string;
  readonly externalReference?: string;
}

export interface ReconcileEffectResult {
  readonly reconciliation: EffectReconciliationRecord;
  readonly created: boolean;
}

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

interface ReconciliationRow {
  readonly effect_id: string;
  readonly decision: string;
  readonly reconciled_by: string;
  readonly external_reference: string | null;
  readonly reconciled_at: Date;
}

interface StageOwnerRow {
  readonly execution_id: string;
}

function validateEffectKey(effectKey: string): void {
  if (
    typeof effectKey !== "string" ||
    effectKey.length < 1 ||
    effectKey.length > MAX_EFFECT_KEY_LENGTH ||
    effectKey.trim() !== effectKey ||
    /[\u0000-\u001f\u007f]/u.test(effectKey)
  ) {
    throw new EffectLedgerError(
      "INVALID_INPUT",
      `effectKey must be a trimmed 1-${MAX_EFFECT_KEY_LENGTH} character string without control characters.`,
    );
  }
}

function validateBoundedText(
  value: string,
  label: string,
  maxLength: number,
): void {
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

function validateOptionalMetadata(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  validateBoundedText(value, label, MAX_METADATA_LENGTH);
  return value;
}

function canonicalJson(value: unknown, depth: number): string {
  if (depth > MAX_INTENT_DEPTH) {
    throw new EffectLedgerError("INVALID_INPUT", "Effect intent exceeds maximum nesting depth.");
  }
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new EffectLedgerError("INVALID_INPUT", "Effect intent contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_INTENT_ITEMS) {
      throw new EffectLedgerError("INVALID_INPUT", "Effect intent array is too large.");
    }
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EffectLedgerError("INVALID_INPUT", "Effect intent must contain only JSON objects.");
    }
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    if (keys.length > MAX_INTENT_ITEMS) {
      throw new EffectLedgerError("INVALID_INPUT", "Effect intent object has too many keys.");
    }
    const encoded = keys.map((key) => {
      if (key.length > MAX_EFFECT_KEY_LENGTH) {
        throw new EffectLedgerError("INVALID_INPUT", "Effect intent contains an oversized key.");
      }
      return `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`;
    });
    return `{${encoded.join(",")}}`;
  }
  throw new EffectLedgerError("INVALID_INPUT", "Effect intent contains a non-JSON value.");
}

export function effectIntentDigest(intent: unknown): string {
  const canonical = canonicalJson(intent, 0);
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_INTENT_BYTES) {
    throw new EffectLedgerError("INVALID_INPUT", "Canonical Effect intent exceeds 1 MiB.");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function parseEffectState(value: unknown): EffectState {
  if (typeof value !== "string" || !EFFECT_STATES.includes(value as EffectState)) {
    throw new EffectLedgerError("INTEGRITY", "Stored Effect state is invalid.");
  }
  return value as EffectState;
}

function parseReconciliationDecision(value: unknown): ReconciliationDecision {
  if (value === "CONFIRMED_SUCCEEDED" || value === "CONFIRMED_FAILED") return value;
  throw new EffectLedgerError("INTEGRITY", "Stored Effect reconciliation decision is invalid.");
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

function mapReconciliation(row: ReconciliationRow): EffectReconciliationRecord {
  return Object.freeze({
    effectId: parseEffectId(row.effect_id),
    decision: parseReconciliationDecision(row.decision),
    reconciledBy: row.reconciled_by,
    externalReference: row.external_reference,
    reconciledAt: row.reconciled_at,
  });
}

function translateEffectError(error: unknown, context: string): never {
  if (error instanceof EffectLedgerError) throw error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "23505") {
      throw new EffectLedgerError("CONFLICT", `${context}: uniqueness conflict.`, { cause: error });
    }
    if (code === "23503" || code === "23514" || code === "22P02") {
      throw new EffectLedgerError("INTEGRITY", `${context}: database integrity violation.`, {
        cause: error,
      });
    }
  }
  throw new EffectLedgerError("TRANSACTION", `${context}: PostgreSQL operation failed.`, {
    cause: error,
  });
}

const EFFECT_COLUMNS = `id, execution_id, stage_execution_id, effect_key, intent_digest, state,
  claimed_at, resolved_at, resolution_code, external_reference, created_at, updated_at`;

async function getEffectForUpdate(client: PoolClient, effectId: EffectId): Promise<EffectRow> {
  const result = await client.query<EffectRow>(
    `SELECT ${EFFECT_COLUMNS}
     FROM effects
     WHERE id = $1
     FOR UPDATE`,
    [effectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new EffectLedgerError("NOT_FOUND", `Effect ${effectId} does not exist.`);
  }
  return row;
}

async function getReconciliation(
  client: PoolClient,
  effectId: EffectId,
): Promise<ReconciliationRow | null> {
  const result = await client.query<ReconciliationRow>(
    `SELECT effect_id, decision, reconciled_by, external_reference, reconciled_at
     FROM effect_reconciliations
     WHERE effect_id = $1`,
    [effectId],
  );
  return result.rows[0] ?? null;
}

function validateStoredReconciliation(
  effect: DurableEffectRecord,
  reconciliation: EffectReconciliationRecord | null,
): void {
  if (reconciliation !== null && effect.state !== "RECONCILIATION_REQUIRED") {
    throw new EffectLedgerError(
      "INTEGRITY",
      "A reconciliation record exists for an Effect that is not reconciliation-required.",
    );
  }
}

export class PostgresEffectLedger {
  constructor(private readonly pool: Pool) {}

  async planEffect(input: PlanEffectInput): Promise<PlanEffectResult> {
    const id = parseEffectId(input.id);
    const executionId = parseExecutionId(input.executionId);
    const stageExecutionId = parseStageExecutionId(input.stageExecutionId);
    validateEffectKey(input.effectKey);
    const intentDigest = effectIntentDigest(input.intent);

    try {
      return await withTransaction(this.pool, async (client) => {
        const stageResult = await client.query<StageOwnerRow>(
          `SELECT execution_id
           FROM stage_executions
           WHERE id = $1`,
          [stageExecutionId],
        );
        const stage = stageResult.rows[0];
        if (stage === undefined) {
          throw new EffectLedgerError(
            "NOT_FOUND",
            `StageExecution ${stageExecutionId} does not exist.`,
          );
        }
        if (stage.execution_id !== executionId) {
          throw new EffectLedgerError(
            "KEY_CONFLICT",
            "Effect executionId does not match the owning StageExecution.",
          );
        }

        const inserted = await client.query<EffectRow>(
          `INSERT INTO effects (
             id, execution_id, stage_execution_id, effect_key, intent_digest, state
           )
           VALUES ($1, $2, $3, $4, $5, 'PLANNED')
           ON CONFLICT (execution_id, effect_key) DO NOTHING
           RETURNING ${EFFECT_COLUMNS}`,
          [id, executionId, stageExecutionId, input.effectKey, intentDigest],
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow !== undefined) {
          return Object.freeze({ effect: mapEffect(insertedRow), created: true });
        }

        const existingResult = await client.query<EffectRow>(
          `SELECT ${EFFECT_COLUMNS}
           FROM effects
           WHERE execution_id = $1 AND effect_key = $2
           FOR UPDATE`,
          [executionId, input.effectKey],
        );
        const existingRow = existingResult.rows[0];
        if (existingRow === undefined) {
          throw new EffectLedgerError(
            "INTEGRITY",
            "Effect uniqueness arbitration completed without a stored Effect.",
          );
        }
        if (
          existingRow.stage_execution_id !== stageExecutionId ||
          existingRow.intent_digest !== intentDigest
        ) {
          throw new EffectLedgerError(
            "KEY_CONFLICT",
            "effectKey already identifies a different Stage or canonical intent.",
          );
        }
        return Object.freeze({ effect: mapEffect(existingRow), created: false });
      });
    } catch (error) {
      return translateEffectError(error, "plan Effect");
    }
  }

  async getEffect(effectId: EffectId): Promise<EffectSnapshot | null> {
    const id = parseEffectId(effectId);
    try {
      const effectResult = await this.pool.query<EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM effects
         WHERE id = $1`,
        [id],
      );
      const row = effectResult.rows[0];
      if (row === undefined) return null;
      const effect = mapEffect(row);
      const reconciliationResult = await this.pool.query<ReconciliationRow>(
        `SELECT effect_id, decision, reconciled_by, external_reference, reconciled_at
         FROM effect_reconciliations
         WHERE effect_id = $1`,
        [id],
      );
      const reconciliationRow = reconciliationResult.rows[0];
      const reconciliation =
        reconciliationRow === undefined ? null : mapReconciliation(reconciliationRow);
      validateStoredReconciliation(effect, reconciliation);
      return Object.freeze({ effect, reconciliation });
    } catch (error) {
      return translateEffectError(error, "read Effect");
    }
  }

  async claimEffect(effectId: EffectId): Promise<EffectClaimResult> {
    const id = parseEffectId(effectId);
    try {
      return await withTransaction(this.pool, async (client) => {
        const effect = mapEffect(await getEffectForUpdate(client, id));
        const reconciliationRow = await getReconciliation(client, id);
        const reconciliation = reconciliationRow === null ? null : mapReconciliation(reconciliationRow);
        validateStoredReconciliation(effect, reconciliation);

        if (effect.state === "SUCCEEDED") {
          return Object.freeze({
            disposition: "SUPPRESSED_SUCCEEDED" as const,
            snapshot: Object.freeze({ effect, reconciliation }),
          });
        }
        if (effect.state === "FAILED") {
          throw new EffectLedgerError(
            "KNOWN_FAILED",
            "Known failed Effect is terminal; PR5 does not authorize automatic replay.",
          );
        }
        if (effect.state === "RECONCILIATION_REQUIRED") {
          if (reconciliation?.decision === "CONFIRMED_SUCCEEDED") {
            return Object.freeze({
              disposition: "SUPPRESSED_SUCCEEDED" as const,
              snapshot: Object.freeze({ effect, reconciliation }),
            });
          }
          if (reconciliation?.decision === "CONFIRMED_FAILED") {
            throw new EffectLedgerError(
              "KNOWN_FAILED",
              "Reconciliation confirmed failure; automatic replay remains unauthorized.",
            );
          }
          throw new EffectLedgerError(
            "RECONCILIATION_REQUIRED",
            "Ambiguous Effect must be reconciled before any retry decision.",
          );
        }
        if (effect.state === "CLAIMED") {
          throw new EffectLedgerError("IN_FLIGHT", "Effect is already claimed for execution.");
        }

        const transition = transitionEffect(effect.state, "CLAIM");
        const updated = await client.query<EffectRow>(
          `UPDATE effects
           SET state = $2,
               claimed_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE id = $1 AND state = $3
           RETURNING ${EFFECT_COLUMNS}`,
          [id, transition.to, transition.from],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) {
          throw new EffectLedgerError("STALE_STATE", "Effect claim lost state authority.");
        }
        const claimed = mapEffect(updatedRow);
        return Object.freeze({
          disposition: "CLAIMED" as const,
          snapshot: Object.freeze({ effect: claimed, reconciliation: null }),
        });
      });
    } catch (error) {
      return translateEffectError(error, "claim Effect");
    }
  }

  async completeEffect(
    effectId: EffectId,
    input: CompleteEffectInput,
  ): Promise<EffectSnapshot> {
    const id = parseEffectId(effectId);
    if (
      input.outcome !== "SUCCEEDED" &&
      input.outcome !== "FAILED" &&
      input.outcome !== "AMBIGUOUS"
    ) {
      throw new EffectLedgerError("INVALID_INPUT", "Unknown Effect completion outcome.");
    }
    validateBoundedText(input.resolutionCode, "resolutionCode", MAX_CODE_LENGTH);
    const externalReference = validateOptionalMetadata(
      input.externalReference,
      "externalReference",
    );
    const event: EffectEvent =
      input.outcome === "SUCCEEDED"
        ? "SUCCEED"
        : input.outcome === "FAILED"
          ? "FAIL"
          : "REQUIRE_RECONCILIATION";

    try {
      return await withTransaction(this.pool, async (client) => {
        const effect = mapEffect(await getEffectForUpdate(client, id));
        if (effect.state !== "CLAIMED") {
          throw new EffectLedgerError(
            "STALE_STATE",
            `Only a CLAIMED Effect can complete; stored state is ${effect.state}.`,
          );
        }
        const transition = transitionEffect(effect.state, event);
        const updated = await client.query<EffectRow>(
          `UPDATE effects
           SET state = $2,
               resolved_at = clock_timestamp(),
               resolution_code = $3,
               external_reference = $4,
               updated_at = clock_timestamp()
           WHERE id = $1 AND state = $5
           RETURNING ${EFFECT_COLUMNS}`,
          [id, transition.to, input.resolutionCode, externalReference, transition.from],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) {
          throw new EffectLedgerError("STALE_STATE", "Effect completion lost state authority.");
        }
        return Object.freeze({ effect: mapEffect(updatedRow), reconciliation: null });
      });
    } catch (error) {
      return translateEffectError(error, "complete Effect");
    }
  }

  async reconcileEffect(
    effectId: EffectId,
    input: ReconcileEffectInput,
  ): Promise<ReconcileEffectResult> {
    const id = parseEffectId(effectId);
    if (
      input.decision !== "CONFIRMED_SUCCEEDED" &&
      input.decision !== "CONFIRMED_FAILED"
    ) {
      throw new EffectLedgerError("INVALID_INPUT", "Unknown Effect reconciliation decision.");
    }
    validateBoundedText(input.reconciledBy, "reconciledBy", MAX_CODE_LENGTH);
    const externalReference = validateOptionalMetadata(
      input.externalReference,
      "externalReference",
    );

    try {
      return await withTransaction(this.pool, async (client) => {
        const effect = mapEffect(await getEffectForUpdate(client, id));
        if (effect.state !== "RECONCILIATION_REQUIRED") {
          throw new EffectLedgerError(
            "STALE_STATE",
            `Only a RECONCILIATION_REQUIRED Effect can be reconciled; stored state is ${effect.state}.`,
          );
        }
        const existingRow = await getReconciliation(client, id);
        if (existingRow !== null) {
          const existing = mapReconciliation(existingRow);
          if (
            existing.decision === input.decision &&
            existing.reconciledBy === input.reconciledBy &&
            existing.externalReference === externalReference
          ) {
            return Object.freeze({ reconciliation: existing, created: false });
          }
          throw new EffectLedgerError(
            "CONFLICT",
            "Effect already has a different immutable reconciliation decision.",
          );
        }

        const inserted = await client.query<ReconciliationRow>(
          `INSERT INTO effect_reconciliations (
             effect_id, decision, reconciled_by, external_reference
           )
           VALUES ($1, $2, $3, $4)
           RETURNING effect_id, decision, reconciled_by, external_reference, reconciled_at`,
          [id, input.decision, input.reconciledBy, externalReference],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new EffectLedgerError("INTEGRITY", "Reconciliation insert returned no row.");
        }
        return Object.freeze({ reconciliation: mapReconciliation(row), created: true });
      });
    } catch (error) {
      return translateEffectError(error, "reconcile Effect");
    }
  }
}
