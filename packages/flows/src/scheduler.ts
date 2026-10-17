import {
  EXECUTION_STATES,
  STAGE_EXECUTION_STATES,
  parseExecutionId,
  parseGateId,
  parseStageExecutionId,
  validateFlowDefinition,
  type ExecutionId,
  type ExecutionState,
  type FlowDefinition,
  type GateId,
  type StageDefinition,
  type StageExecutionId,
  type StageExecutionState,
} from "@aegisflow/contracts";
import {
  transitionExecution,
  transitionStageExecution,
} from "@aegisflow/core";
import { PostgresGateLedger } from "@aegisflow/gates";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const DEFAULT_TICK_LIMIT = 100;
const MAX_TICK_LIMIT = 1_000;
const MAX_RECONCILE_PASSES = 1_024;

interface ExecutionRow {
  readonly id: string;
  readonly state: string;
  readonly definition: unknown;
}

interface StageRow {
  readonly id: string;
  readonly stage_id: string;
  readonly state: string;
  readonly updated_at: Date;
}

interface MutableStage {
  readonly id: StageExecutionId;
  readonly stageId: string;
  state: StageExecutionState;
  updatedAt: Date;
}

export interface ReconcileExecutionResult {
  readonly executionId: ExecutionId;
  readonly state: ExecutionState;
  readonly changed: boolean;
  readonly readyStageExecutionIds: readonly StageExecutionId[];
}

export interface SchedulerTickResult {
  readonly inspected: number;
  readonly changed: number;
}

export class FlowSchedulerError extends Error {
  readonly code: "INVALID_INPUT" | "NOT_FOUND" | "INTEGRITY" | "TRANSACTION";

