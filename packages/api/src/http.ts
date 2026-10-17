import {
  ContractError,
  parseEffectId,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseGateId,
} from "@aegisflow/contracts";
import { EffectLedgerError } from "@aegisflow/effects";
import { GateLedgerError } from "@aegisflow/gates";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ControlApiError } from "./errors.js";
import {
  listOperatorEffects,
  listOperatorExecutions,
  listOperatorFlows,
  listPendingOperatorGates,
} from "./operator-views.js";
import type { PostgresControlService } from "./control-service.js";

const MAX_BODY_BYTES = 1_048_576;

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new ControlApiError("INVALID_INPUT", "Request body exceeds 1 MiB.");
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new ControlApiError("INVALID_INPUT", "Request body is not valid JSON.", { cause: error });
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlApiError("INVALID_INPUT", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlApiError("INVALID_INPUT", `${label} must be a non-empty string.`);
  }
  return value;
}

function idempotencyKey(request: IncomingMessage): string {
  const value = request.headers["idempotency-key"];
  if (Array.isArray(value)) throw new ControlApiError("INVALID_INPUT", "Idempotency-Key must be singular.");
  if (value === undefined) throw new ControlApiError("INVALID_INPUT", "Idempotency-Key header is required.");
  return value;
}

function routePath(request: IncomingMessage): string[] {
  const url = new URL(request.url ?? "/", "http://aegisflow.local");
  return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function statusFor(error: unknown): number {
  const code =
    error instanceof ControlApiError || error instanceof GateLedgerError ||
    error instanceof EffectLedgerError || error instanceof ContractError
      ? error.code : undefined;
  if (code === "NOT_FOUND") return 404;
  if (["CONFLICT", "IDEMPOTENCY_CONFLICT", "TERMINAL_EXECUTION", "KEY_CONFLICT", "STALE_STATE",
    "DECISION_CONFLICT", "PROTECTED", "IN_FLIGHT", "RECONCILIATION_REQUIRED", "KNOWN_FAILED"].includes(code ?? "")) return 409;
  if (["INVALID_INPUT", "INVALID_ID", "INVALID_FLOW", "INVALID_STAGE_CONFIG", "UNKNOWN_STAGE_KIND", "NOT_GATE_STAGE"].includes(code ?? "")) return 400;
  return 500;
}

function errorBody(error: unknown): ErrorBody {
  const code = typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code : "INTERNAL";
  const message = error instanceof Error && statusFor(error) < 500 ? error.message : "Internal server error.";
  return { error: { code, message } };
}

export function createControlServer(service: PostgresControlService): Server {
  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const parts = routePath(request);

      if (method === "GET" && parts.length === 2 && parts[0] === "health" && parts[1] === "live") {
        sendJson(response, 200, { status: "ok" }); return;
      }
      if (method === "GET" && parts.length === 2 && parts[0] === "health" && parts[1] === "ready") {
        await service.pool.query("SELECT 1"); sendJson(response, 200, { status: "ready" }); return;
      }
      if (method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "flows") {
        sendJson(response, 200, await listOperatorFlows(service.pool)); return;
      }
      if (method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "flows") {
        const body = requireRecord(await readJson(request));
        const result = await service.registerFlow(body.definition);
        sendJson(response, result.created ? 201 : 200, result); return;
      }
      if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "flows") {
        sendJson(response, 200, await service.inspectFlow(parseFlowId(parts[2]))); return;
      }
      if (method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "executions") {
        sendJson(response, 200, await listOperatorExecutions(service.pool)); return;
      }
      if (method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "executions") {
        const body = requireRecord(await readJson(request));
        const flowId = parseFlowId(body.flowId);
        const flowVersionId = body.flowVersionId === undefined ? undefined : parseFlowVersionId(body.flowVersionId);
        const input = flowVersionId === undefined
          ? { flowId, idempotencyKey: idempotencyKey(request) }
          : { flowId, flowVersionId, idempotencyKey: idempotencyKey(request) };
        const result = await service.startExecution(input);
        sendJson(response, result.replayed ? 200 : 201, result); return;
      }
      if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "executions") {
        const executionId = parseExecutionId(parts[2]);
        if (method === "GET" && parts.length === 3) { sendJson(response, 200, await service.inspectExecution(executionId)); return; }
        if (method === "POST" && parts.length === 4 && parts[3] === "cancel") { sendJson(response, 200, await service.cancelExecution(executionId)); return; }
        if (method === "GET" && parts.length === 4 && parts[3] === "events") { sendJson(response, 200, { events: await service.listEvents(executionId) }); return; }
        if (method === "GET" && parts.length === 4 && parts[3] === "effects") { sendJson(response, 200, { effects: await service.listEffects(executionId) }); return; }
        if (method === "GET" && parts.length === 4 && parts[3] === "gates") { sendJson(response, 200, { gates: await service.listGates(executionId) }); return; }
        if (method === "GET" && parts.length === 4 && parts[3] === "signals") { sendJson(response, 200, { signals: await service.listSignals(executionId) }); return; }
        if (method === "POST" && parts.length === 5 && parts[3] === "signals") {
          const body = requireRecord(await readJson(request));
          const result = await service.sendSignal(executionId, parts[4] ?? "", idempotencyKey(request), body.payload ?? {});
          sendJson(response, result.replayed ? 200 : 201, result); return;
        }
      }
      if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "gates" && parts[2] === "pending") {
        sendJson(response, 200, await listPendingOperatorGates(service.pool)); return;
      }
      if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "gates") {
        const gateId = parseGateId(parts[2]);
        if (method === "GET" && parts.length === 3) { sendJson(response, 200, await service.getGate(gateId)); return; }
        if (method === "POST" && parts.length === 4) {
          const operation = parts[3];
          if (operation !== "approve" && operation !== "reject") { sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Route not found." } }); return; }
          const body = requireRecord(await readJson(request));
          const actorId = requireString(body.actorId, "actorId");
          sendJson(response, 200, await service.resolveGate(gateId, operation === "approve" ? "APPROVE" : "REJECT", actorId, body.evidence ?? {})); return;
        }
      }
      if (method === "GET" && parts.length === 2 && parts[0] === "v1" && parts[1] === "effects") {
        sendJson(response, 200, await listOperatorEffects(service.pool)); return;
      }
      if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "effects") {
        const effectId = parseEffectId(parts[2]);
        if (method === "GET" && parts.length === 3) { sendJson(response, 200, await service.getEffect(effectId)); return; }
        if (method === "POST" && parts.length === 4 && parts[3] === "reconcile") {
          const body = requireRecord(await readJson(request));
          const decisionText = requireString(body.decision, "decision");
          if (decisionText !== "CONFIRMED_SUCCEEDED" && decisionText !== "CONFIRMED_FAILED") throw new ControlApiError("INVALID_INPUT", "decision must be CONFIRMED_SUCCEEDED or CONFIRMED_FAILED.");
          const decision: "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED" = decisionText;
          const reconciledBy = requireString(body.reconciledBy, "reconciledBy");
          const externalReference = body.externalReference;
          if (externalReference !== undefined && typeof externalReference !== "string") throw new ControlApiError("INVALID_INPUT", "externalReference must be a string when supplied.");
          const input = externalReference === undefined ? { decision, reconciledBy } : { decision, reconciledBy, externalReference };
          sendJson(response, 200, await service.reconcileEffect(effectId, input)); return;
        }
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Route not found." } });
    } catch (error) {
      sendJson(response, statusFor(error), errorBody(error));
    }
  });
}
