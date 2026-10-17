import {
  parseEffectId,
  parseExecutionId,
  parseStageExecutionId,
  type EffectId,
  type ExecutionId,
  type JsonObject,
  type StageExecutionId,
} from "@aegisflow/contracts";
import { EffectLedgerError, PostgresEffectLedger, type DurableEffectRecord } from "@aegisflow/effects";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ConnectorRegistry, normalizeConnectorResult, type ConnectorResult } from "./connector.js";
import { ConnectorInvocationError, ToolRuntimeError } from "./errors.js";

interface ToolResultRow {
  readonly effect_id: string;
  readonly stage_execution_id: string;
  readonly provider_step: number;
  readonly call_id: string;
  readonly tool_name: string;
  readonly output: unknown;
  readonly external_reference: string | null;
  readonly created_at: Date;
}

export interface ProviderToolCallLike {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface DurableToolResult {
  readonly effectId: EffectId;
  readonly stageExecutionId: StageExecutionId;
  readonly providerStep: number;
  readonly callId: string;
  readonly toolName: string;
  readonly output: ConnectorResult["output"];
  readonly externalReference: string | null;
  readonly createdAt: Date;
}

export interface ExecuteToolCallInput {
  readonly executionId: ExecutionId;
  readonly stageExecutionId: StageExecutionId;
  readonly providerStep: number;
  readonly call: ProviderToolCallLike;
  readonly recovered: boolean;
  readonly signal?: AbortSignal;
}

export interface ToolExecutionResult {
  readonly effect: DurableEffectRecord;
  readonly result: DurableToolResult;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new ToolRuntimeError("INTEGRITY", "Durable tool evidence contains a non-JSON value.");
}

function validateStep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new ToolRuntimeError("INVALID_INPUT", "providerStep must be an integer between 1 and 32.");
  }
  return value;
}

function validateCallId(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.trim() !== value || /[\u0000\r\n]/u.test(value)) {
    throw new ToolRuntimeError("INVALID_INPUT", "tool call id is invalid.");
  }
  return value;
}

function mapToolResult(row: ToolResultRow): DurableToolResult {
  const normalized = normalizeConnectorResult({
    output: row.output,
    ...(row.external_reference === null ? {} : { externalReference: row.external_reference }),
  });
  return Object.freeze({
    effectId: parseEffectId(row.effect_id),
    stageExecutionId: parseStageExecutionId(row.stage_execution_id),
    providerStep: row.provider_step,
    callId: row.call_id,
    toolName: row.tool_name,
    output: normalized.output,
    externalReference: normalized.externalReference ?? null,
    createdAt: row.created_at,
  });
}

export function agentToolEffectIdentity(stageExecutionId: StageExecutionId, providerStep: number, callId: string): { readonly effectId: EffectId; readonly effectKey: string } {
  const stage = parseStageExecutionId(stageExecutionId);
  const step = validateStep(providerStep);
  const call = validateCallId(callId);
  const digest = createHash("sha256").update(`${stage}:provider-step:${step}:tool-call:${call}`, "utf8").digest("hex");
  return Object.freeze({
    effectId: parseEffectId(`effect_tool_${digest.slice(0, 40)}`),
    effectKey: `agent-tool:${digest.slice(0, 48)}`,
  });
}

function toolIntent(stageExecutionId: StageExecutionId, providerStep: number, call: ProviderToolCallLike, authorityScope: string): JsonObject {
  return {
    kind: "agent_tool_call",
    stageExecutionId,
    providerStep,
    callId: call.id,
    toolName: call.name,
    authorityScope,
    input: call.input,
  };
}

export class PostgresToolRuntime {
  private readonly effects: PostgresEffectLedger;

  constructor(private readonly pool: Pool, private readonly connectors: ConnectorRegistry) {
    this.effects = new PostgresEffectLedger(pool);
  }

