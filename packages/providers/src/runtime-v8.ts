import {
  parseAttemptId,
  parseEffectId,
  parseExecutionId,
  parseStageExecutionId,
  validateFlowDefinition,
  type AgentStage,
  type EffectId,
  type ExecutionId,
  type JsonObject,
  type StageExecutionId,
} from "@aegisflow/contracts";
import {
  ConnectorRegistry,
  PostgresToolRuntime,
  ToolRuntimeError,
  type DurableToolResult,
} from "@aegisflow/connectors";
import {
  completeSucceededEffectInTransaction,
  EffectLedgerError,
  PostgresEffectLedger,
  type DurableEffectRecord,
  type EffectClaimResult,
} from "@aegisflow/effects";
import { PostgresWorkerQueue, type ClaimAcquisition } from "@aegisflow/queue";
import type { Pool, PoolClient } from "pg";
import { AgentRuntimeError } from "./errors.js";
import {
  normalizeProviderResponse,
  ProviderInvocationError,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderRegistry,
} from "./provider.js";
import {
  PostgresAgentRuntime as LegacyAgentRuntime,
  agentProviderEffectIdentity,
  type AgentStageRunResult as LegacyAgentStageRunResult,
  type DurableProviderResult,
  type RunAgentStageInput,
} from "./runtime.js";
import { assertAgentOutputMatchesSchema, validateAgentOutputSchema } from "./schema.js";
import type { ProviderToolResult } from "./tool-context.js";

export { agentProviderEffectIdentity } from "./runtime.js";
export type { DurableProviderResult, RunAgentStageInput } from "./runtime.js";

interface AgentContextRow {
  readonly execution_id: string;
  readonly stage_id: string;
  readonly definition: unknown;
}

interface ProviderResultRow {
  readonly effect_id: string;
  readonly stage_execution_id: string;
  readonly step: number;
  readonly provider: string;
  readonly response: unknown;
  readonly provider_reference: string | null;
  readonly created_at: Date;
}

export type AgentStageRunResult = LegacyAgentStageRunResult & {
  readonly toolResults?: readonly DurableToolResult[];
};

function usageJson(usage: ProviderResponse["usage"]): JsonObject | undefined {
  if (usage === undefined) return undefined;
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  };
}

