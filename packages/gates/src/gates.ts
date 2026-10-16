import {
  GATE_STATES,
  STAGE_EXECUTION_STATES,
  parseExecutionId,
  parseGateId,
  parseStageExecutionId,
  validateFlowDefinition,
  type ExecutionId,
  type GateId,
  type GateState,
  type JsonObject,
  type JsonValue,
  type StageExecutionId,
  type StageExecutionState,
} from "@aegisflow/contracts";
import {
  GateDecisionConflictError,
  transitionGate,
  transitionStageExecution,
  type GateEvent,
} from "@aegisflow/core";
import { withTransaction } from "@aegisflow/persistence";
import type { Pool, PoolClient } from "pg";
import { GateLedgerError } from "./errors.js";

const MAX_ACTOR_ID_LENGTH = 128;
const MAX_EVIDENCE_DEPTH = 32;
const MAX_EVIDENCE_ITEMS = 1_024;
const MAX_EVIDENCE_STRING_LENGTH = 65_536;
const MAX_EVIDENCE_BYTES = 1_048_576;
const MAX_SWEEP_LIMIT = 1_000;

export type GateResolutionOutcome = Exclude<GateState, "WAITING">;
export type HumanGateEvent = Exclude<GateEvent, "EXPIRE">;

export interface DurableGateRecord {
  readonly id: GateId;
  readonly executionId: ExecutionId;
  readonly stageExecutionId: StageExecutionId;
  readonly state: GateState;
  readonly expiresAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GateResolutionRecord {
  readonly gateId: GateId;
  readonly outcome: GateResolutionOutcome;
  readonly actorId: string | null;
  readonly evidence: JsonObject;
  readonly resolvedAt: Date;
}

export interface GateSnapshot {
  readonly gate: DurableGateRecord;
  readonly resolution: GateResolutionRecord | null;
  readonly protectedStageExecutionIds: readonly StageExecutionId[];
}

export interface CreateGateInput {
  readonly id: GateId;
  readonly executionId: ExecutionId;
  readonly stageExecutionId: StageExecutionId;
}

export interface CreateGateResult {
  readonly snapshot: GateSnapshot;
  readonly created: boolean;
}

export interface ResolveGateInput {
  readonly event: HumanGateEvent;
  readonly actorId: string;
  readonly evidence?: JsonObject;
}

export interface ResolveGateResult {
  readonly snapshot: GateSnapshot;
  readonly changed: boolean;
}

export interface ExpireGateResult {
  readonly snapshot: GateSnapshot;
  readonly changed: boolean;
}

export interface GateBlocker {
  readonly gateId: GateId;
  readonly state: GateState;
  readonly expiresAt: Date | null;
}

export interface StageGateAuthorization {
  readonly stageExecutionId: StageExecutionId;
  readonly allowed: boolean;
  readonly blockers: readonly GateBlocker[];
}

interface GateRow {
  readonly id: string;
  readonly execution_id: string;
  readonly stage_execution_id: string;
  readonly state: string;
  readonly expires_at: Date | null;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface GateRowWithDue extends GateRow {
  readonly due: boolean;
}

interface ResolutionRow {
  readonly gate_id: string;
  readonly outcome: string;
  readonly actor_id: string | null;
  readonly evidence: unknown;
  readonly resolved_at: Date;
}

interface StageContextRow {
  readonly id: string;
  readonly stage_id: string;
  readonly state: string;
  readonly definition: unknown;
}

interface ProtectedRow {
  readonly protected_stage_execution_id: string;
}

interface BlockerRow {
  readonly gate_id: string;
  readonly state: string;
  readonly expires_at: Date | null;
}

const GATE_COLUMNS = `id, execution_id, stage_execution_id, state,
  expires_at, resolved_at, created_at, updated_at`;

function validateActorId(actorId: string): void {
  if (
    typeof actorId !== "string" ||
    actorId.length < 1 ||
    actorId.length > MAX_ACTOR_ID_LENGTH ||
    actorId.trim() !== actorId ||
    /[\u0000\r\n]/u.test(actorId)
  ) {
    throw new GateLedgerError(
      "INVALID_INPUT",
      `actorId must be a trimmed 1-${MAX_ACTOR_ID_LENGTH} character single-line string.`,
    );
  }
}

function validateJson(value: unknown, depth: number): void {
  if (depth > MAX_EVIDENCE_DEPTH) {
    throw new GateLedgerError("INVALID_INPUT", "Gate evidence exceeds maximum nesting depth.");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_EVIDENCE_STRING_LENGTH) {
      throw new GateLedgerError("INVALID_INPUT", "Gate evidence contains an oversized string.");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GateLedgerError("INVALID_INPUT", "Gate evidence contains a non-finite number.");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_EVIDENCE_ITEMS) {
      throw new GateLedgerError("INVALID_INPUT", "Gate evidence array is too large.");
    }
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new GateLedgerError("INVALID_INPUT", "Gate evidence must contain only JSON objects.");
    }
    const entries = Object.entries(value as Readonly<Record<string, unknown>>);
    if (entries.length > MAX_EVIDENCE_ITEMS) {
      throw new GateLedgerError("INVALID_INPUT", "Gate evidence object has too many keys.");
    }
    for (const [key, child] of entries) {
      if (key.length < 1 || key.length > 256) {
        throw new GateLedgerError("INVALID_INPUT", "Gate evidence contains an invalid key.");
      }
      validateJson(child, depth + 1);
    }
    return;
  }
  throw new GateLedgerError("INVALID_INPUT", "Gate evidence contains a non-JSON value.");
}