  constructor(
    code: FlowSchedulerError["code"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "FlowSchedulerError";
    this.code = code;
  }
}

function parseExecutionState(value: unknown): ExecutionState {
  if (typeof value !== "string" || !EXECUTION_STATES.includes(value as ExecutionState)) {
    throw new FlowSchedulerError("INTEGRITY", "Stored Execution state is invalid.");
  }
  return value as ExecutionState;
}

function parseStageState(value: unknown): StageExecutionState {
  if (
    typeof value !== "string" ||
    !STAGE_EXECUTION_STATES.includes(value as StageExecutionState)
  ) {
    throw new FlowSchedulerError("INTEGRITY", "Stored StageExecution state is invalid.");
  }
  return value as StageExecutionState;
}

function deterministicGateId(stageExecutionId: StageExecutionId): GateId {
  const digest = createHash("sha256")
    .update(`aegisflow:gate:${stageExecutionId}`, "utf8")
    .digest("hex");
  return parseGateId(`gate_flow_${digest.slice(0, 40)}`);
}

function eventId(): string {
  return `evidence_${randomUUID().replaceAll("-", "")}`;
}

async function appendEvent(
  client: PoolClient,
  executionId: ExecutionId,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await client.query(
    `INSERT INTO execution_events (id, execution_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [eventId(), executionId, eventType, JSON.stringify(payload)],
  );
}

async function updateStage(
  client: PoolClient,
  stage: MutableStage,
  next: StageExecutionState,
  executionId: ExecutionId,
  eventType: string,
  payload: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  if (stage.state === next) return;
  const result = await client.query<{ updated_at: Date }>(
    `UPDATE stage_executions
     SET state = $2, updated_at = clock_timestamp()
     WHERE id = $1 AND state = $3
     RETURNING updated_at`,
    [stage.id, next, stage.state],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FlowSchedulerError(
      "INTEGRITY",
      `StageExecution ${stage.id} changed while the scheduler held Execution authority.`,
    );
  }
  const previous = stage.state;
  stage.state = next;
  stage.updatedAt = row.updated_at;
  await appendEvent(client, executionId, eventType, {
    stageExecutionId: stage.id,
    stageId: stage.stageId,
    from: previous,
    to: next,
    ...payload,
  });
}

function stageDefinitionMap(definition: FlowDefinition): ReadonlyMap<string, StageDefinition> {
  return new Map(definition.stages.map((stage) => [stage.id, stage] as const));
}

function dependenciesFor(
  stage: StageDefinition,
  stagesByLogicalId: ReadonlyMap<string, MutableStage>,
): readonly MutableStage[] {
  return stage.dependsOn.map((dependency) => {
    const row = stagesByLogicalId.get(dependency);
    if (row === undefined) {
      throw new FlowSchedulerError(
        "INTEGRITY",
        `Materialized StageExecution for dependency '${dependency}' is missing.`,
      );
    }
    return row;
  });
}

function waitIsDue(stage: Extract<StageDefinition, { type: "wait" }>, updatedAt: Date, now: Date): boolean {
  if (stage.delayMs !== undefined) {
    return updatedAt.getTime() + stage.delayMs <= now.getTime();
  }
  return Date.parse(stage.resumeAt as string) <= now.getTime();
}

function desiredExecutionState(stages: readonly MutableStage[]): "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED" {
  const states = stages.map((stage) => stage.state);
  const allTerminal = states.every((state) =>
    state === "SUCCEEDED" || state === "FAILED" || state === "SKIPPED" || state === "CANCELLED"
  );
  if (allTerminal) {
    return states.some((state) => state === "FAILED" || state === "CANCELLED")
      ? "FAILED"
      : "SUCCEEDED";
  }
  if (states.some((state) => state === "READY" || state === "RUNNING")) return "RUNNING";
  return "WAITING";
}

async function setExecutionState(
  client: PoolClient,
  executionId: ExecutionId,
  current: ExecutionState,
  desired: "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED",
): Promise<ExecutionState> {
  if (current === "CANCELLED" || current === "SUCCEEDED" || current === "FAILED") return current;
  let state: ExecutionState = current;
  const apply = async (event: "WAIT" | "RESUME" | "SUCCEED" | "FAIL"): Promise<void> => {
    const transition = transitionExecution(state, event);
    const updated = await client.query(
      `UPDATE executions
       SET state = $2, updated_at = clock_timestamp()
       WHERE id = $1 AND state = $3`,
      [executionId, transition.to, transition.from],
    );
    if (updated.rowCount !== 1) {
      throw new FlowSchedulerError("INTEGRITY", "Execution changed while scheduler held row authority.");
    }
    await appendEvent(client, executionId, `execution.${transition.to.toLowerCase()}`, {
      from: transition.from,
      to: transition.to,
      source: "flow-scheduler",
    });
    state = transition.to;
  };

  if (desired === "RUNNING") {
    if (state === "WAITING") await apply("RESUME");
    return state;
  }
  if (desired === "WAITING") {
    if (state === "RUNNING") await apply("WAIT");
    return state;
  }
  if (state === "WAITING") await apply("RESUME");
  if (desired === "SUCCEEDED") await apply("SUCCEED");
  else await apply("FAIL");
  return state;
}

export class PostgresFlowScheduler {
  private readonly gates: PostgresGateLedger;

  constructor(private readonly pool: Pool) {
    this.gates = new PostgresGateLedger(pool);
  }

  async reconcileExecution(executionIdInput: ExecutionId): Promise<ReconcileExecutionResult> {
    const executionId = parseExecutionId(executionIdInput);
    let changed = false;

    for (let outerPass = 0; outerPass < 4; outerPass += 1) {
      const client = await this.pool.connect();
      let gateStages: readonly StageExecutionId[] = [];
      let state: ExecutionState;
      let readyStageExecutionIds: readonly StageExecutionId[] = [];
      let transactionChanged = false;
      try {
        await client.query("BEGIN");
        const executionResult = await client.query<ExecutionRow>(
          `SELECT e.id, e.state, fv.definition
           FROM executions e
           JOIN flow_versions fv ON fv.id = e.flow_version_id AND fv.flow_id = e.flow_id
           WHERE e.id = $1
           FOR UPDATE OF e`,
          [executionId],
        );
        const executionRow = executionResult.rows[0];
        if (executionRow === undefined) {
          throw new FlowSchedulerError("NOT_FOUND", `Execution ${executionId} does not exist.`);
        }
        state = parseExecutionState(executionRow.state);
        const definition = validateFlowDefinition(executionRow.definition);

        const stagesResult = await client.query<StageRow>(
          `SELECT id, stage_id, state, updated_at
           FROM stage_executions
           WHERE execution_id = $1
           ORDER BY stage_id
           FOR UPDATE`,
          [executionId],
        );
        if (stagesResult.rows.length !== definition.stages.length) {
          throw new FlowSchedulerError(
            "INTEGRITY",
            "Execution materialized Stage count disagrees with its pinned Flow Version.",
          );
        }
        const stages = stagesResult.rows.map<MutableStage>((row) => ({
          id: parseStageExecutionId(row.id),
          stageId: row.stage_id,
          state: parseStageState(row.state),
          updatedAt: row.updated_at,
        }));
        const stagesByLogicalId = new Map(stages.map((stage) => [stage.stageId, stage] as const));
        const definitions = stageDefinitionMap(definition);
        for (const stage of stages) {
          if (!definitions.has(stage.stageId)) {
            throw new FlowSchedulerError(
              "INTEGRITY",
              `Materialized Stage '${stage.stageId}' is not present in the pinned Flow Version.`,
            );
          }
        }

        if (state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED") {
          await client.query("COMMIT");
          return Object.freeze({
            executionId,
            state,
            changed,
            readyStageExecutionIds: Object.freeze([]),
          });
        }

        const signalResult = await client.query<{ signal_name: string }>(
          `SELECT DISTINCT signal_name FROM signals WHERE execution_id = $1`,
          [executionId],
        );
        const deliveredSignals = new Set(signalResult.rows.map((row) => row.signal_name));

        for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass += 1) {
          let passChanged = false;
          const now = new Date();

          for (const stageDefinition of definition.stages) {
            const stage = stagesByLogicalId.get(stageDefinition.id);
            if (stage === undefined) {
              throw new FlowSchedulerError("INTEGRITY", `Stage '${stageDefinition.id}' is not materialized.`);
            }

            if (stage.state === "BLOCKED") {
              const dependencies = dependenciesFor(stageDefinition, stagesByLogicalId);
              if (
                dependencies.some((dependency) =>
                  dependency.state === "FAILED" ||
                  dependency.state === "CANCELLED" ||
                  dependency.state === "SKIPPED"
                )
              ) {
                const skipped = transitionStageExecution(stage.state, "SKIP").to;
                await updateStage(client, stage, skipped, executionId, "stage.skipped", {
                  reason: "dependency_terminal_without_success",
                });
                passChanged = true;
                transactionChanged = true;
                continue;
              }
              if (dependencies.every((dependency) => dependency.state === "SUCCEEDED")) {
                const ready = transitionStageExecution(stage.state, "UNBLOCK").to;
                await updateStage(client, stage, ready, executionId, "stage.ready", {
                  reason: "dependencies_succeeded",
                });
                passChanged = true;
                transactionChanged = true;
              }
            }

            if (stageDefinition.type === "signal") {
              if (stage.state === "READY") {
                const started = transitionStageExecution(stage.state, "START").to;
                const waiting = transitionStageExecution(started, "WAIT").to;
                if (deliveredSignals.has(stageDefinition.signalName)) {
                  const succeeded = transitionStageExecution(started, "SUCCEED").to;
                  await updateStage(client, stage, succeeded, executionId, "signal.consumed", {
                    signalName: stageDefinition.signalName,
                    mode: "durable-early-delivery",
                  });
                } else {
                  await updateStage(client, stage, waiting, executionId, "stage.waiting", {
                    reason: "signal",
                    signalName: stageDefinition.signalName,
                  });
                }
                passChanged = true;
                transactionChanged = true;
              } else if (
                stage.state === "WAITING" && deliveredSignals.has(stageDefinition.signalName)
              ) {
                const running = transitionStageExecution(stage.state, "RESUME").to;
                const succeeded = transitionStageExecution(running, "SUCCEED").to;
                await updateStage(client, stage, succeeded, executionId, "signal.consumed", {
                  signalName: stageDefinition.signalName,
                  mode: "durable-delivery",
                });
                passChanged = true;
                transactionChanged = true;
              }
              continue;
            }

            if (stageDefinition.type === "wait") {
              if (stage.state === "READY") {
                const started = transitionStageExecution(stage.state, "START").to;
                const waiting = transitionStageExecution(started, "WAIT").to;
                await updateStage(client, stage, waiting, executionId, "stage.waiting", {
                  reason: "timer",
                });
                passChanged = true;
                transactionChanged = true;
              }
              if (stage.state === "WAITING" && waitIsDue(stageDefinition, stage.updatedAt, now)) {
                const running = transitionStageExecution(stage.state, "RESUME").to;
                const succeeded = transitionStageExecution(running, "SUCCEED").to;
                await updateStage(client, stage, succeeded, executionId, "wait.elapsed");
                passChanged = true;
                transactionChanged = true;
              }
            }
          }

          if (!passChanged) break;
          if (pass === MAX_RECONCILE_PASSES - 1) {
            throw new FlowSchedulerError("INTEGRITY", "Scheduler failed to converge within bounded passes.");
          }
        }

        gateStages = Object.freeze(
          definition.stages
            .filter((stageDefinition) => stageDefinition.type === "gate")
            .map((stageDefinition) => stagesByLogicalId.get(stageDefinition.id))
            .filter((stage): stage is MutableStage => stage !== undefined && stage.state === "READY")
            .map((stage) => stage.id),
        );

        const desired = desiredExecutionState(stages);
        const nextState = await setExecutionState(client, executionId, state, desired);
        if (nextState !== state) {
          state = nextState;
          transactionChanged = true;
        }
        readyStageExecutionIds = Object.freeze(
          stages.filter((stage) => stage.state === "READY").map((stage) => stage.id),
        );
        await client.query("COMMIT");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
        if (error instanceof FlowSchedulerError) throw error;
        throw new FlowSchedulerError("TRANSACTION", "Flow scheduler reconciliation failed.", {
          cause: error,
        });
      } finally {
        client.release();
      }

      changed = changed || transactionChanged;
      if (gateStages.length === 0) {
        return Object.freeze({ executionId, state, changed, readyStageExecutionIds });
      }

      let gateChanged = false;
      for (const stageExecutionId of gateStages) {
        const gate = await this.gates.createGate({
          id: deterministicGateId(stageExecutionId),
          executionId,
          stageExecutionId,
        });
        gateChanged = gateChanged || gate.created;
      }
      changed = changed || gateChanged;
    }

    throw new FlowSchedulerError("INTEGRITY", "Gate materialization did not converge.");
  }

  async tick(limit = DEFAULT_TICK_LIMIT): Promise<SchedulerTickResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TICK_LIMIT) {
      throw new FlowSchedulerError(
        "INVALID_INPUT",
        `limit must be an integer between 1 and ${MAX_TICK_LIMIT}.`,
      );
    }
    try {
      const result = await this.pool.query<{ id: string }>(
        `SELECT id
         FROM executions
         WHERE state IN ('RUNNING', 'WAITING')
         ORDER BY updated_at, id
         LIMIT $1`,
        [limit],
      );
      let changed = 0;
      for (const row of result.rows) {
        const reconciled = await this.reconcileExecution(parseExecutionId(row.id));
        if (reconciled.changed) changed += 1;
      }
      return Object.freeze({ inspected: result.rows.length, changed });
    } catch (error) {
      if (error instanceof FlowSchedulerError) throw error;
      throw new FlowSchedulerError("TRANSACTION", "Flow scheduler tick failed.", { cause: error });
    }
  }
}