function responseJson(response: ProviderResponse): JsonObject {
  const usage = usageJson(response.usage);
  if (response.kind === "final") {
    return {
      kind: "final",
      output: response.output,
      ...(response.providerReference === undefined ? {} : { providerReference: response.providerReference }),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  return {
    kind: "tool_calls",
    toolCalls: response.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
    ...(response.providerReference === undefined ? {} : { providerReference: response.providerReference }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new AgentRuntimeError("INTEGRITY", "Durable provider evidence contains a non-JSON value.");
}

function mapProviderResult(row: ProviderResultRow): DurableProviderResult {
  const response = normalizeProviderResponse(row.response);
  const responseReference = response.providerReference ?? null;
  if (responseReference !== row.provider_reference) {
    throw new AgentRuntimeError(
      "INTEGRITY",
      "Stored provider reference disagrees with the normalized provider response.",
    );
  }
  return Object.freeze({
    effectId: parseEffectId(row.effect_id),
    stageExecutionId: parseStageExecutionId(row.stage_execution_id),
    step: row.step,
    provider: row.provider,
    response,
    providerReference: row.provider_reference,
    createdAt: row.created_at,
  });
}

function providerIntent(
  stageExecutionId: StageExecutionId,
  stage: AgentStage,
  step: number,
  toolResults: readonly ProviderToolResult[],
): JsonObject {
  return {
    kind: "agent_provider_call",
    stageExecutionId,
    provider: stage.provider,
    instruction: stage.instruction,
    allowedTools: [...stage.allowedTools],
    maxSteps: stage.maxSteps,
    step,
    ...(toolResults.length === 0 ? {} : { toolResults: toolResults.map((item) => ({ ...item })) }),
    ...(stage.outputSchema === undefined ? {} : { outputSchema: stage.outputSchema }),
  };
}

function providerRequest(
  stage: AgentStage,
  step: number,
  toolResults: readonly ProviderToolResult[],
): ProviderRequest {
  return Object.freeze({
    provider: stage.provider,
    instruction: stage.instruction,
    allowedTools: Object.freeze([...stage.allowedTools]),
    maxSteps: stage.maxSteps,
    step,
    ...(toolResults.length === 0
      ? {}
      : { toolResults: Object.freeze(toolResults.map((item) => Object.freeze({ ...item }))) }),
    ...(stage.outputSchema === undefined ? {} : { outputSchema: stage.outputSchema }),
  });
}

function providerFailure(error: unknown): { readonly known: boolean; readonly code: string } {
  const malformed = error instanceof AgentRuntimeError && error.code === "MALFORMED_PROVIDER_RESPONSE";
  const known = malformed || (error instanceof ProviderInvocationError && error.classification === "KNOWN_FAILURE");
  const raw = error instanceof ProviderInvocationError ? error.providerCode : undefined;
  return {
    known,
    code:
      typeof raw === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(raw)
        ? raw
        : malformed
          ? "malformed_provider_response"
          : known
            ? "provider_known_failure"
            : "provider_exception_unknown",
  };
}

export class PostgresAgentRuntime {
  private readonly legacy: LegacyAgentRuntime;
  private readonly queue: PostgresWorkerQueue;
  private readonly effects: PostgresEffectLedger;
  private readonly tools: PostgresToolRuntime | null;
  private readonly connectors: ConnectorRegistry | null;

  constructor(
    private readonly pool: Pool,
    private readonly providers: ProviderRegistry,
    connectors?: ConnectorRegistry,
  ) {
    this.legacy = new LegacyAgentRuntime(pool, providers);
    this.queue = new PostgresWorkerQueue(pool);
    this.effects = new PostgresEffectLedger(pool);
    this.connectors = connectors ?? null;
    this.tools = connectors === undefined ? null : new PostgresToolRuntime(pool, connectors);
  }

  async getProviderResult(effectId: EffectId): Promise<DurableProviderResult | null> {
    return this.legacy.getProviderResult(parseEffectId(effectId));
  }

  private async loadAgentContext(stageExecutionId: StageExecutionId): Promise<{
    readonly executionId: ExecutionId;
    readonly stage: AgentStage;
  }> {
    try {
      const result = await this.pool.query<AgentContextRow>(
        `SELECT sx.execution_id, sx.stage_id, fv.definition
           FROM stage_executions sx
           JOIN executions e ON e.id = sx.execution_id
           JOIN flow_versions fv ON fv.id = e.flow_version_id AND fv.flow_id = e.flow_id
          WHERE sx.id = $1`,
        [stageExecutionId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new AgentRuntimeError("NOT_AGENT_STAGE", `StageExecution ${stageExecutionId} does not exist.`);
      const definition = validateFlowDefinition(row.definition);
      const stage = definition.stages.find((candidate) => candidate.id === row.stage_id);
      if (stage === undefined || stage.type !== "agent") {
        throw new AgentRuntimeError("NOT_AGENT_STAGE", `StageExecution ${stageExecutionId} is not bound to an Agent Stage.`);
      }
      if (stage.outputSchema !== undefined) validateAgentOutputSchema(stage.outputSchema);
      this.providers.require(stage.provider);
      return Object.freeze({ executionId: parseExecutionId(row.execution_id), stage });
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError("TRANSACTION", "Failed to load Agent Stage context.", { cause: error });
    }
  }

  private async persistProviderResult(
    client: PoolClient,
    input: {
      readonly stageExecutionId: StageExecutionId;
      readonly step: number;
      readonly provider: string;
      readonly response: ProviderResponse;
    },
  ): Promise<DurableProviderResult> {
    const identity = agentProviderEffectIdentity(input.stageExecutionId, input.step);
    const json = responseJson(input.response);
    try {
      const inserted = await client.query<ProviderResultRow>(
        `INSERT INTO agent_provider_results (effect_id, stage_execution_id, step, provider, response, provider_reference)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (effect_id) DO NOTHING
         RETURNING effect_id, stage_execution_id, step, provider, response, provider_reference, created_at`,
        [identity.effectId, input.stageExecutionId, input.step, input.provider, JSON.stringify(json), input.response.providerReference ?? null],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow !== undefined) return mapProviderResult(insertedRow);

      const existingResult = await client.query<ProviderResultRow>(
        `SELECT effect_id, stage_execution_id, step, provider, response, provider_reference, created_at
         FROM agent_provider_results
         WHERE effect_id = $1`,
        [identity.effectId],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow === undefined) {
        throw new AgentRuntimeError("INTEGRITY", "Provider result conflict completed without durable evidence.");
      }
      const existing = mapProviderResult(existingRow);
      if (
        existing.stageExecutionId !== input.stageExecutionId ||
        existing.step !== input.step ||
        existing.provider !== input.provider ||
        canonicalJson(responseJson(existing.response)) !== canonicalJson(json)
      ) {
        throw new AgentRuntimeError("INTEGRITY", "Provider result identity maps to different immutable evidence.");
      }
      return existing;
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError("TRANSACTION", "Failed to persist provider result.", { cause: error });
    }
  }

  private async failClaim(acquisition: ClaimAcquisition, input: RunAgentStageInput): Promise<void> {
    try {
      await this.queue.completeClaim({
        stageExecutionId: input.stageExecutionId,
        attemptId: input.attemptId,
        ownerId: input.ownerId,
        generation: acquisition.claim.generation,
        event: "FAIL",
      });
    } catch {
      // PR4 fencing makes the lost claim non-authoritative.
    }
  }

  private async heartbeat(acquisition: ClaimAcquisition, input: RunAgentStageInput): Promise<void> {
    const live = await this.queue.heartbeatClaim({
      stageExecutionId: input.stageExecutionId,
      attemptId: input.attemptId,
      ownerId: input.ownerId,
      generation: acquisition.claim.generation,
      leaseMs: input.leaseMs,
    });
    if (live === null) throw new AgentRuntimeError("STALE_AUTHORITY", "Worker Claim authority was lost during Agent execution.");
  }

  private async quarantineProviderEffect(
    effectId: EffectId,
    resolutionCode: string,
    externalReference?: string,
  ): Promise<void> {
    try {
      const snapshot = await this.effects.getEffect(effectId);
      if (snapshot?.effect.state !== "CLAIMED") return;
      await this.effects.completeEffect(effectId, {
        outcome: "AMBIGUOUS",
        resolutionCode,
        ...(externalReference === undefined ? {} : { externalReference }),
      });
    } catch {
      // A concurrent cancellation/recovery may already have terminalized the Effect.
    }
  }

  private async persistProviderResultAndCloseEffect(input: {
    readonly stageExecutionId: StageExecutionId;
    readonly step: number;
    readonly provider: string;
    readonly response: ProviderResponse;
  }): Promise<{ readonly effect: DurableEffectRecord; readonly providerResult: DurableProviderResult }> {
    const identity = agentProviderEffectIdentity(input.stageExecutionId, input.step);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const providerResult = await this.persistProviderResult(client, input);
      const effect = await completeSucceededEffectInTransaction(client, identity.effectId, {
        resolutionCode: "provider_response_persisted",
        ...(providerResult.providerReference === null
          ? {}
          : { externalReference: providerResult.providerReference }),
      });
      await client.query("COMMIT");
      return Object.freeze({ effect, providerResult });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the primary transaction failure.
      }

      // If COMMIT itself had an unknown transport outcome, trust durable readback.
      try {
        const [snapshot, durable] = await Promise.all([
          this.effects.getEffect(identity.effectId),
          this.legacy.getProviderResult(identity.effectId),
        ]);
        if (snapshot?.effect.state === "SUCCEEDED" && durable !== null) {
          return Object.freeze({ effect: snapshot.effect, providerResult: durable });
        }
      } catch {
        // Fall through to quarantine below.
      }

      await this.quarantineProviderEffect(
        identity.effectId,
        "provider_local_commit_failed",
        input.response.providerReference,
      );
      throw new AgentRuntimeError(
        "TRANSACTION",
        "Provider response could not be atomically persisted and closed.",
        { cause: error },
      );
    } finally {
      client.release();
    }
  }

  private async runProviderStep(input: {
    readonly context: { readonly executionId: ExecutionId; readonly stage: AgentStage };
    readonly stageExecutionId: StageExecutionId;
    readonly acquisition: ClaimAcquisition;
    readonly runInput: RunAgentStageInput;
    readonly step: number;
    readonly toolResults: readonly ProviderToolResult[];
  }): Promise<{ readonly effect: DurableEffectRecord; readonly providerResult: DurableProviderResult }> {
    const identity = agentProviderEffectIdentity(input.stageExecutionId, input.step);
    let effect: DurableEffectRecord;
    try {
      effect = (await this.effects.planEffect({
        id: identity.effectId,
        executionId: input.context.executionId,
        stageExecutionId: input.stageExecutionId,
        effectKey: identity.effectKey,
        intent: providerIntent(input.stageExecutionId, input.context.stage, input.step, input.toolResults),
      })).effect;
    } catch (error) {
      throw new AgentRuntimeError("INTEGRITY", "Agent provider Effect planning failed.", { cause: error });
    }

    const durable = await this.legacy.getProviderResult(identity.effectId);
    if (durable !== null) {
      if (effect.state === "CLAIMED") {
        if (!input.acquisition.recovered) throw new AgentRuntimeError("INTEGRITY", "Durable provider result exists for a claimed Effect without recovery.");
        effect = (await this.effects.completeEffect(identity.effectId, {
          outcome: "SUCCEEDED",
          resolutionCode: "provider_result_recovered",
          ...(durable.providerReference === null ? {} : { externalReference: durable.providerReference }),
        })).effect;
      } else if (effect.state !== "SUCCEEDED") {
        throw new AgentRuntimeError("INTEGRITY", `Durable provider result is inconsistent with Effect state ${effect.state}.`);
      }
      return Object.freeze({ effect, providerResult: durable });
    }

    if (effect.state === "CLAIMED") {
      if (input.acquisition.recovered) {
        effect = (await this.effects.completeEffect(identity.effectId, {
          outcome: "AMBIGUOUS",
          resolutionCode: "orphaned_provider_call",
        })).effect;
        throw new AgentRuntimeError("PROVIDER_RECONCILIATION_REQUIRED", `Recovered provider call ${effect.id} requires reconciliation.`);
      }
      throw new AgentRuntimeError("INTEGRITY", "Provider Effect is in flight without worker recovery.");
    }

    let disposition: EffectClaimResult;
    try {
      disposition = await this.effects.claimEffect(identity.effectId);
    } catch (error) {
      if (error instanceof EffectLedgerError && error.code === "RECONCILIATION_REQUIRED") {
        throw new AgentRuntimeError("PROVIDER_RECONCILIATION_REQUIRED", "Provider Effect requires reconciliation before progress.", { cause: error });
      }
      throw new AgentRuntimeError("PROVIDER_FAILED", "Provider Effect is not executable.", { cause: error });
    }
    if (disposition.disposition === "SUPPRESSED_SUCCEEDED") {
      throw new AgentRuntimeError("INTEGRITY", "Provider Effect reports success but no durable result exists.");
    }

    let normalized: ProviderResponse;
    try {
      normalized = normalizeProviderResponse(
        await this.providers.require(input.context.stage.provider).generate(
          providerRequest(input.context.stage, input.step, input.toolResults),
          {},
        ),
      );
    } catch (error) {
      const failure = providerFailure(error);
      try {
        await this.effects.completeEffect(identity.effectId, {
          outcome: failure.known ? "FAILED" : "AMBIGUOUS",
          resolutionCode: failure.code,
        });
      } catch {
        // The provider failure remains primary.
      }
      if (error instanceof AgentRuntimeError && error.code === "MALFORMED_PROVIDER_RESPONSE") throw error;
      if (failure.known) throw new AgentRuntimeError("PROVIDER_FAILED", "Provider reported a known failure.", { cause: error });
      throw new AgentRuntimeError("PROVIDER_AMBIGUOUS", "Provider call has an unknown external outcome.", { cause: error });
    }

    try {
      await this.heartbeat(input.acquisition, input.runInput);
    } catch (error) {
      await this.quarantineProviderEffect(
        identity.effectId,
        "worker_authority_lost",
        normalized.providerReference,
      );
      throw error;
    }

    const closed = await this.persistProviderResultAndCloseEffect({
      stageExecutionId: input.stageExecutionId,
      step: input.step,
      provider: input.context.stage.provider,
      response: normalized,
    });
    return Object.freeze(closed);
  }

  async runAgentStage(input: RunAgentStageInput): Promise<AgentStageRunResult> {
    if (this.tools === null || this.connectors === null) return this.legacy.runAgentStage(input);

    const stageExecutionId = parseStageExecutionId(input.stageExecutionId);
    const attemptId = parseAttemptId(input.attemptId);
    const context = await this.loadAgentContext(stageExecutionId);
    let acquisition: ClaimAcquisition | null;
    try {
      acquisition = await this.queue.claimStage({
        stageExecutionId,
        attemptId,
        ownerId: input.ownerId,
        leaseMs: input.leaseMs,
      });
    } catch (error) {
      throw new AgentRuntimeError("STALE_AUTHORITY", "Agent Stage could not acquire worker authority.", { cause: error });
    }
    if (acquisition === null) throw new AgentRuntimeError("CLAIM_BUSY", "Agent Stage already has an unexpired worker Claim.");

    const allowed = new Set(context.stage.allowedTools);
    const providerToolResults: ProviderToolResult[] = [];
    const durableTools: DurableToolResult[] = [];

    try {
      for (let step = 1; step <= context.stage.maxSteps; step += 1) {
        const current = await this.runProviderStep({
          context,
          stageExecutionId,
          acquisition,
          runInput: input,
          step,
          toolResults: providerToolResults,
        });

        if (current.providerResult.response.kind === "final") {
          if (context.stage.outputSchema !== undefined) {
            assertAgentOutputMatchesSchema(current.providerResult.response.output, context.stage.outputSchema);
          }
          await this.queue.completeClaim({
            stageExecutionId,
            attemptId,
            ownerId: input.ownerId,
            generation: acquisition.claim.generation,
            event: "SUCCEED",
          });
          return Object.freeze({
            acquisition,
            effect: current.effect,
            providerResult: current.providerResult,
            toolResults: Object.freeze([...durableTools]),
          });
        }

        for (const call of current.providerResult.response.toolCalls) {
          if (!allowed.has(call.name)) {
            throw new AgentRuntimeError("TOOL_NOT_ALLOWED", `Provider requested tool '${call.name}' outside the immutable allow-list.`);
          }
          try {
            this.connectors.require(call.name);
          } catch (error) {
            throw new AgentRuntimeError("TOOL_EXECUTION_UNAVAILABLE", `Tool '${call.name}' has no registered connector.`, { cause: error });
          }
        }
        if (step >= context.stage.maxSteps) {
          throw new AgentRuntimeError("TOOL_EXECUTION_UNAVAILABLE", "Provider requested another tool after the Agent Stage exhausted maxSteps.");
        }

        for (const call of current.providerResult.response.toolCalls) {
          await this.heartbeat(acquisition, input);
          let tool;
          try {
            tool = await this.tools.executeToolCall({
              executionId: context.executionId,
              stageExecutionId,
              providerStep: step,
              call,
              recovered: acquisition.recovered,
            });
          } catch (error) {
            if (error instanceof ToolRuntimeError) {
              if (error.code === "CONNECTOR_NOT_FOUND") {
                throw new AgentRuntimeError("TOOL_EXECUTION_UNAVAILABLE", `Tool '${call.name}' has no registered connector.`, { cause: error });
              }
              if (error.code === "RECONCILIATION_REQUIRED" || error.code === "AMBIGUOUS") {
                throw new AgentRuntimeError("PROVIDER_RECONCILIATION_REQUIRED", `Tool '${call.name}' requires reconciliation.`, { cause: error });
              }
              throw new AgentRuntimeError("PROVIDER_FAILED", `Tool '${call.name}' failed.`, { cause: error });
            }
            throw error;
          }
          await this.heartbeat(acquisition, input);
          durableTools.push(tool.result);
          providerToolResults.push(Object.freeze({ callId: call.id, name: call.name, output: tool.result.output }));
        }
      }
      throw new AgentRuntimeError("INTEGRITY", "Agent loop terminated without a final response.");
    } catch (error) {
      await this.failClaim(acquisition, input);
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError("TRANSACTION", "PR8 Agent execution failed.", { cause: error });
    }
  }
}
