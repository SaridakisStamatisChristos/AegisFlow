import {
  GATE_STATES,
  parseEffectId,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseGateId,
  parseStageExecutionId,
  type GateState,
} from "@aegisflow/contracts";
import type { Pool } from "pg";
import { ControlApiError } from "./errors.js";

const OPERATOR_LIST_LIMIT = 200;

function parseGateState(value: unknown): GateState {
  if (typeof value !== "string" || !GATE_STATES.includes(value as GateState)) {
    throw new ControlApiError("INTEGRITY", "Stored Gate state is invalid.");
  }
  return value as GateState;
}

function bounded<T>(rows: readonly T[]): { readonly rows: readonly T[]; readonly truncated: boolean } {
  return Object.freeze({
    rows: Object.freeze(rows.slice(0, OPERATOR_LIST_LIMIT)),
    truncated: rows.length > OPERATOR_LIST_LIMIT,
  });
}

export async function listOperatorFlows(pool: Pool) {
  const result = await pool.query<{
    id: string; name: string; description: string | null; latest_version_id: string | null;
    latest_version: number | null; created_at: Date; updated_at: Date;
  }>(
    `SELECT f.id, f.name, f.description, f.created_at, f.updated_at,
            latest.id AS latest_version_id, latest.version AS latest_version
     FROM flows AS f
     LEFT JOIN LATERAL (
       SELECT fv.id, fv.version FROM flow_versions AS fv
       WHERE fv.flow_id = f.id ORDER BY fv.version DESC LIMIT 1
     ) AS latest ON TRUE
     ORDER BY f.updated_at DESC, f.id ASC LIMIT $1`,
    [OPERATOR_LIST_LIMIT + 1],
  );
  const limited = bounded(result.rows);
  return Object.freeze({
    flows: Object.freeze(limited.rows.map((row) => Object.freeze({
      id: parseFlowId(row.id),
      name: row.name,
      description: row.description,
      latestVersionId: row.latest_version_id === null ? null : parseFlowVersionId(row.latest_version_id),
      latestVersion: row.latest_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))),
    truncated: limited.truncated,
  });
}

export async function listOperatorExecutions(pool: Pool) {
  const result = await pool.query<{
    id: string; flow_id: string; flow_version_id: string; flow_name: string;
    state: string; created_at: Date; updated_at: Date;
  }>(
    `SELECT e.id, e.flow_id, e.flow_version_id, e.state, e.created_at, e.updated_at,
            f.name AS flow_name
     FROM executions AS e JOIN flows AS f ON f.id = e.flow_id
     ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
    [OPERATOR_LIST_LIMIT + 1],
  );
  const limited = bounded(result.rows);
  return Object.freeze({
    executions: Object.freeze(limited.rows.map((row) => Object.freeze({
      id: parseExecutionId(row.id),
      flowId: parseFlowId(row.flow_id),
      flowVersionId: parseFlowVersionId(row.flow_version_id),
      flowName: row.flow_name,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))),
    truncated: limited.truncated,
  });
}

export async function listPendingOperatorGates(pool: Pool) {
  const result = await pool.query<{
    id: string; execution_id: string; stage_execution_id: string; stage_id: string;
    flow_name: string; state: string; expires_at: Date | null; created_at: Date; updated_at: Date;
  }>(
    `SELECT g.id, g.execution_id, g.stage_execution_id, g.state, g.expires_at,
            g.created_at, g.updated_at, se.stage_id, f.name AS flow_name
     FROM gates AS g
     JOIN stage_executions AS se ON se.id = g.stage_execution_id
     JOIN executions AS e ON e.id = g.execution_id
     JOIN flows AS f ON f.id = e.flow_id
     WHERE g.state = 'WAITING'
     ORDER BY g.created_at ASC, g.id ASC LIMIT $1`,
    [OPERATOR_LIST_LIMIT + 1],
  );
  const limited = bounded(result.rows);
  return Object.freeze({
    gates: Object.freeze(limited.rows.map((row) => Object.freeze({
      id: parseGateId(row.id),
      executionId: parseExecutionId(row.execution_id),
      stageExecutionId: parseStageExecutionId(row.stage_execution_id),
      stageId: row.stage_id,
      flowName: row.flow_name,
      state: parseGateState(row.state),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))),
    truncated: limited.truncated,
  });
}

export async function listOperatorEffects(pool: Pool) {
  const result = await pool.query<{
    id: string; execution_id: string; stage_execution_id: string; stage_id: string;
    flow_name: string; effect_key: string; state: string; resolution_code: string | null;
    external_reference: string | null; created_at: Date; updated_at: Date;
    decision: string | null; reconciled_by: string | null; reconciled_at: Date | null;
  }>(
    `SELECT ef.id, ef.execution_id, ef.stage_execution_id, ef.effect_key, ef.state,
            ef.resolution_code, ef.external_reference, ef.created_at, ef.updated_at,
            se.stage_id, f.name AS flow_name,
            er.decision, er.reconciled_by, er.reconciled_at
     FROM effects AS ef
     JOIN stage_executions AS se ON se.id = ef.stage_execution_id
     JOIN executions AS ex ON ex.id = ef.execution_id
     JOIN flows AS f ON f.id = ex.flow_id
     LEFT JOIN effect_reconciliations AS er ON er.effect_id = ef.id
     ORDER BY CASE WHEN ef.state = 'RECONCILIATION_REQUIRED' THEN 0 ELSE 1 END,
              ef.updated_at DESC, ef.id ASC
     LIMIT $1`,
    [OPERATOR_LIST_LIMIT + 1],
  );
  const limited = bounded(result.rows);
  return Object.freeze({
    effects: Object.freeze(limited.rows.map((row) => Object.freeze({
      id: parseEffectId(row.id),
      executionId: parseExecutionId(row.execution_id),
      stageExecutionId: parseStageExecutionId(row.stage_execution_id),
      stageId: row.stage_id,
      flowName: row.flow_name,
      effectKey: row.effect_key,
      state: row.state,
      resolutionCode: row.resolution_code,
      externalReference: row.external_reference,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reconciliation: row.decision === null ? null : Object.freeze({
        decision: row.decision,
        reconciledBy: row.reconciled_by,
        reconciledAt: row.reconciled_at,
      }),
    }))),
    truncated: limited.truncated,
  });
}