  async getToolResult(effectId: EffectId): Promise<DurableToolResult | null> {
    try {
      const result = await this.pool.query<ToolResultRow>(
        `SELECT effect_id, stage_execution_id, provider_step, call_id, tool_name, output, external_reference, created_at
         FROM agent_tool_results WHERE effect_id = $1`,
        [parseEffectId(effectId)],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapToolResult(row);
    } catch (error) {
      if (error instanceof ToolRuntimeError || error instanceof ConnectorInvocationError) throw error;
      throw new ToolRuntimeError("TRANSACTION", "Failed to read durable tool result.", { cause: error });
    }
  }

  private async persistToolResult(input: {
    readonly effectId: EffectId;
    readonly stageExecutionId: StageExecutionId;
    readonly providerStep: number;
    readonly callId: string;
    readonly toolName: string;
    readonly result: ConnectorResult;
  }): Promise<DurableToolResult> {
    try {
      const inserted = await this.pool.query<ToolResultRow>(
        `INSERT INTO agent_tool_results (effect_id, stage_execution_id, provider_step, call_id, tool_name, output, external_reference)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (effect_id) DO NOTHING
         RETURNING effect_id, stage_execution_id, provider_step, call_id, tool_name, output, external_reference, created_at`,
        [input.effectId, input.stageExecutionId, input.providerStep, input.callId, input.toolName, JSON.stringify(input.result.output), input.result.externalReference ?? null],
      );
      const row = inserted.rows[0];
      if (row !== undefined) return mapToolResult(row);
      const existing = await this.getToolResult(input.effectId);
      if (existing === null) throw new ToolRuntimeError("INTEGRITY", "Tool result conflict produced no durable row.");
      if (
        existing.stageExecutionId !== input.stageExecutionId ||
        existing.providerStep !== input.providerStep ||
        existing.callId !== input.callId ||
        existing.toolName !== input.toolName ||
        canonicalJson(existing.output) !== canonicalJson(input.result.output) ||
        existing.externalReference !== (input.result.externalReference ?? null)
      ) {
        throw new ToolRuntimeError("INTEGRITY", "Tool result identity already maps to different immutable evidence.");
      }
      return existing;
    } catch (error) {
      if (error instanceof ToolRuntimeError || error instanceof ConnectorInvocationError) throw error;
      throw new ToolRuntimeError("TRANSACTION", "Failed to persist durable tool result.", { cause: error });
    }
  }

  async executeToolCall(input: ExecuteToolCallInput): Promise<ToolExecutionResult> {
    const executionId = parseExecutionId(input.executionId);
    const stageExecutionId = parseStageExecutionId(input.stageExecutionId);
    const step = validateStep(input.providerStep);
    validateCallId(input.call.id);
    const connector = this.connectors.require(input.call.name);
    const identity = agentToolEffectIdentity(stageExecutionId, step, input.call.id);

    let effect: DurableEffectRecord;
    try {
      effect = (await this.effects.planEffect({
        id: identity.effectId,
        executionId,
        stageExecutionId,
        effectKey: identity.effectKey,
        intent: toolIntent(stageExecutionId, step, input.call, connector.authorityScope),
      })).effect;
    } catch (error) {
      throw new ToolRuntimeError("INTEGRITY", "Tool Effect planning failed.", { cause: error });
    }

    const durable = await this.getToolResult(identity.effectId);
    if (durable !== null) {
      if (effect.state === "CLAIMED") {
        if (!input.recovered) throw new ToolRuntimeError("INTEGRITY", "Durable tool result exists for a claimed Effect without worker recovery.");
        effect = (await this.effects.completeEffect(identity.effectId, {
          outcome: "SUCCEEDED",
          resolutionCode: "tool_result_recovered",
          ...(durable.externalReference === null ? {} : { externalReference: durable.externalReference }),
        })).effect;
      } else if (effect.state !== "SUCCEEDED") {
        throw new ToolRuntimeError("INTEGRITY", `Durable tool result is inconsistent with Effect state ${effect.state}.`);
      }
      return Object.freeze({ effect, result: durable });
    }

    if (effect.state === "CLAIMED") {
      if (input.recovered) {
        effect = (await this.effects.completeEffect(identity.effectId, { outcome: "AMBIGUOUS", resolutionCode: "orphaned_tool_call" })).effect;
        throw new ToolRuntimeError("RECONCILIATION_REQUIRED", `Recovered tool call ${effect.id} has an unknown outcome.`);
      }
      throw new ToolRuntimeError("INTEGRITY", "Tool Effect is in flight without worker recovery.");
    }

    try {
      const claim = await this.effects.claimEffect(identity.effectId);
      if (claim.disposition === "SUPPRESSED_SUCCEEDED") throw new ToolRuntimeError("INTEGRITY", "Tool Effect reports success but no durable tool result exists.");
    } catch (error) {
      if (error instanceof ToolRuntimeError) throw error;
      if (error instanceof EffectLedgerError && error.code === "RECONCILIATION_REQUIRED") {
        throw new ToolRuntimeError("RECONCILIATION_REQUIRED", "Tool Effect requires reconciliation before replay.", { cause: error });
      }
      throw new ToolRuntimeError("KNOWN_FAILURE", "Tool Effect is not executable.", { cause: error });
    }

    let normalized: ConnectorResult;
    try {
      normalized = normalizeConnectorResult(await connector.execute(input.call.input, {
        effectKey: identity.effectKey,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }));
    } catch (error) {
      const known = error instanceof ConnectorInvocationError && error.classification === "KNOWN_FAILURE";
      const rawCode = error instanceof ConnectorInvocationError ? error.connectorCode : undefined;
      const resolutionCode = typeof rawCode === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(rawCode)
        ? rawCode
        : known ? "connector_known_failure" : "connector_exception_unknown";
      try {
        await this.effects.completeEffect(identity.effectId, { outcome: known ? "FAILED" : "AMBIGUOUS", resolutionCode });
      } catch {
        // The connector failure remains primary; durable Effect state remains visible.
      }
      if (known) throw new ToolRuntimeError("KNOWN_FAILURE", "Connector reported a known failure.", { cause: error });
      throw new ToolRuntimeError("AMBIGUOUS", "Connector call failed with an unknown remote outcome.", { cause: error });
    }

    let result: DurableToolResult;
    try {
      result = await this.persistToolResult({
        effectId: identity.effectId,
        stageExecutionId,
        providerStep: step,
        callId: input.call.id,
        toolName: input.call.name,
        result: normalized,
      });
      effect = (await this.effects.completeEffect(identity.effectId, {
        outcome: "SUCCEEDED",
        resolutionCode: "tool_result_persisted",
        ...(result.externalReference === null ? {} : { externalReference: result.externalReference }),
      })).effect;
    } catch (error) {
      try {
        const snapshot = await this.effects.getEffect(identity.effectId);
        if (snapshot?.effect.state === "CLAIMED") {
          await this.effects.completeEffect(identity.effectId, { outcome: "AMBIGUOUS", resolutionCode: "tool_result_persistence_failed" });
        }
      } catch {
        // Recovery can quarantine any remaining CLAIMED effect.
      }
      throw new ToolRuntimeError("RECONCILIATION_REQUIRED", "Connector returned but durable closure failed; replay is unsafe.", { cause: error });
    }

    return Object.freeze({ effect, result });
  }
}