function normalizeEvidence(value: unknown): JsonObject {
  const candidate = value === undefined ? {} : value;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new GateLedgerError("INVALID_INPUT", "Gate evidence must be a JSON object.");
  }
  validateJson(candidate, 0);
  const encoded = JSON.stringify(candidate);
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVIDENCE_BYTES) {
    throw new GateLedgerError("INVALID_INPUT", "Gate evidence exceeds 1 MiB.");
  }
  return JSON.parse(encoded) as JsonObject;
}

function parseGateState(value: unknown): GateState {
  if (typeof value !== "string" || !GATE_STATES.includes(value as GateState)) {
    throw new GateLedgerError("INTEGRITY", "Stored Gate state is invalid.");
  }
  return value as GateState;
}

function parseStageState(value: unknown): StageExecutionState {
  if (
    typeof value !== "string" ||
    !STAGE_EXECUTION_STATES.includes(value as StageExecutionState)
  ) {
    throw new GateLedgerError("INTEGRITY", "Stored StageExecution state is invalid.");
  }
  return value as StageExecutionState;
}

function parseResolutionOutcome(value: unknown): GateResolutionOutcome {
  if (value === "APPROVED" || value === "REJECTED" || value === "EXPIRED") return value;
  throw new GateLedgerError("INTEGRITY", "Stored Gate resolution outcome is invalid.");
}

