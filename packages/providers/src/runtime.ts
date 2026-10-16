import {
  parseAttemptId,
  parseEffectId,
  parseExecutionId,
  parseStageExecutionId,
  validateFlowDefinition,
  type AgentStage,
  type AttemptId,
  type EffectId,
  type ExecutionId,
  type JsonObject,
  type StageExecutionId,
} from "@aegisflow/contracts";
import {
  EffectLedgerError,
  PostgresEffectLedger,
  type DurableEffectRecord,
  type EffectClaimResult,
} from "@aegisflow/effects";
import { PostgresWorkerQueue, QueueError, type ClaimAcquisition } from "@aegisflow/queue";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { AgentRuntimeError } from "./errors.js";
import {
  normalizeProviderResponse,
  ProviderInvocationError,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderRegistry,
} from "./provider.js";
import { assertAgentOutputMatchesSchema, validateAgentOutputSchema } from "./schema.js";

const MAX_STEP = 32;

interface AgentContextRow {
  readonly execution_id: string;
  readonly stage_id: string;
  readonly stage_state: string;
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

export interface DurableProviderResult {
  readonly effectId: EffectId;
  readonly stageExecutionId: StageExecutionId;
  readonly step: number;
  readonly provider: string;
  readonly response: ProviderResponse;
  readonly providerReference: string | null;
  readonly createdAt: Date;
}

export interface AgentStageRunResult {
  readonly acquisition: ClaimAcquisition;
  readonly effect: DurableEffectRecord;
  readonly providerResult: DurableProviderResult;
}

export interface RunAgentStageInput {
  readonly stageExecutionId: StageExecutionId;
  readonly attemptId: AttemptId;
  readonly ownerId: string;
  readonly leaseMs: number;
}

function usageJson(usage: ProviderResponse["usage"]): JsonObject | undefined {
  if (usage === undefined) return undefined;
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  };
}

