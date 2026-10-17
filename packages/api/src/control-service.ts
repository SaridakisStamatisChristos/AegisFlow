import {
  EXECUTION_STATES,
  STAGE_EXECUTION_STATES,
  isJsonValue,
  parseEffectId,
  parseEvidenceId,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseGateId,
  parseSignalId,
  parseStageExecutionId,
  validateFlowDefinition,
  type ExecutionId,
  type ExecutionState,
  type FlowDefinition,
  type FlowId,
  type FlowVersionId,
  type GateState,
  type JsonObject,
  type SignalId,
  type StageExecutionState,
} from "@aegisflow/contracts";
import {
  isTerminalExecutionState,
  isTerminalStageExecutionState,
  transitionAttempt,
  transitionExecution,
  transitionStageExecution,
} from "@aegisflow/core";
import { PostgresEffectLedger } from "@aegisflow/effects";
import { PostgresGateLedger } from "@aegisflow/gates";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ControlApiError } from "./errors.js";

const MAX_IDEMPOTENCY_KEY = 200;
const MAX_SIGNAL_NAME = 128;
const MAX_PAYLOAD_BYTES = 1_048_576;
const SIGNAL_NAME = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;

export interface FlowView {
  readonly flow: {
    readonly id: FlowId;
    readonly name: string;
    readonly description: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  readonly versions: readonly {
    readonly id: FlowVersionId;
    readonly version: number;
    readonly definition: FlowDefinition;
    readonly createdAt: Date;
  }[];
}

export interface RegisteredFlow {
  readonly flow: {
    readonly id: FlowId;
    readonly name: string;
    readonly description: string | null;
  };
  readonly version: {
    readonly id: FlowVersionId;
    readonly version: number;
    readonly definition: FlowDefinition;
  };
  readonly created: boolean;
}

export interface StartExecutionInput {
  readonly flowId: FlowId;
  readonly flowVersionId?: FlowVersionId;
  readonly idempotencyKey: string;
}

export interface ExecutionView {
  readonly execution: {
    readonly id: ExecutionId;
    readonly flowId: FlowId;
    readonly flowVersionId: FlowVersionId;
    readonly state: ExecutionState;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  readonly stages: readonly {
    readonly id: ReturnType<typeof parseStageExecutionId>;
    readonly stageId: string;
    readonly state: StageExecutionState;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  }[];
}

export interface StartExecutionResult extends ExecutionView {
  readonly replayed: boolean;
}

export interface ExecutionEventView {
  readonly position: string;
  readonly id: ReturnType<typeof parseEvidenceId>;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly createdAt: Date;
}

export interface EffectView {
  readonly id: ReturnType<typeof parseEffectId>;
  readonly stageExecutionId: ReturnType<typeof parseStageExecutionId>;
  readonly effectKey: string;
  readonly state: string;
  readonly resolutionCode: string | null;
  readonly externalReference: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly reconciliation: null | {
    readonly decision: string;
    readonly reconciledBy: string;
    readonly externalReference: string | null;
    readonly reconciledAt: Date;
  };
}

export interface GateView {
  readonly id: ReturnType<typeof parseGateId>;
  readonly stageExecutionId: ReturnType<typeof parseStageExecutionId>;
  readonly state: GateState;
  readonly expiresAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SignalView {
  readonly id: SignalId;
  readonly executionId: ExecutionId;
  readonly signalName: string;
  readonly idempotencyKey: string;
  readonly payload: JsonObject;
  readonly createdAt: Date;
}

export interface SendSignalResult {
  readonly signal: SignalView;
  readonly replayed: boolean;
  readonly resumedStageExecutionIds: readonly ReturnType<typeof parseStageExecutionId>[];
}

interface ExecutionRow {
  readonly id: string;
  readonly flow_id: string;
  readonly flow_version_id: string;
  readonly state: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface StageRow {
  readonly id: string;
  readonly stage_id: string;
  readonly state: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SignalRow {
  readonly id: string;
  readonly execution_id: string;
  readonly signal_name: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly payload: unknown;
  readonly created_at: Date;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function validateIdempotencyKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_IDEMPOTENCY_KEY ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ControlApiError(
      "INVALID_INPUT",
      `Idempotency-Key must be a trimmed 1-${MAX_IDEMPOTENCY_KEY} character string without control characters.`,
    );
  }
  return value;
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !isJsonValue(value)) {
    throw new ControlApiError("INVALID_INPUT", `${label} must be a finite JSON object.`);
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new ControlApiError("INVALID_INPUT", `${label} exceeds 1 MiB.`);
  }
  return JSON.parse(encoded) as JsonObject;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ControlApiError("INVALID_INPUT", "Non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new ControlApiError("INVALID_INPUT", "Value is not JSON-compatible.");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseExecutionState(value: unknown): ExecutionState {
  if (typeof value !== "string" || !EXECUTION_STATES.includes(value as ExecutionState)) {
    throw new ControlApiError("INTEGRITY", "Stored Execution state is invalid.");
  }
  return value as ExecutionState;
}

function parseStageState(value: unknown): StageExecutionState {
  if (
    typeof value !== "string" ||
    !STAGE_EXECUTION_STATES.includes(value as StageExecutionState)
  ) {
    throw new ControlApiError("INTEGRITY", "Stored StageExecution state is invalid.");
  }
  return value as StageExecutionState;
}

function mapExecution(row: ExecutionRow): ExecutionView["execution"] {
  return Object.freeze({
    id: parseExecutionId(row.id),
    flowId: parseFlowId(row.flow_id),
    flowVersionId: parseFlowVersionId(row.flow_version_id),
    state: parseExecutionState(row.state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapStage(row: StageRow): ExecutionView["stages"][number] {
  return Object.freeze({
    id: parseStageExecutionId(row.id),
    stageId: row.stage_id,
    state: parseStageState(row.state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapSignal(row: SignalRow): SignalView {
  return Object.freeze({
    id: parseSignalId(row.id),
    executionId: parseExecutionId(row.execution_id),
    signalName: row.signal_name,
    idempotencyKey: row.idempotency_key,
    payload: requireJsonObject(row.payload, "Stored Signal payload"),
    createdAt: row.created_at,
  });
}

async function lockKey(client: PoolClient, scope: string, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${scope}:${key}`]);
}

async function appendEvent(
  client: PoolClient,
  executionId: ExecutionId,
  eventType: string,
  payload: JsonObject,
): Promise<void> {
  await client.query(
    `INSERT INTO execution_events (id, execution_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [opaqueId("evidence"), executionId, eventType, JSON.stringify(payload)],
  );
}

function translateDatabaseError(error: unknown, context: string): never {
  if (error instanceof ControlApiError) throw error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "23505") {
      throw new ControlApiError("CONFLICT", `${context}: uniqueness conflict.`, { cause: error });
    }
    if (code === "23503" || code === "23514" || code === "22P02") {
      throw new ControlApiError("INTEGRITY", `${context}: database integrity violation.`, {
        cause: error,
      });
    }
  }
  throw new ControlApiError("TRANSACTION", `${context}: PostgreSQL operation failed.`, {
    cause: error,
  });
}

export class PostgresControlService {
  readonly effects: PostgresEffectLedger;
  readonly gates: PostgresGateLedger;

  constructor(readonly pool: Pool) {
    this.effects = new PostgresEffectLedger(pool);
    this.gates = new PostgresGateLedger(pool);
  }

  async registerFlow(input: unknown): Promise<RegisteredFlow> {
    const definition = validateFlowDefinition(input);
    const definitionText = JSON.stringify(definition);
    try {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await lockKey(client, "flow.register", definition.name);
        const flowResult = await client.query<{
          id: string;
          name: string;
          description: string | null;
        }>(
          `SELECT id, name, description FROM flows WHERE name = $1 FOR UPDATE`,
          [definition.name],
        );
        let flow = flowResult.rows[0];
        if (flow === undefined) {
          const inserted = await client.query<{
            id: string;
            name: string;
            description: string | null;
          }>(
            `INSERT INTO flows (id, name, description)
             VALUES ($1, $2, $3)
             RETURNING id, name, description`,
            [opaqueId("flow"), definition.name, definition.description ?? null],
          );
          flow = inserted.rows[0];
          if (flow === undefined) throw new ControlApiError("INTEGRITY", "Flow insert returned no row.");
        }
        const flowId = parseFlowId(flow.id);
        const latestResult = await client.query<{
          id: string;
          version: number;
          definition: unknown;
          same_definition: boolean;
        }>(
          `SELECT id, version, definition, (definition = $2::jsonb) AS same_definition
           FROM flow_versions
           WHERE flow_id = $1
           ORDER BY version DESC
           LIMIT 1`,
          [flowId, definitionText],
        );
        const latest = latestResult.rows[0];
        if (latest !== undefined && latest.same_definition) {
          await client.query("COMMIT");
          return Object.freeze({
            flow: Object.freeze({
              id: flowId,
              name: flow.name,
              description: flow.description,
            }),
            version: Object.freeze({
              id: parseFlowVersionId(latest.id),
              version: latest.version,
              definition: validateFlowDefinition(latest.definition),
            }),
            created: false,
          });
        }
        const nextVersion = (latest?.version ?? 0) + 1;
        const flowVersionId = parseFlowVersionId(opaqueId("flowv"));
        await client.query(
          `INSERT INTO flow_versions (id, flow_id, version, definition)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [flowVersionId, flowId, nextVersion, definitionText],
        );
        if ((definition.description ?? null) !== flow.description) {
          const updated = await client.query<{
            id: string;
            name: string;
            description: string | null;
          }>(
            `UPDATE flows SET description = $2, updated_at = clock_timestamp()
             WHERE id = $1 RETURNING id, name, description`,
            [flowId, definition.description ?? null],
          );
          flow = updated.rows[0] ?? flow;
        }
        await client.query("COMMIT");
        return Object.freeze({
          flow: Object.freeze({ id: flowId, name: flow.name, description: flow.description }),
          version: Object.freeze({ id: flowVersionId, version: nextVersion, definition }),
          created: true,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return translateDatabaseError(error, "register Flow");
    }
  }

  async inspectFlow(flowId: FlowId): Promise<FlowView> {
    const id = parseFlowId(flowId);
    try {
      const flowResult = await this.pool.query<{
        id: string; name: string; description: string | null; created_at: Date; updated_at: Date;
      }>(
        `SELECT id, name, description, created_at, updated_at FROM flows WHERE id = $1`,
        [id],
      );
      const flow = flowResult.rows[0];
      if (flow === undefined) throw new ControlApiError("NOT_FOUND", `Flow ${id} does not exist.`);
      const versionsResult = await this.pool.query<{
        id: string; version: number; definition: unknown; created_at: Date;
      }>(
        `SELECT id, version, definition, created_at
         FROM flow_versions WHERE flow_id = $1 ORDER BY version ASC`,
        [id],
      );
      return Object.freeze({
        flow: Object.freeze({
          id,
          name: flow.name,
          description: flow.description,
          createdAt: flow.created_at,
          updatedAt: flow.updated_at,
        }),
        versions: Object.freeze(versionsResult.rows.map((row) => Object.freeze({
          id: parseFlowVersionId(row.id),
          version: row.version,
          definition: validateFlowDefinition(row.definition),
          createdAt: row.created_at,
        }))),
      });
    } catch (error) {
      return translateDatabaseError(error, "inspect Flow");
    }
  }

  async startExecution(input: StartExecutionInput): Promise<StartExecutionResult> {
    const flowId = parseFlowId(input.flowId);
    const requestedVersionId =
      input.flowVersionId === undefined ? undefined : parseFlowVersionId(input.flowVersionId);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const requestHash = digest({ flowId, flowVersionId: requestedVersionId ?? null });

    try {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await lockKey(client, "execution.start", idempotencyKey);
        const existingKey = await client.query<{ request_hash: string; resource_id: string }>(
          `SELECT request_hash, resource_id
           FROM api_idempotency
           WHERE scope = 'execution.start' AND idempotency_key = $1`,
          [idempotencyKey],
        );
        const existing = existingKey.rows[0];
        if (existing !== undefined) {
          if (existing.request_hash !== requestHash) {
            throw new ControlApiError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency-Key was already used with a different execution request.",
            );
          }
          await client.query("COMMIT");
          const view = await this.inspectExecution(parseExecutionId(existing.resource_id));
          return Object.freeze({ ...view, replayed: true });
        }

        const versionResult = await client.query<{
          id: string;
          definition: unknown;
        }>(
          requestedVersionId === undefined
            ? `SELECT id, definition FROM flow_versions
               WHERE flow_id = $1 ORDER BY version DESC LIMIT 1`
            : `SELECT id, definition FROM flow_versions
               WHERE flow_id = $1 AND id = $2`,
          requestedVersionId === undefined ? [flowId] : [flowId, requestedVersionId],
        );
        const versionRow = versionResult.rows[0];
        if (versionRow === undefined) {
          throw new ControlApiError("NOT_FOUND", "Requested Flow or Flow Version does not exist.");
        }
        const definition = validateFlowDefinition(versionRow.definition);
        const flowVersionId = parseFlowVersionId(versionRow.id);
        const executionId = parseExecutionId(opaqueId("exec"));
        const running = transitionExecution("PENDING", "START").to;
        await client.query(
          `INSERT INTO executions (id, flow_id, flow_version_id, state)
           VALUES ($1, $2, $3, $4)`,
          [executionId, flowId, flowVersionId, running],
        );
        for (const stage of definition.stages) {
          const stageExecutionId = parseStageExecutionId(opaqueId("stagex"));
          const state: StageExecutionState = stage.dependsOn.length === 0 ? "READY" : "BLOCKED";
          await client.query(
            `INSERT INTO stage_executions (id, execution_id, stage_id, state)
             VALUES ($1, $2, $3, $4)`,
            [stageExecutionId, executionId, stage.id, state],
          );
        }
        await appendEvent(client, executionId, "execution.started", {
          flowId,
          flowVersionId,
        });
        await client.query(
          `INSERT INTO api_idempotency (scope, idempotency_key, request_hash, resource_id)
           VALUES ('execution.start', $1, $2, $3)`,
          [idempotencyKey, requestHash, executionId],
        );
        await client.query("COMMIT");
        const view = await this.inspectExecution(executionId);
        return Object.freeze({ ...view, replayed: false });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return translateDatabaseError(error, "start Execution");
    }
  }

  async inspectExecution(executionId: ExecutionId): Promise<ExecutionView> {
    const id = parseExecutionId(executionId);
    try {
      const executionResult = await this.pool.query<ExecutionRow>(
        `SELECT id, flow_id, flow_version_id, state, created_at, updated_at
         FROM executions WHERE id = $1`,
        [id],
      );
      const row = executionResult.rows[0];
      if (row === undefined) throw new ControlApiError("NOT_FOUND", `Execution ${id} does not exist.`);
      const stagesResult = await this.pool.query<StageRow>(
        `SELECT id, stage_id, state, created_at, updated_at
         FROM stage_executions WHERE execution_id = $1 ORDER BY stage_id`,
        [id],
      );
      return Object.freeze({
        execution: mapExecution(row),
        stages: Object.freeze(stagesResult.rows.map(mapStage)),
      });
    } catch (error) {
      return translateDatabaseError(error, "inspect Execution");
    }
  }

  async cancelExecution(executionId: ExecutionId): Promise<ExecutionView> {
    const id = parseExecutionId(executionId);
    try {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const executionResult = await client.query<ExecutionRow>(
          `SELECT id, flow_id, flow_version_id, state, created_at, updated_at
           FROM executions WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const executionRow = executionResult.rows[0];
        if (executionRow === undefined) throw new ControlApiError("NOT_FOUND", `Execution ${id} does not exist.`);
        const currentExecutionState = parseExecutionState(executionRow.state);
        if (currentExecutionState !== "CANCELLED") {
          if (isTerminalExecutionState(currentExecutionState)) {
            throw new ControlApiError(
              "TERMINAL_EXECUTION",
              `Execution ${id} is already terminal in state ${currentExecutionState}.`,
            );
          }
          const cancelled = transitionExecution(currentExecutionState, "CANCEL").to;

          // A pending human decision must not remain actionable after execution cancellation.
          // EXPIRED is the existing non-human terminal Gate outcome and keeps Gate/Stage invariants aligned.
          const waitingGates = await client.query<{ id: string; stage_execution_id: string }>(
            `SELECT id, stage_execution_id FROM gates
             WHERE execution_id = $1 AND state = 'WAITING'
             ORDER BY id FOR UPDATE`,
            [id],
          );
          for (const gate of waitingGates.rows) {
            await client.query(
              `UPDATE stage_executions
               SET state = 'FAILED', updated_at = clock_timestamp()
               WHERE id = $1 AND state = 'WAITING'`,
              [gate.stage_execution_id],
            );
            const updated = await client.query(
              `UPDATE gates
               SET state = 'EXPIRED', resolved_at = clock_timestamp(), updated_at = clock_timestamp()
               WHERE id = $1 AND state = 'WAITING'`,
              [gate.id],
            );
            if (updated.rowCount !== 1) {
              throw new ControlApiError("CONFLICT", "Gate changed while cancelling its Execution.");
            }
            await client.query(
              `INSERT INTO gate_resolutions (gate_id, outcome, actor_id, evidence)
               VALUES ($1, 'EXPIRED', NULL, $2::jsonb)`,
              [gate.id, JSON.stringify({ reason: "execution_cancelled" })],
            );
          }

          const stages = await client.query<StageRow>(
            `SELECT id, stage_id, state, created_at, updated_at
             FROM stage_executions WHERE execution_id = $1 ORDER BY id FOR UPDATE`,
            [id],
          );
          for (const stageRow of stages.rows) {
            const state = parseStageState(stageRow.state);
            if (isTerminalStageExecutionState(state)) continue;
            const activeClaim = await client.query<{ attempt_id: string }>(
              `SELECT attempt_id FROM claims
               WHERE stage_execution_id = $1 AND state = 'ACTIVE'
               FOR UPDATE`,
              [stageRow.id],
            );
            const claim = activeClaim.rows[0];
            if (claim !== undefined) {
              const attempt = await client.query<{ state: string }>(
                `SELECT state FROM attempts WHERE id = $1 FOR UPDATE`,
                [claim.attempt_id],
              );
              const attemptState = attempt.rows[0]?.state;
              if (attemptState === "CLAIMED" || attemptState === "RUNNING") {
                const nextAttempt = transitionAttempt(attemptState, "CANCEL").to;
                await client.query(
                  `UPDATE attempts SET state = $2, updated_at = clock_timestamp() WHERE id = $1`,
                  [claim.attempt_id, nextAttempt],
                );
              }
              await client.query(
                `UPDATE claims SET state = 'EXPIRED', finished_at = clock_timestamp()
                 WHERE attempt_id = $1 AND state = 'ACTIVE'`,
                [claim.attempt_id],
              );
            }
            const nextStage = transitionStageExecution(state, "CANCEL").to;
            await client.query(
              `UPDATE stage_executions SET state = $2, updated_at = clock_timestamp()
               WHERE id = $1`,
              [stageRow.id, nextStage],
            );
          }
          await client.query(
            `UPDATE executions SET state = $2, updated_at = clock_timestamp() WHERE id = $1`,
            [id, cancelled],
          );
          await appendEvent(client, id, "execution.cancelled", {
            expiredGateIds: waitingGates.rows.map((row) => row.id),
          });
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return this.inspectExecution(id);
    } catch (error) {
      return translateDatabaseError(error, "cancel Execution");
    }
  }

  async listEvents(executionId: ExecutionId): Promise<readonly ExecutionEventView[]> {
    const id = parseExecutionId(executionId);
    await this.assertExecutionExists(id);
    try {
      const result = await this.pool.query<{
        position: string;
        id: string;
        event_type: string;
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT position::text, id, event_type, payload, created_at
         FROM execution_events WHERE execution_id = $1 ORDER BY execution_events.position`,
        [id],
      );
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            position: row.position,
            id: parseEvidenceId(row.id),
            eventType: row.event_type,
            payload: requireJsonObject(row.payload, "Stored execution event payload"),
            createdAt: row.created_at,
          }),
        ),
      );
    } catch (error) {
      return translateDatabaseError(error, "list Execution events");
    }
  }

  async listEffects(executionId: ExecutionId): Promise<readonly EffectView[]> {
    const id = parseExecutionId(executionId);
    await this.assertExecutionExists(id);
    try {
      const result = await this.pool.query<{
        id: string;
        stage_execution_id: string;
        effect_key: string;
        state: string;
        resolution_code: string | null;
        external_reference: string | null;
        created_at: Date;
        updated_at: Date;
        decision: string | null;
        reconciled_by: string | null;
        reconciliation_external_reference: string | null;
        reconciled_at: Date | null;
      }>(
        `SELECT e.id, e.stage_execution_id, e.effect_key, e.state,
                e.resolution_code, e.external_reference, e.created_at, e.updated_at,
                r.decision, r.reconciled_by,
                r.external_reference AS reconciliation_external_reference,
                r.reconciled_at
         FROM effects e
         LEFT JOIN effect_reconciliations r ON r.effect_id = e.id
         WHERE e.execution_id = $1
         ORDER BY e.created_at, e.id`,
        [id],
      );
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            id: parseEffectId(row.id),
            stageExecutionId: parseStageExecutionId(row.stage_execution_id),
            effectKey: row.effect_key,
            state: row.state,
            resolutionCode: row.resolution_code,
            externalReference: row.external_reference,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            reconciliation:
              row.decision === null || row.reconciled_by === null || row.reconciled_at === null
                ? null
                : Object.freeze({
                    decision: row.decision,
                    reconciledBy: row.reconciled_by,
                    externalReference: row.reconciliation_external_reference,
                    reconciledAt: row.reconciled_at,
                  }),
          }),
        ),
      );
    } catch (error) {
      return translateDatabaseError(error, "list Effects");
    }
  }

  async listGates(executionId: ExecutionId): Promise<readonly GateView[]> {
    const id = parseExecutionId(executionId);
    await this.assertExecutionExists(id);
    try {
      const result = await this.pool.query<{
        id: string;
        stage_execution_id: string;
        state: string;
        expires_at: Date | null;
        resolved_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, stage_execution_id, state, expires_at, resolved_at, created_at, updated_at
         FROM gates WHERE execution_id = $1 ORDER BY created_at, id`,
        [id],
      );
      return Object.freeze(
        result.rows.map((row) => {
          const state = row.state;
          if (state !== "WAITING" && state !== "APPROVED" && state !== "REJECTED" && state !== "EXPIRED") {
            throw new ControlApiError("INTEGRITY", "Stored Gate state is invalid.");
          }
          return Object.freeze({
            id: parseGateId(row.id),
            stageExecutionId: parseStageExecutionId(row.stage_execution_id),
            state,
            expiresAt: row.expires_at,
            resolvedAt: row.resolved_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          });
        }),
      );
    } catch (error) {
      return translateDatabaseError(error, "list Gates");
    }
  }

  async getGate(gateId: ReturnType<typeof parseGateId>) {
    const snapshot = await this.gates.getGate(parseGateId(gateId));
    if (snapshot === null) throw new ControlApiError("NOT_FOUND", `Gate ${gateId} does not exist.`);
    return snapshot;
  }

  async resolveGate(
    gateId: ReturnType<typeof parseGateId>,
    decision: "APPROVE" | "REJECT",
    actorId: string,
    evidenceInput: unknown = {},
  ) {
    const evidence = requireJsonObject(evidenceInput, "Gate evidence");
    return this.gates.resolveGate(parseGateId(gateId), { event: decision, actorId, evidence });
  }

  async getEffect(effectId: ReturnType<typeof parseEffectId>) {
    const snapshot = await this.effects.getEffect(parseEffectId(effectId));
    if (snapshot === null) throw new ControlApiError("NOT_FOUND", `Effect ${effectId} does not exist.`);
    return snapshot;
  }

  async reconcileEffect(
    effectId: ReturnType<typeof parseEffectId>,
    input: {
      readonly decision: "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED";
      readonly reconciledBy: string;
      readonly externalReference?: string;
    },
  ) {
    return this.effects.reconcileEffect(parseEffectId(effectId), input);
  }

  async sendSignal(
    executionId: ExecutionId,
    signalName: string,
    idempotencyKeyInput: string,
    payloadInput: unknown = {},
  ): Promise<SendSignalResult> {
    const id = parseExecutionId(executionId);
    if (typeof signalName !== "string" || !SIGNAL_NAME.test(signalName) || signalName.length > MAX_SIGNAL_NAME) {
      throw new ControlApiError("INVALID_INPUT", "Signal name has an invalid format.");
    }
    const idempotencyKey = validateIdempotencyKey(idempotencyKeyInput);
    const payload = requireJsonObject(payloadInput, "Signal payload");
    const requestHash = digest({ executionId: id, signalName, payload });
    try {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await lockKey(client, `signal:${id}:${signalName}`, idempotencyKey);
        const executionResult = await client.query<{ state: string; definition: unknown }>(
          `SELECT e.state, fv.definition
           FROM executions e JOIN flow_versions fv ON fv.id = e.flow_version_id
           WHERE e.id = $1 FOR UPDATE OF e`,
          [id],
        );
        const executionRow = executionResult.rows[0];
        if (executionRow === undefined) throw new ControlApiError("NOT_FOUND", `Execution ${id} does not exist.`);
        const existingResult = await client.query<SignalRow>(
          `SELECT id, execution_id, signal_name, idempotency_key, request_hash, payload, created_at
           FROM signals
           WHERE execution_id = $1 AND signal_name = $2 AND idempotency_key = $3`,
          [id, signalName, idempotencyKey],
        );
        const existing = existingResult.rows[0];
        if (existing !== undefined) {
          if (existing.request_hash !== requestHash) {
            throw new ControlApiError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency-Key was already used with a different Signal payload.",
            );
          }
          await client.query("COMMIT");
          return Object.freeze({ signal: mapSignal(existing), replayed: true, resumedStageExecutionIds: [] });
        }
        if (isTerminalExecutionState(parseExecutionState(executionRow.state))) {
          throw new ControlApiError("TERMINAL_EXECUTION", "Terminal Execution cannot accept a new Signal.");
        }
        const signalId = parseSignalId(opaqueId("signal"));
        const inserted = await client.query<SignalRow>(
          `INSERT INTO signals (id, execution_id, signal_name, idempotency_key, request_hash, payload)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           RETURNING id, execution_id, signal_name, idempotency_key, request_hash, payload, created_at`,
          [signalId, id, signalName, idempotencyKey, requestHash, JSON.stringify(payload)],
        );
        const signalRow = inserted.rows[0];
        if (signalRow === undefined) throw new ControlApiError("INTEGRITY", "Signal insert returned no row.");

        const definition = validateFlowDefinition(executionRow.definition);
        const matchingStageIds = definition.stages
          .filter((stage) => stage.type === "signal" && stage.signalName === signalName)
          .map((stage) => stage.id);
        const resumed: ReturnType<typeof parseStageExecutionId>[] = [];
        for (const stageId of matchingStageIds) {
          const stageResult = await client.query<{ id: string; state: string }>(
            `SELECT id, state FROM stage_executions
             WHERE execution_id = $1 AND stage_id = $2 FOR UPDATE`,
            [id, stageId],
          );
          const stage = stageResult.rows[0];
          if (stage === undefined || (stage.state !== "WAITING" && stage.state !== "READY")) continue;
          let current: StageExecutionState = parseStageState(stage.state);
          if (current === "READY") {
            current = transitionStageExecution(current, "START").to;
            current = transitionStageExecution(current, "WAIT").to;
          }
          current = transitionStageExecution(current, "RESUME").to;
          const succeeded = transitionStageExecution(current, "SUCCEED").to;
          await client.query(
            `UPDATE stage_executions SET state = $2, updated_at = clock_timestamp() WHERE id = $1`,
            [stage.id, succeeded],
          );
          resumed.push(parseStageExecutionId(stage.id));
        }
        if (executionRow.state === "WAITING" && resumed.length > 0) {
          const next = transitionExecution("WAITING", "RESUME").to;
          await client.query(
            `UPDATE executions SET state = $2, updated_at = clock_timestamp() WHERE id = $1`,
            [id, next],
          );
        }
        await appendEvent(client, id, "signal.received", {
          signalId,
          signalName,
          resumedStageExecutionIds: resumed,
        });
        await client.query("COMMIT");
        return Object.freeze({
          signal: mapSignal(signalRow),
          replayed: false,
          resumedStageExecutionIds: Object.freeze(resumed),
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return translateDatabaseError(error, "send Signal");
    }
  }

  async listSignals(executionId: ExecutionId): Promise<readonly SignalView[]> {
    const id = parseExecutionId(executionId);
    await this.assertExecutionExists(id);
    try {
      const result = await this.pool.query<SignalRow>(
        `SELECT id, execution_id, signal_name, idempotency_key, request_hash, payload, created_at
         FROM signals WHERE execution_id = $1 ORDER BY created_at, id`,
        [id],
      );
      return Object.freeze(result.rows.map(mapSignal));
    } catch (error) {
      return translateDatabaseError(error, "list Signals");
    }
  }

  private async assertExecutionExists(executionId: ExecutionId): Promise<void> {
    const result = await this.pool.query<{ present: number }>(
      `SELECT 1 AS present FROM executions WHERE id = $1`,
      [executionId],
    );
    if (result.rows[0] === undefined) {
      throw new ControlApiError("NOT_FOUND", `Execution ${executionId} does not exist.`);
    }
  }
}