function mapGate(row: GateRow): DurableGateRecord {
  return Object.freeze({
    id: parseGateId(row.id),
    executionId: parseExecutionId(row.execution_id),
    stageExecutionId: parseStageExecutionId(row.stage_execution_id),
    state: parseGateState(row.state),
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapResolution(row: ResolutionRow): GateResolutionRecord {
  return Object.freeze({
    gateId: parseGateId(row.gate_id),
    outcome: parseResolutionOutcome(row.outcome),
    actorId: row.actor_id,
    evidence: normalizeEvidence(row.evidence),
    resolvedAt: row.resolved_at,
  });
}

function translateGateError(error: unknown, context: string): never {
  if (error instanceof GateLedgerError) throw error;
  if (error instanceof GateDecisionConflictError) {
    throw new GateLedgerError("DECISION_CONFLICT", `${context}: Gate decision conflicts with the durable terminal state.`, {
      cause: error,
    });
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "23505") {
      throw new GateLedgerError("CONFLICT", `${context}: uniqueness conflict.`, { cause: error });
    }
    if (code === "23503" || code === "23514" || code === "22P02") {
      throw new GateLedgerError("INTEGRITY", `${context}: database integrity violation.`, {
        cause: error,
      });
    }
  }
  throw new GateLedgerError("TRANSACTION", `${context}: PostgreSQL operation failed.`, {
    cause: error,
  });
}

async function getGateForUpdate(client: PoolClient, gateId: GateId): Promise<GateRowWithDue> {
  const result = await client.query<GateRowWithDue>(
    `SELECT ${GATE_COLUMNS},
            (expires_at IS NOT NULL AND expires_at <= clock_timestamp()) AS due
     FROM gates
     WHERE id = $1
     FOR UPDATE`,
    [gateId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new GateLedgerError("NOT_FOUND", `Gate ${gateId} does not exist.`);
  }
  return row;
}

async function getResolution(client: PoolClient, gateId: GateId): Promise<ResolutionRow | null> {
  const result = await client.query<ResolutionRow>(
    `SELECT gate_id, outcome, actor_id, evidence, resolved_at
     FROM gate_resolutions
     WHERE gate_id = $1`,
    [gateId],
  );
  return result.rows[0] ?? null;
}

async function getProtectedIds(
  client: PoolClient,
  gateId: GateId,
): Promise<readonly StageExecutionId[]> {
  const result = await client.query<ProtectedRow>(
    `SELECT protected_stage_execution_id
     FROM gate_protections
     WHERE gate_id = $1
     ORDER BY protected_stage_execution_id`,
    [gateId],
  );
  return Object.freeze(result.rows.map((row) => parseStageExecutionId(row.protected_stage_execution_id)));
}

async function validateStageAlignment(
  client: PoolClient,
  gate: DurableGateRecord,
): Promise<void> {
  const result = await client.query<{ state: string }>(
    `SELECT state FROM stage_executions WHERE id = $1`,
    [gate.stageExecutionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new GateLedgerError("INTEGRITY", "Gate StageExecution is missing.");
  }
  const stageState = parseStageState(row.state);
  const expected =
    gate.state === "WAITING" ? "WAITING" : gate.state === "APPROVED" ? "SUCCEEDED" : "FAILED";
  if (stageState !== expected) {
    throw new GateLedgerError(
      "INTEGRITY",
      `Gate state ${gate.state} is inconsistent with StageExecution state ${stageState}.`,
    );
  }
}

async function buildSnapshot(client: PoolClient, gate: DurableGateRecord): Promise<GateSnapshot> {
  const resolutionRow = await getResolution(client, gate.id);
  const resolution = resolutionRow === null ? null : mapResolution(resolutionRow);
  if (gate.state === "WAITING" && resolution !== null) {
    throw new GateLedgerError("INTEGRITY", "A WAITING Gate has terminal resolution evidence.");
  }
  if (gate.state !== "WAITING" && (resolution === null || resolution.outcome !== gate.state)) {
    throw new GateLedgerError("INTEGRITY", "Terminal Gate state lacks matching immutable resolution evidence.");
  }
  await validateStageAlignment(client, gate);
  return Object.freeze({
    gate,
    resolution,
    protectedStageExecutionIds: await getProtectedIds(client, gate.id),
  });
}

async function applyResolution(
  client: PoolClient,
  gateRow: GateRowWithDue,
  event: GateEvent,
  actorId: string | null,
  evidence: JsonObject,
): Promise<ResolveGateResult> {
  const gate = mapGate(gateRow);
  const transition = transitionGate(gate.state, event);
  if (!transition.changed) {
    return Object.freeze({ snapshot: await buildSnapshot(client, gate), changed: false });
  }

  const stageResult = await client.query<{ state: string }>(
    `SELECT state FROM stage_executions WHERE id = $1 FOR UPDATE`,
    [gate.stageExecutionId],
  );
  const stageRow = stageResult.rows[0];
  if (stageRow === undefined) {
    throw new GateLedgerError("INTEGRITY", "Gate StageExecution is missing during resolution.");
  }
  const stageState = parseStageState(stageRow.state);
  if (stageState !== "WAITING") {
    throw new GateLedgerError(
      "INTEGRITY",
      `Gate resolution requires StageExecution WAITING, found ${stageState}.`,
    );
  }

  let terminalStageState: StageExecutionState;
  if (transition.to === "APPROVED") {
    const resumed = transitionStageExecution(stageState, "RESUME");
    terminalStageState = transitionStageExecution(resumed.to, "SUCCEED").to;
  } else {
    terminalStageState = transitionStageExecution(stageState, "FAIL").to;
  }

  await client.query(
    `UPDATE stage_executions
     SET state = $2
     WHERE id = $1`,
    [gate.stageExecutionId, terminalStageState],
  );
  const updatedGateResult = await client.query<GateRow>(
    `UPDATE gates
     SET state = $2,
         resolved_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE id = $1 AND state = $3
     RETURNING ${GATE_COLUMNS}`,
    [gate.id, transition.to, transition.from],
  );
  const updatedGateRow = updatedGateResult.rows[0];
  if (updatedGateRow === undefined) {
    throw new GateLedgerError("STALE_STATE", "Gate state changed while resolving.");
  }

  await client.query(
    `INSERT INTO gate_resolutions (gate_id, outcome, actor_id, evidence)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [gate.id, transition.to, actorId, JSON.stringify(evidence)],
  );
  const updatedGate = mapGate(updatedGateRow);
  return Object.freeze({ snapshot: await buildSnapshot(client, updatedGate), changed: true });
}

export class PostgresGateLedger {
  constructor(private readonly pool: Pool) {}

  async createGate(input: CreateGateInput): Promise<CreateGateResult> {
    const id = parseGateId(input.id);
    const executionId = parseExecutionId(input.executionId);
    const stageExecutionId = parseStageExecutionId(input.stageExecutionId);

    try {
      return await withTransaction(this.pool, async (client) => {
        const stageRowsResult = await client.query<StageContextRow>(
          `SELECT se.id, se.stage_id, se.state, fv.definition
           FROM stage_executions se
           JOIN executions e ON e.id = se.execution_id
           JOIN flow_versions fv ON fv.id = e.flow_version_id
           WHERE se.execution_id = $1
           ORDER BY se.id
           FOR UPDATE OF se`,
          [executionId],
        );
        if (stageRowsResult.rows.length === 0) {
          throw new GateLedgerError("NOT_FOUND", `Execution ${executionId} has no materialized stages.`);
        }
        const gateStageRow = stageRowsResult.rows.find((row) => row.id === stageExecutionId);
        if (gateStageRow === undefined) {
          throw new GateLedgerError(
            "KEY_CONFLICT",
            "Gate executionId does not own the requested StageExecution.",
          );
        }

        let definition;
        try {
          definition = validateFlowDefinition(stageRowsResult.rows[0]?.definition);
        } catch (error) {
          throw new GateLedgerError("INTEGRITY", "Stored FlowVersion definition is invalid.", {
            cause: error,
          });
        }
        const gateDefinition = definition.stages.find((stage) => stage.id === gateStageRow.stage_id);
        if (gateDefinition === undefined || gateDefinition.type !== "gate") {
          throw new GateLedgerError(
            "NOT_GATE_STAGE",
            `StageExecution ${stageExecutionId} does not materialize a Gate stage.`,
          );
        }

        const existingResult = await client.query<GateRow>(
          `SELECT ${GATE_COLUMNS}
           FROM gates
           WHERE stage_execution_id = $1
           FOR UPDATE`,
          [stageExecutionId],
        );
        const existingRow = existingResult.rows[0];
        if (existingRow !== undefined) {
          const existing = mapGate(existingRow);
          if (existing.id !== id || existing.executionId !== executionId) {
            throw new GateLedgerError(
              "KEY_CONFLICT",
              "Gate StageExecution is already bound to a different durable Gate identity.",
            );
          }
          return Object.freeze({ snapshot: await buildSnapshot(client, existing), created: false });
        }

        const gateStageState = parseStageState(gateStageRow.state);
        if (gateStageState !== "READY") {
          throw new GateLedgerError(
            "STALE_STATE",
            `New Gate requires StageExecution READY, found ${gateStageState}.`,
          );
        }

        const protectedLogicalIds = definition.stages
          .filter((stage) => stage.dependsOn.includes(gateDefinition.id))
          .map((stage) => stage.id)
          .sort();
        const rowsByStageId = new Map(stageRowsResult.rows.map((row) => [row.stage_id, row]));
        const protectedRows = protectedLogicalIds.map((stageId) => {
          const row = rowsByStageId.get(stageId);
          if (row === undefined) {
            throw new GateLedgerError(
              "INTEGRITY",
              `Dependent Stage '${stageId}' is missing its StageExecution.`,
            );
          }
          const state = parseStageState(row.state);
          if (state !== "BLOCKED" && state !== "READY") {
            throw new GateLedgerError(
              "STALE_STATE",
              `Protected StageExecution ${row.id} already entered ${state}.`,
            );
          }
          return row;
        });

        const started = transitionStageExecution(gateStageState, "START");
        const waiting = transitionStageExecution(started.to, "WAIT");
        await client.query(
          `UPDATE stage_executions SET state = $2 WHERE id = $1`,
          [stageExecutionId, waiting.to],
        );

        const expiresAfterMs = gateDefinition.expiresAfterMs ?? null;
        const gateInsert = await client.query<GateRow>(
          `INSERT INTO gates (
             id, execution_id, stage_execution_id, state, expires_at
           )
           VALUES (
             $1, $2, $3, 'WAITING',
             CASE
               WHEN $4::bigint IS NULL THEN NULL
               ELSE clock_timestamp() + ($4::bigint * interval '1 millisecond')
             END
           )
           RETURNING ${GATE_COLUMNS}`,
          [id, executionId, stageExecutionId, expiresAfterMs],
        );
        const insertedRow = gateInsert.rows[0];
        if (insertedRow === undefined) {
          throw new GateLedgerError("INTEGRITY", "Gate insert returned no durable record.");
        }

        for (const protectedRow of protectedRows) {
          await client.query(
            `INSERT INTO gate_protections (
               gate_id, execution_id, protected_stage_execution_id
             ) VALUES ($1, $2, $3)`,
            [id, executionId, protectedRow.id],
          );
        }

        const gate = mapGate(insertedRow);
        return Object.freeze({ snapshot: await buildSnapshot(client, gate), created: true });
      });
    } catch (error) {
      return translateGateError(error, "create Gate");
    }
  }

  async getGate(gateId: GateId): Promise<GateSnapshot | null> {
    const id = parseGateId(gateId);
    try {
      return await withTransaction(this.pool, async (client) => {
        const result = await client.query<GateRow>(
          `SELECT ${GATE_COLUMNS} FROM gates WHERE id = $1`,
          [id],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        return buildSnapshot(client, mapGate(row));
      });
    } catch (error) {
      return translateGateError(error, "read Gate");
    }
  }

  async resolveGate(gateId: GateId, input: ResolveGateInput): Promise<ResolveGateResult> {
    const id = parseGateId(gateId);
    if (input.event !== "APPROVE" && input.event !== "REJECT") {
      throw new GateLedgerError("INVALID_INPUT", "Human Gate event must be APPROVE or REJECT.");
    }
    validateActorId(input.actorId);
    const evidence = normalizeEvidence(input.evidence);

    try {
      const transactionResult = await withTransaction(this.pool, async (client) => {
        let row = await getGateForUpdate(client, id);
        if (parseGateState(row.state) === "WAITING" && row.due) {
          await applyResolution(client, row, "EXPIRE", null, { reason: "deadline" });
          return Object.freeze({ expiredBeforeDecision: true as const });
        }
        const result = await applyResolution(client, row, input.event, input.actorId, evidence);
        return Object.freeze({ expiredBeforeDecision: false as const, result });
      });
      if (transactionResult.expiredBeforeDecision) {
        throw new GateLedgerError(
          "DECISION_CONFLICT",
          "Gate deadline elapsed before the human decision; the Gate is durably EXPIRED.",
        );
      }
      return transactionResult.result;
    } catch (error) {
      return translateGateError(error, "resolve Gate");
    }
  }

  async expireGateIfDue(gateId: GateId): Promise<ExpireGateResult> {
    const id = parseGateId(gateId);
    try {
      return await withTransaction(this.pool, async (client) => {
        const row = await getGateForUpdate(client, id);
        const state = parseGateState(row.state);
        if (state !== "WAITING" || !row.due) {
          return Object.freeze({ snapshot: await buildSnapshot(client, mapGate(row)), changed: false });
        }
        return applyResolution(client, row, "EXPIRE", null, { reason: "deadline" });
      });
    } catch (error) {
      return translateGateError(error, "expire Gate");
    }
  }

  async expireDueGates(limit = 100): Promise<readonly GateSnapshot[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SWEEP_LIMIT) {
      throw new GateLedgerError(
        "INVALID_INPUT",
        `limit must be an integer between 1 and ${MAX_SWEEP_LIMIT}.`,
      );
    }
    try {
      const due = await this.pool.query<{ id: string }>(
        `SELECT id
         FROM gates
         WHERE state = 'WAITING'
           AND expires_at IS NOT NULL
           AND expires_at <= clock_timestamp()
         ORDER BY expires_at, id
         LIMIT $1`,
        [limit],
      );
      const expired: GateSnapshot[] = [];
      for (const row of due.rows) {
        const result = await this.expireGateIfDue(parseGateId(row.id));
        if (result.changed) expired.push(result.snapshot);
      }
      return Object.freeze(expired);
    } catch (error) {
      return translateGateError(error, "sweep due Gates");
    }
  }

  async getStageGateAuthorization(
    stageExecutionId: StageExecutionId,
  ): Promise<StageGateAuthorization> {
    const id = parseStageExecutionId(stageExecutionId);
    try {
      const stage = await this.pool.query<{ id: string }>(
        `SELECT id FROM stage_executions WHERE id = $1`,
        [id],
      );
      if (stage.rows[0] === undefined) {
        throw new GateLedgerError("NOT_FOUND", `StageExecution ${id} does not exist.`);
      }
      const result = await this.pool.query<BlockerRow>(
        `SELECT g.id AS gate_id, g.state, g.expires_at
         FROM gate_protections gp
         JOIN gates g ON g.id = gp.gate_id
         WHERE gp.protected_stage_execution_id = $1
           AND g.state <> 'APPROVED'
         ORDER BY g.id`,
        [id],
      );
      const blockers = Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            gateId: parseGateId(row.gate_id),
            state: parseGateState(row.state),
            expiresAt: row.expires_at,
          }),
        ),
      );
      return Object.freeze({ stageExecutionId: id, allowed: blockers.length === 0, blockers });
    } catch (error) {
      return translateGateError(error, "read Gate authorization");
    }
  }

  async assertStageGateAuthorized(stageExecutionId: StageExecutionId): Promise<void> {
    const authorization = await this.getStageGateAuthorization(stageExecutionId);
    if (!authorization.allowed) {
      throw new GateLedgerError(
        "PROTECTED",
        `StageExecution ${authorization.stageExecutionId} is blocked by Gate(s): ${authorization.blockers
          .map((blocker) => `${blocker.gateId}:${blocker.state}`)
          .join(", ")}.`,
      );
    }
  }
}