function toProviderResponseJson(response: ProviderResponse): JsonObject {
  const usage = usageJson(response.usage);
  if (response.kind === "final") {
    return {
      kind: "final",
      output: response.output,
      ...(response.providerReference === undefined
        ? {}
        : { providerReference: response.providerReference }),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  return {
    kind: "tool_calls",
    toolCalls: response.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    ...(response.providerReference === undefined
      ? {}
      : { providerReference: response.providerReference }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new AgentRuntimeError("INTEGRITY", "Durable provider evidence contains a non-JSON value.");
}

function mapProviderResult(row: ProviderResultRow): DurableProviderResult {
  const response = normalizeProviderResponse(row.response);
  const providerReference =
    row.provider_reference === null
      ? null
      : response.providerReference === row.provider_reference
        ? row.provider_reference
        : (() => {
            throw new AgentRuntimeError(
              "INTEGRITY",
              "Stored provider reference disagrees with the normalized provider response.",
            );
          })();
  return Object.freeze({
    effectId: parseEffectId(row.effect_id),
    stageExecutionId: parseStageExecutionId(row.stage_execution_id),
    step: row.step,
    provider: row.provider,
    response,
    providerReference,
    createdAt: row.created_at,
  });
}

function deterministicEffectId(stageExecutionId: StageExecutionId, step: number): EffectId {
  const digest = createHash("sha256")
    .update(`${stageExecutionId}:provider-step:${step}`, "utf8")
    .digest("hex")
    .slice(0, 40);
  return parseEffectId(`effect_agent_${digest}`);
}

export function agentProviderEffectIdentity(
  stageExecutionId: StageExecutionId,
  step: number,
): { readonly effectId: EffectId; readonly effectKey: string } {
  if (!Number.isSafeInteger(step) || step < 1 || step > MAX_STEP) {
    throw new AgentRuntimeError("INVALID_INPUT", `step must be an integer between 1 and ${MAX_STEP}.`);
  }
  const id = parseStageExecutionId(stageExecutionId);
  return Object.freeze({
    effectId: deterministicEffectId(id, step),
    effectKey: `agent-provider:${id}:step:${step}`,
  });
}

function providerIntent(stageExecutionId: StageExecutionId, stage: AgentStage, step: number): JsonObject {
  return {
    kind: "agent_provider_call",
    stageExecutionId,
    provider: stage.provider,
    instruction: stage.instruction,
    allowedTools: [...stage.allowedTools],
    maxSteps: stage.maxSteps,
    step,
    ...(stage.outputSchema === undefined ? {} : { outputSchema: stage.outputSchema }),
  };
}

function providerRequest(stage: AgentStage, step: number): ProviderRequest {
  return Object.freeze({
    provider: stage.provider,
    instruction: stage.instruction,
    allowedTools: Object.freeze([...stage.allowedTools]),
    maxSteps: stage.maxSteps,
    step,
    ...(stage.outputSchema === undefined ? {} : { outputSchema: stage.outputSchema }),
  });
}

export class PostgresAgentRuntime {
  private readonly queue: PostgresWorkerQueue;
  private readonly effects: PostgresEffectLedger;

  constructor(
    private readonly pool: Pool,
    private readonly providers: ProviderRegistry,
  ) {
    this.queue = new PostgresWorkerQueue(pool);
    this.effects = new PostgresEffectLedger(pool);
  }

  private async loadAgentContext(stageExecutionId: StageExecutionId): Promise<{
    readonly executionId: ExecutionId;
    readonly stage: AgentStage;
  }> {
    try {
      const result = await this.pool.query<AgentContextRow>(
        `SELECT sx.execution_id, sx.stage_id, sx.state AS stage_state, fv.definition
         FROM stage_executions sx
         JOIN executions e ON e.id = sx.execution_id
         JOIN flow_versions fv ON fv.id = e.flow_version_id AND fv.flow_id = e.flow_id
         WHERE sx.id = $1`,
        [stageExecutionId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new AgentRuntimeError(
          "NOT_AGENT_STAGE",
          `StageExecution ${stageExecutionId} does not exist.`,
        );
      }
      const definition = validateFlowDefinition(row.definition);
      const stage = definition.stages.find((candidate) => candidate.id === row.stage_id);
      if (stage === undefined || stage.type !== "agent") {
        throw new AgentRuntimeError(
          "NOT_AGENT_STAGE",
          `StageExecution ${stageExecutionId} is not bound to an Agent Stage.`,
        );
      }
      if (stage.outputSchema !== undefined) validateAgentOutputSchema(stage.outputSchema);
      this.providers.require(stage.provider);
      return Object.freeze({ executionId: parseExecutionId(row.execution_id), stage });
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError("TRANSACTION", "Failed to load Agent Stage context.", {
        cause: error,
      });
    }
  }

  async getProviderResult(effectId: EffectId): Promise<DurableProviderResult | null> {
    try {
      const result = await this.pool.query<ProviderResultRow>(
        `SELECT effect_id, stage_execution_id, step, provider, response, provider_reference, created_at
         FROM agent_provider_results
         WHERE effect_id = $1`,
        [parseEffectId(effectId)],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapProviderResult(row);
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError("TRANSACTION", "Failed to read durable provider result.", {
        cause: error,
      });
    }
  }

  private async persistProviderResult(input: {
    readonly effectId: EffectId;
    readonly stageExecutionId: StageExecutionId;
    readonly step: number;
    readonly provider: string;
    readonly response: ProviderResponse;
  }): Promise<DurableProviderResult> {
    const responseJson = toProviderResponseJson(input.response);
    const reference = input.response.providerReference ?? null;
    try {
      const inserted = await this.pool.query<ProviderResultRow>(
        `INSERT INTO agent_provider_results (
           effect_id, stage_execution_id, step, provider, response, provider_reference
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (effect_id) DO NOTHING
         RETURNING effect_id, stage_execution_id, step, provider, response, provider_reference, created_at`,
        [
          input.effectId,
          input.stageExecutionId,
          input.step,
          input.provider,
          JSON.stringify(responseJson),
          reference,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow !== undefined) return mapProviderResult(insertedRow);

      const existing = await this.getProviderResult(input.effectId);
      if (existing === null) {
        throw new AgentRuntimeError(
          "INTEGRITY",
          "Provider result conflict completed without a durable result row.",
        );
      }
      if (
        existing.stageExecutionId !== input.stageExecutionId ||
        existing.step !== input.step ||
        existing.provider !== input.provider ||
        canonicalJson(toProviderResponseJson(existing.response)) !== canonicalJson(responseJson)
      ) {
        throw new AgentRuntimeError(
          "INTEGRITY",
          "Provider result identity already maps to different immutable evidence.",
        );
      }
      return existing;
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError("TRANSACTION", "Failed to persist provider result.", {
        cause: error,
      });
    }
  }

  private async failClaim(
    acquisition: ClaimAcquisition,
    input: RunAgentStageInput,
  ): Promise<void> {
    try {
      await this.queue.completeClaim({
        stageExecutionId: input.stageExecutionId,
        attemptId: input.attemptId,
        ownerId: input.ownerId,
        generation: acquisition.claim.generation,
        event: "FAIL",
      });
    } catch {
      // The primary failure remains authoritative. A lost/expired Claim is already fenced by PR4.
    }
  }

  private async completeFromDurableResult(
    acquisition: ClaimAcquisition,
    input: RunAgentStageInput,
    stage: AgentStage,
    effect: DurableEffectRecord,
    result: DurableProviderResult,
  ): Promise<AgentStageRunResult> {
    if (result.response.kind === "tool_calls") {
      const allowed = new Set(stage.allowedTools);
      const denied = result.response.toolCalls.find((call) => !allowed.has(call.name));
      await this.failClaim(acquisition, input);
      if (denied !== undefined) {
        throw new AgentRuntimeError(
          "TOOL_NOT_ALLOWED",
          `Provider requested tool '${denied.name}' outside the Agent Stage allow-list.`,
        );
      }
      throw new AgentRuntimeError(
        "TOOL_EXECUTION_UNAVAILABLE",
        "Provider requested an allowed tool, but connector/tool execution belongs to PR8.",
      );
    }

    if (stage.outputSchema !== undefined) {
      try {
        assertAgentOutputMatchesSchema(result.response.output, stage.outputSchema);
      } catch (error) {
        await this.failClaim(acquisition, input);
        throw error;
      }
    }

    try {
      await this.queue.completeClaim({
        stageExecutionId: input.stageExecutionId,
        attemptId: input.attemptId,
        ownerId: input.ownerId,
        generation: acquisition.claim.generation,
        event: "SUCCEED",
      });
    } catch (error) {
      throw new AgentRuntimeError(
        "STALE_AUTHORITY",
        "Provider result is durable but worker Claim authority was lost before Stage completion.",
        { cause: error },
      );
    }

    return Object.freeze({ acquisition, effect, providerResult: result });
  }

  async runAgentStage(input: RunAgentStageInput): Promise<AgentStageRunResult> {
    const stageExecutionId = parseStageExecutionId(input.stageExecutionId);
    const attemptId = parseAttemptId(input.attemptId);
    const context = await this.loadAgentContext(stageExecutionId);
    const provider = this.providers.require(context.stage.provider);

    let acquisition: ClaimAcquisition | null;
    try {
      acquisition = await this.queue.claimStage({
        stageExecutionId,
        attemptId,
        ownerId: input.ownerId,
        leaseMs: input.leaseMs,
      });
    } catch (error) {
      throw new AgentRuntimeError("STALE_AUTHORITY", "Agent Stage could not acquire worker authority.", {
        cause: error,
      });
    }
    if (acquisition === null) {
      throw new AgentRuntimeError("CLAIM_BUSY", "Agent Stage already has an unexpired worker Claim.");
    }

    const step = 1;
    const identity = agentProviderEffectIdentity(stageExecutionId, step);
    let planned: DurableEffectRecord;
    try {
      planned = (
        await this.effects.planEffect({
          id: identity.effectId,
          executionId: context.executionId,
          stageExecutionId,
          effectKey: identity.effectKey,
          intent: providerIntent(stageExecutionId, context.stage, step),
        })
      ).effect;
    } catch (error) {
      await this.failClaim(acquisition, input);
      throw new AgentRuntimeError("INTEGRITY", "Agent provider Effect planning failed.", { cause: error });
    }

    const durableBeforeClaim = await this.getProviderResult(identity.effectId);
    if (durableBeforeClaim !== null) {
      if (planned.state === "CLAIMED") {
        if (!acquisition.recovered) {
          await this.failClaim(acquisition, input);
          throw new AgentRuntimeError(
            "INTEGRITY",
            "Durable provider result exists for a claimed Effect without worker recovery.",
          );
        }
        try {
          planned = (
            await this.effects.completeEffect(identity.effectId, {
              outcome: "SUCCEEDED",
              resolutionCode: "provider_result_recovered",
              ...(durableBeforeClaim.providerReference === null
                ? {}
                : { externalReference: durableBeforeClaim.providerReference }),
            })
          ).effect;
        } catch (error) {
          await this.failClaim(acquisition, input);
          throw new AgentRuntimeError("INTEGRITY", "Could not close recovered provider Effect.", {
            cause: error,
          });
        }
      } else if (planned.state !== "SUCCEEDED") {
        await this.failClaim(acquisition, input);
        throw new AgentRuntimeError(
          "INTEGRITY",
          `Durable provider result is inconsistent with Effect state ${planned.state}.`,
        );
      }
      return this.completeFromDurableResult(
        acquisition,
        input,
        context.stage,
        planned,
        durableBeforeClaim,
      );
    }

    if (planned.state === "CLAIMED") {
      if (acquisition.recovered) {
        try {
          planned = (
            await this.effects.completeEffect(identity.effectId, {
              outcome: "AMBIGUOUS",
              resolutionCode: "orphaned_provider_call",
            })
          ).effect;
        } catch (error) {
          await this.failClaim(acquisition, input);
          throw new AgentRuntimeError(
            "PROVIDER_RECONCILIATION_REQUIRED",
            "Recovered Agent Stage found an in-flight provider Effect and could not quarantine it.",
            { cause: error },
          );
        }
        await this.failClaim(acquisition, input);
        throw new AgentRuntimeError(
          "PROVIDER_RECONCILIATION_REQUIRED",
          `Recovered provider call ${planned.id} has unknown outcome and requires reconciliation.`,
        );
      }
      await this.failClaim(acquisition, input);
      throw new AgentRuntimeError(
        "INTEGRITY",
        "Agent Stage found an in-flight provider Effect without a recovered worker Claim.",
      );
    }

    let claimDisposition: EffectClaimResult;
    try {
      claimDisposition = await this.effects.claimEffect(identity.effectId);
    } catch (error) {
      await this.failClaim(acquisition, input);
      if (error instanceof EffectLedgerError && error.code === "RECONCILIATION_REQUIRED") {
        throw new AgentRuntimeError(
          "PROVIDER_RECONCILIATION_REQUIRED",
          "Provider Effect requires reconciliation before Agent Stage progress.",
          { cause: error },
        );
      }
      throw new AgentRuntimeError("PROVIDER_FAILED", "Provider Effect is not executable.", {
        cause: error,
      });
    }

    if (claimDisposition.disposition === "SUPPRESSED_SUCCEEDED") {
      await this.failClaim(acquisition, input);
      throw new AgentRuntimeError(
        "INTEGRITY",
        "Provider Effect reports success but no durable provider result exists.",
      );
    }

    let normalized: ProviderResponse;
    try {
      normalized = normalizeProviderResponse(
        await provider.generate(providerRequest(context.stage, step), {}),
      );
    } catch (error) {
      const protocolFailure =
        error instanceof AgentRuntimeError && error.code === "MALFORMED_PROVIDER_RESPONSE";
      const known =
        protocolFailure ||
        (error instanceof ProviderInvocationError && error.classification === "KNOWN_FAILURE");
      const rawCode =
        error instanceof ProviderInvocationError ? error.providerCode : undefined;
      const resolutionCode =
        typeof rawCode === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(rawCode)
          ? rawCode
          : protocolFailure
            ? "malformed_provider_response"
            : known
              ? "provider_known_failure"
              : "provider_exception_unknown";
      try {
        await this.effects.completeEffect(identity.effectId, {
          outcome: known ? "FAILED" : "AMBIGUOUS",
          resolutionCode,
        });
      } catch {
        // The provider error remains primary; the durable Effect will remain visible for recovery.
      }
      await this.failClaim(acquisition, input);
      if (protocolFailure) throw error;
      if (known) {
        throw new AgentRuntimeError("PROVIDER_FAILED", "Provider reported a known failure.", {
          cause: error,
        });
      }
      throw new AgentRuntimeError(
        "PROVIDER_AMBIGUOUS",
        "Provider call failed without a safely known outcome.",
        { cause: error },
      );
    }

    const authority = await this.queue.heartbeatClaim({
      stageExecutionId,
      attemptId,
      ownerId: input.ownerId,
      generation: acquisition.claim.generation,
      leaseMs: input.leaseMs,
    });
    if (authority === null) {
      try {
        await this.effects.completeEffect(identity.effectId, {
          outcome: "AMBIGUOUS",
          resolutionCode: "worker_authority_lost",
          ...(normalized.providerReference === undefined
            ? {}
            : { externalReference: normalized.providerReference }),
        });
      } catch {
        // A concurrent recovery may already have quarantined the Effect.
      }
      throw new AgentRuntimeError(
        "STALE_AUTHORITY",
        "Worker Claim expired while the provider call was in flight; provider outcome was quarantined.",
      );
    }

    let durable: DurableProviderResult;
    try {
      durable = await this.persistProviderResult({
        effectId: identity.effectId,
        stageExecutionId,
        step,
        provider: context.stage.provider,
        response: normalized,
      });
      planned = (
        await this.effects.completeEffect(identity.effectId, {
          outcome: "SUCCEEDED",
          resolutionCode: "provider_response_persisted",
          ...(durable.providerReference === null
            ? {}
            : { externalReference: durable.providerReference }),
        })
      ).effect;
    } catch (error) {
      await this.failClaim(acquisition, input);
      throw new AgentRuntimeError(
        "TRANSACTION",
        "Provider response could not be durably closed before Stage completion.",
        { cause: error },
      );
    }

    return this.completeFromDurableResult(acquisition, input, context.stage, planned, durable);
  }
}
