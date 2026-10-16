import {
  ATTEMPT_STATES,
  EXECUTION_STATES,
  STAGE_EXECUTION_STATES,
  createFlowVersion,
  isJsonValue,
  parseAttemptId,
  parseEvidenceId,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseStageExecutionId,
  type Attempt,
  type AttemptState,
  type EvidenceId,
  type Execution,
  type ExecutionId,
  type ExecutionState,
  type FlowId,
  type FlowVersion,
  type FlowVersionId,
  type JsonObject,
  type StageExecution,
  type StageExecutionState,
} from "@aegisflow/contracts";
import { Pool, type PoolClient } from "pg";
import { withTransaction } from "./database.js";
import { PersistenceError, translatePostgresError } from "./errors.js";

export interface StoredFlow {
  readonly id: FlowId;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewFlow {
  readonly id: FlowId;
  readonly name: string;
  readonly description?: string;
}

export interface ExecutionEventRecord {
  readonly position: bigint;
  readonly id: EvidenceId;
  readonly executionId: ExecutionId;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly createdAt: Date;
}

export interface NewExecutionEvent {
  readonly id: EvidenceId;
  readonly executionId: ExecutionId;
  readonly eventType: string;
  readonly payload: JsonObject;
}

interface FlowRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface FlowVersionRow {
  readonly id: string;
  readonly flow_id: string;
  readonly version: number;
  readonly definition: unknown;
}

interface ExecutionRow {
  readonly id: string;
  readonly flow_id: string;
  readonly flow_version_id: string;
  readonly state: string;
}

interface StageExecutionRow {
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

interface ExecutionEventRow {
  readonly position: string;
  readonly id: string;
  readonly execution_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly created_at: Date;
}

function parseState<State extends string>(
  value: unknown,
  states: readonly State[],
  label: string,
): State {
  if (typeof value !== "string" || !states.includes(value as State)) {
    throw new PersistenceError("INTEGRITY", `Stored ${label} state is invalid.`);
  }
  return value as State;
}

function mapFlow(row: FlowRow): StoredFlow {
  return Object.freeze({
    id: parseFlowId(row.id),
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapExecution(row: ExecutionRow): Execution {
  return Object.freeze({
    id: parseExecutionId(row.id),
    flowId: parseFlowId(row.flow_id),
    flowVersionId: parseFlowVersionId(row.flow_version_id),
    state: parseState<ExecutionState>(row.state, EXECUTION_STATES, "Execution"),
  });
}

function mapStageExecution(row: StageExecutionRow): StageExecution {
  return Object.freeze({
    id: parseStageExecutionId(row.id),
    executionId: parseExecutionId(row.execution_id),
    stageId: row.stage_id,
    state: parseState<StageExecutionState>(
      row.state,
      STAGE_EXECUTION_STATES,
      "StageExecution",
    ),
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

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !isJsonValue(value)
  ) {
    throw new PersistenceError("INTEGRITY", `${label} must be a finite JSON object.`);
  }
  return value as JsonObject;
}

function mapExecutionEvent(row: ExecutionEventRow): ExecutionEventRecord {
  return Object.freeze({
    position: BigInt(row.position),
    id: parseEvidenceId(row.id),
    executionId: parseExecutionId(row.execution_id),
    eventType: row.event_type,
    payload: requireJsonObject(row.payload, "Stored execution event payload"),
    createdAt: row.created_at,
  });
}

async function insertStageExecution(client: PoolClient, stage: StageExecution): Promise<void> {
  await client.query(
    `INSERT INTO stage_executions (id, execution_id, stage_id, state)
     VALUES ($1, $2, $3, $4)`,
    [stage.id, stage.executionId, stage.stageId, stage.state],
  );
}

export class PostgresPersistence {
  constructor(readonly pool: Pool) {}

  async createFlow(input: NewFlow): Promise<StoredFlow> {
    try {
      const result = await this.pool.query<FlowRow>(
        `INSERT INTO flows (id, name, description)
         VALUES ($1, $2, $3)
         RETURNING id, name, description, created_at, updated_at`,
        [input.id, input.name, input.description ?? null],
      );
      const row = result.rows[0];
      if (row === undefined) throw new PersistenceError("TRANSACTION", "Flow insert returned no row.");
      return mapFlow(row);
    } catch (error) {
      return translatePostgresError(error, "Create Flow");
    }
  }

  async getFlow(id: FlowId): Promise<StoredFlow | null> {
    const result = await this.pool.query<FlowRow>(
      `SELECT id, name, description, created_at, updated_at
       FROM flows WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapFlow(row);
  }

  async createFlowVersion(version: FlowVersion): Promise<FlowVersion> {
    try {
      await this.pool.query(
        `INSERT INTO flow_versions (id, flow_id, version, definition)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [version.id, version.flowId, version.version, JSON.stringify(version.definition)],
      );
      return version;
    } catch (error) {
      return translatePostgresError(error, "Create FlowVersion");
    }
  }

  async getFlowVersion(id: FlowVersionId): Promise<FlowVersion | null> {
    const result = await this.pool.query<FlowVersionRow>(
      `SELECT id, flow_id, version, definition
       FROM flow_versions WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return createFlowVersion({
      id: parseFlowVersionId(row.id),
      flowId: parseFlowId(row.flow_id),
      version: row.version,
      definition: row.definition,
    });
  }

  async createExecutionWithStages(
    execution: Execution,
    stages: readonly StageExecution[],
  ): Promise<void> {
    for (const stage of stages) {
      if (stage.executionId !== execution.id) {
        throw new PersistenceError(
          "INTEGRITY",
          `StageExecution ${stage.id} belongs to a different Execution.`,
        );
      }
    }

    try {
      await withTransaction(this.pool, async (client) => {
        await client.query(
          `INSERT INTO executions (id, flow_id, flow_version_id, state)
           VALUES ($1, $2, $3, $4)`,
          [execution.id, execution.flowId, execution.flowVersionId, execution.state],
        );
        for (const stage of stages) {
          await insertStageExecution(client, stage);
        }
      });
    } catch (error) {
      return translatePostgresError(error, "Create Execution with Stages");
    }
  }

  async getExecution(id: ExecutionId): Promise<Execution | null> {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT id, flow_id, flow_version_id, state
       FROM executions WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapExecution(row);
  }

  async listStageExecutions(executionId: ExecutionId): Promise<readonly StageExecution[]> {
    const result = await this.pool.query<StageExecutionRow>(
      `SELECT id, execution_id, stage_id, state
       FROM stage_executions
       WHERE execution_id = $1
       ORDER BY stage_id ASC`,
      [executionId],
    );
    return Object.freeze(result.rows.map(mapStageExecution));
  }

  async compareAndSetExecutionState(
    id: ExecutionId,
    expected: ExecutionState,
    next: ExecutionState,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE executions
       SET state = $3, updated_at = now()
       WHERE id = $1 AND state = $2`,
      [id, expected, next],
    );
    return result.rowCount === 1;
  }

  async compareAndSetStageExecutionState(
    id: StageExecution["id"],
    expected: StageExecutionState,
    next: StageExecutionState,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE stage_executions
       SET state = $3, updated_at = now()
       WHERE id = $1 AND state = $2`,
      [id, expected, next],
    );
    return result.rowCount === 1;
  }

  async createAttempt(attempt: Attempt): Promise<Attempt> {
    try {
      const result = await this.pool.query<AttemptRow>(
        `INSERT INTO attempts (id, stage_execution_id, sequence, state)
         VALUES ($1, $2, $3, $4)
         RETURNING id, stage_execution_id, sequence, state`,
        [attempt.id, attempt.stageExecutionId, attempt.sequence, attempt.state],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PersistenceError("TRANSACTION", "Attempt insert returned no row.");
      }
      return mapAttempt(row);
    } catch (error) {
      return translatePostgresError(error, "Create Attempt");
    }
  }

  async compareAndSetAttemptState(
    id: Attempt["id"],
    expected: AttemptState,
    next: AttemptState,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE attempts
       SET state = $3, updated_at = now()
       WHERE id = $1 AND state = $2`,
      [id, expected, next],
    );
    return result.rowCount === 1;
  }

  async listAttempts(stageExecutionId: StageExecution["id"]): Promise<readonly Attempt[]> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT id, stage_execution_id, sequence, state
       FROM attempts
       WHERE stage_execution_id = $1
       ORDER BY sequence ASC`,
      [stageExecutionId],
    );
    return Object.freeze(result.rows.map(mapAttempt));
  }

  async appendExecutionEvent(event: NewExecutionEvent): Promise<ExecutionEventRecord> {
    if (event.eventType.length === 0 || event.eventType.length > 128) {
      throw new PersistenceError("INTEGRITY", "Execution event type must be 1-128 characters.");
    }
    requireJsonObject(event.payload, "Execution event payload");

    try {
      const result = await this.pool.query<ExecutionEventRow>(
        `INSERT INTO execution_events (id, execution_id, event_type, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING position::text, id, execution_id, event_type, payload, created_at`,
        [event.id, event.executionId, event.eventType, JSON.stringify(event.payload)],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PersistenceError("TRANSACTION", "Execution event insert returned no row.");
      }
      return mapExecutionEvent(row);
    } catch (error) {
      return translatePostgresError(error, "Append Execution event");
    }
  }

  async listExecutionEvents(executionId: ExecutionId): Promise<readonly ExecutionEventRecord[]> {
    const result = await this.pool.query<ExecutionEventRow>(
      `SELECT position::text, id, execution_id, event_type, payload, created_at
       FROM execution_events
       WHERE execution_id = $1
       ORDER BY position ASC`,
      [executionId],
    );
    return Object.freeze(result.rows.map(mapExecutionEvent));
  }
}
