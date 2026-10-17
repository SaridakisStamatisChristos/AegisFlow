import {
  parseEffectId,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseGateId,
  type EffectId,
  type ExecutionId,
  type FlowId,
  type FlowVersionId,
  type GateId,
  type JsonObject,
} from "@aegisflow/contracts";
import {
  AegisFlowSdkError,
  type EffectListResponse,
  type EffectReconciliationResponse,
  type ExecutionListResponse,
  type ExecutionResponse,
  type FlowListResponse,
  type FlowResponse,
  type GateResolutionResponse,
  type PendingGateListResponse,
} from "@aegisflow/sdk";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const MAX_FORM_BYTES = 65_536;

export interface OperatorConsoleClient {
  listFlows(): Promise<FlowListResponse>;
  getFlow(flowId: FlowId): Promise<FlowResponse>;
  startExecution(input: { readonly flowId: FlowId; readonly flowVersionId?: FlowVersionId; readonly idempotencyKey: string }): Promise<ExecutionResponse>;
  listExecutions(): Promise<ExecutionListResponse>;
  getExecution(executionId: ExecutionId): Promise<ExecutionResponse>;
  getExecutionEvents(executionId: ExecutionId): Promise<{ readonly events: readonly unknown[] }>;
  getExecutionEffects(executionId: ExecutionId): Promise<{ readonly effects: readonly unknown[] }>;
  getExecutionGates(executionId: ExecutionId): Promise<{ readonly gates: readonly unknown[] }>;
  listPendingGates(): Promise<PendingGateListResponse>;
  approveGate(input: { readonly gateId: GateId; readonly actorId: string; readonly evidence?: JsonObject }): Promise<GateResolutionResponse>;
  rejectGate(input: { readonly gateId: GateId; readonly actorId: string; readonly evidence?: JsonObject }): Promise<GateResolutionResponse>;
  listEffects(): Promise<EffectListResponse>;
  reconcileEffect(input: { readonly effectId: EffectId; readonly decision: "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED"; readonly reconciledBy: string; readonly externalReference?: string }): Promise<EffectReconciliationResponse>;
}

export interface OperatorConsoleOptions {
  readonly client: OperatorConsoleClient;
  readonly csrfToken?: string;
}

class ConsoleInputError extends Error {
  constructor(message: string) { super(message); this.name = "ConsoleInputError"; }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonHtml(value: unknown): string {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function badge(state: unknown): string {
  return `<span class="badge">${escapeHtml(state)}</span>`;
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · AegisFlow</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color-scheme:dark;background:#0b1020;color:#e8edf7}*{box-sizing:border-box}body{margin:0}a{color:#8dc7ff;text-decoration:none}a:hover{text-decoration:underline}header{position:sticky;top:0;background:#10172a;border-bottom:1px solid #26304a;padding:14px 24px;display:flex;gap:24px;align-items:center}header strong{font-size:18px}nav{display:flex;gap:14px;flex-wrap:wrap}main{max-width:1180px;margin:0 auto;padding:28px 22px 60px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.card{background:#121a2e;border:1px solid #26304a;border-radius:12px;padding:16px;margin:12px 0}.metric{font-size:32px;font-weight:700}.muted{color:#98a4ba}.warning{color:#ffd18a}.error{color:#ff9aa8}.badge{display:inline-block;border:1px solid #405174;border-radius:999px;padding:2px 8px;font-size:12px}table{width:100%;border-collapse:collapse;background:#121a2e}th,td{text-align:left;padding:10px;border-bottom:1px solid #26304a;vertical-align:top}th{color:#aebbd1}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#09101e;border:1px solid #26304a;border-radius:8px;padding:12px}form{display:grid;gap:8px;max-width:720px;margin:8px 0 16px}input,textarea,select,button{font:inherit;border-radius:7px;border:1px solid #405174;background:#0b1222;color:#e8edf7;padding:8px}textarea{min-height:80px}button{cursor:pointer;background:#18345a}button.danger{background:#572332}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.timeline{border-left:2px solid #405174;padding-left:18px}.timeline .event{margin:12px 0}.small{font-size:12px}</style></head><body><header><strong>AegisFlow</strong><nav><a href="/">Overview</a><a href="/flows">Flows</a><a href="/executions">Executions</a><a href="/gates">Pending Gates</a><a href="/effects">Effects</a></nav></header><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  response.end(html);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, "cache-control": "no-store" }); response.end();
}

function parts(request: IncomingMessage): string[] {
  const url = new URL(request.url ?? "/", "http://aegisflow.console");
  return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const contentType = request.headers["content-type"] ?? "";
  if (!String(contentType).startsWith("application/x-www-form-urlencoded")) throw new ConsoleInputError("Expected form submission.");
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); total += buffer.length;
    if (total > MAX_FORM_BYTES) throw new ConsoleInputError("Form submission exceeds 64 KiB."); chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function requireField(form: URLSearchParams, key: string): string {
  const value = form.get(key); if (value === null || value.trim().length === 0) throw new ConsoleInputError(`${key} is required.`); return value.trim();
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}

function requireCsrf(form: URLSearchParams, token: string): void {
  const supplied = form.get("csrf") ?? ""; if (!secureEqual(supplied, token)) throw new ConsoleInputError("Invalid action token.");
}

function evidence(form: URLSearchParams): JsonObject | undefined {
  const text = form.get("evidence")?.trim(); if (text === undefined || text.length === 0) return undefined;
  let value: unknown; try { value = JSON.parse(text) as unknown; } catch { throw new ConsoleInputError("Evidence must be valid JSON."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConsoleInputError("Evidence must be a JSON object.");
  return value as JsonObject;
}

function safeReturnTo(form: URLSearchParams, fallback: string): string {
  const value = form.get("returnTo"); return value !== null && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

function actionForm(token: string, action: string, returnTo: string): string {
  return `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><label>Actor<input name="actorId" required maxlength="200"></label><label>Evidence JSON<textarea name="evidence" placeholder='{"ticket":"CHG-42"}'></textarea></label><div class="row"><button name="decision" value="approve">Approve</button><button class="danger" name="decision" value="reject">Reject</button></div></form>`;
}

function effectForm(token: string, effectId: string, returnTo: string): string {
  return `<form method="post" action="/effects/${encodeURIComponent(effectId)}/reconcile"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><label>Operator<input name="reconciledBy" required maxlength="200"></label><label>External reference<input name="externalReference" maxlength="500"></label><div class="row"><button name="decision" value="CONFIRMED_SUCCEEDED">Confirm succeeded</button><button class="danger" name="decision" value="CONFIRMED_FAILED">Confirm failed</button></div></form>`;
}

function table(headers: readonly string[], rows: readonly string[]): string {
  return `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

export function createOperatorConsoleServer(options: OperatorConsoleOptions): Server {
  const token = options.csrfToken ?? randomUUID(); const client = options.client;
  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET"; const path = parts(request);
      if (method === "GET" && path.length === 0) {
        const [flows, executions, gates, effects] = await Promise.all([client.listFlows(), client.listExecutions(), client.listPendingGates(), client.listEffects()]);
        const reconcile = effects.effects.filter((effect) => effect.state === "RECONCILIATION_REQUIRED").length;
        sendHtml(response, 200, layout("Operator overview", `<div class="grid"><div class="card"><div class="metric">${flows.flows.length}</div><div>Flows</div></div><div class="card"><div class="metric">${executions.executions.length}</div><div>Executions</div></div><div class="card"><div class="metric">${gates.gates.length}</div><div>Pending Gates</div></div><div class="card"><div class="metric">${reconcile}</div><div>Effects requiring reconciliation</div></div></div><p class="muted">Operator lists are bounded to the newest/most relevant 200 durable records. A truncation warning appears on list pages.</p>`)); return;
      }
      if (method === "GET" && path.length === 1 && path[0] === "flows") {
        const data = await client.listFlows();
        const rows = data.flows.map((flow) => `<tr><td><a href="/flows/${encodeURIComponent(flow.id)}">${escapeHtml(flow.name)}</a><div class="small muted">${escapeHtml(flow.id)}</div></td><td>${flow.latestVersion ?? "—"}</td><td>${escapeHtml(flow.description ?? "")}</td><td>${escapeHtml(flow.updatedAt)}</td></tr>`);
        sendHtml(response, 200, layout("Flows", `${data.truncated ? '<p class="warning">Showing first 200 Flows.</p>' : ""}${table(["Flow", "Latest version", "Description", "Updated"], rows)}`)); return;
      }
      if (method === "GET" && path.length === 2 && path[0] === "flows") {
        const flowId = parseFlowId(path[1]); const data = await client.getFlow(flowId); const idem = `console-${randomUUID()}`;
        const versions = data.versions.map((version) => `<div class="card"><div class="row"><strong>Version ${version.version}</strong>${badge(version.id)}<span class="muted">${escapeHtml(version.createdAt)}</span></div><pre>${jsonHtml(version.definition)}</pre></div>`).join("");
        const start = `<div class="card"><h2>Start execution</h2><form method="post" action="/flows/${encodeURIComponent(flowId)}/start"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><input type="hidden" name="idempotencyKey" value="${escapeHtml(idem)}"><label>Flow version<select name="flowVersionId"><option value="">Latest</option>${data.versions.map((v) => `<option value="${escapeHtml(v.id)}">v${v.version} · ${escapeHtml(v.id)}</option>`).join("")}</select></label><button>Start execution</button></form><p class="small muted">This rendered form carries one stable idempotency key so browser resubmission preserves execution identity.</p></div>`;
        sendHtml(response, 200, layout(data.flow.name, `<p>${escapeHtml(data.flow.description ?? "No description")}</p>${start}<h2>Versions</h2>${versions}`)); return;
      }
      if (method === "POST" && path.length === 3 && path[0] === "flows" && path[2] === "start") {
        const form = await readForm(request); requireCsrf(form, token); const flowId = parseFlowId(path[1]); const idempotencyKey = requireField(form, "idempotencyKey"); const versionText = form.get("flowVersionId")?.trim();
        const result = versionText ? await client.startExecution({ flowId, flowVersionId: parseFlowVersionId(versionText), idempotencyKey }) : await client.startExecution({ flowId, idempotencyKey });
        redirect(response, `/executions/${encodeURIComponent(result.execution.id)}`); return;
      }
      if (method === "GET" && path.length === 1 && path[0] === "executions") {
        const data = await client.listExecutions(); const rows = data.executions.map((execution) => `<tr><td><a href="/executions/${encodeURIComponent(execution.id)}">${escapeHtml(execution.id)}</a></td><td><a href="/flows/${encodeURIComponent(execution.flowId)}">${escapeHtml(execution.flowName)}</a></td><td>${badge(execution.state)}</td><td>${escapeHtml(execution.createdAt)}</td></tr>`);
        sendHtml(response, 200, layout("Executions", `${data.truncated ? '<p class="warning">Showing newest 200 Executions.</p>' : ""}${table(["Execution", "Flow", "State", "Created"], rows)}`)); return;
      }
      if (method === "GET" && path.length === 2 && path[0] === "executions") {
        const executionId = parseExecutionId(path[1]); const [execution, events, effects, gates] = await Promise.all([client.getExecution(executionId), client.getExecutionEvents(executionId), client.getExecutionEffects(executionId), client.getExecutionGates(executionId)]); const here = `/executions/${encodeURIComponent(executionId)}`;
        const stages = table(["Stage", "State", "Updated"], execution.stages.map((stage) => `<tr><td>${escapeHtml(stage.stageId)}<div class="small muted">${escapeHtml(stage.id)}</div></td><td>${badge(stage.state)}</td><td>${escapeHtml(stage.updatedAt)}</td></tr>`));
        const timeline = events.events.length === 0 ? '<p class="muted">No evidence events recorded.</p>' : `<div class="timeline">${events.events.map((event) => `<div class="event"><pre>${jsonHtml(event)}</pre></div>`).join("")}</div>`;
        const gateCards = gates.gates.length === 0 ? '<p class="muted">No Gates.</p>' : gates.gates.map((gate) => { const record = gate as { id?: unknown; state?: unknown }; const id = typeof record.id === "string" ? record.id : ""; return `<div class="card"><pre>${jsonHtml(gate)}</pre>${record.state === "WAITING" && id ? actionForm(token, `/gates/${encodeURIComponent(id)}/decide`, here) : ""}</div>`; }).join("");
        const effectCards = effects.effects.length === 0 ? '<p class="muted">No Effects.</p>' : effects.effects.map((effect) => { const record = effect as { id?: unknown; state?: unknown }; const id = typeof record.id === "string" ? record.id : ""; return `<div class="card"><pre>${jsonHtml(effect)}</pre>${record.state === "RECONCILIATION_REQUIRED" && id ? effectForm(token, id, here) : ""}</div>`; }).join("");
        sendHtml(response, 200, layout(`Execution ${executionId}`, `<div class="card"><div class="row">${badge(execution.execution.state)}<span>Flow <a href="/flows/${encodeURIComponent(execution.execution.flowId)}">${escapeHtml(execution.execution.flowId)}</a></span><span>Version ${escapeHtml(execution.execution.flowVersionId)}</span></div></div><h2>Stage status</h2>${stages}<h2>Pending / resolved Gates</h2>${gateCards}<h2>Effects</h2>${effectCards}<h2>Evidence timeline</h2>${timeline}`)); return;
      }
      if (method === "GET" && path.length === 1 && path[0] === "gates") {
        const data = await client.listPendingGates(); const cards = data.gates.length === 0 ? '<p class="muted">No pending Gates.</p>' : data.gates.map((gate) => `<div class="card"><div class="row"><strong>${escapeHtml(gate.flowName)} · ${escapeHtml(gate.stageId)}</strong>${badge(gate.state)}</div><p><a href="/executions/${encodeURIComponent(gate.executionId)}">${escapeHtml(gate.executionId)}</a></p>${actionForm(token, `/gates/${encodeURIComponent(gate.id)}/decide`, "/gates")}</div>`).join("");
        sendHtml(response, 200, layout("Pending Gates", `${data.truncated ? '<p class="warning">Showing first 200 pending Gates.</p>' : ""}${cards}`)); return;
      }
      if (method === "POST" && path.length === 3 && path[0] === "gates" && path[2] === "decide") {
        const form = await readForm(request); requireCsrf(form, token); const gateId = parseGateId(path[1]); const actorId = requireField(form, "actorId"); const decision = requireField(form, "decision"); const ev = evidence(form); const input = ev === undefined ? { gateId, actorId } : { gateId, actorId, evidence: ev };
        if (decision === "approve") await client.approveGate(input); else if (decision === "reject") await client.rejectGate(input); else throw new ConsoleInputError("Unknown Gate decision.");
        redirect(response, safeReturnTo(form, "/gates")); return;
      }
      if (method === "GET" && path.length === 1 && path[0] === "effects") {
        const data = await client.listEffects(); const cards = data.effects.length === 0 ? '<p class="muted">No Effects.</p>' : data.effects.map((effect) => `<div class="card"><div class="row"><strong>${escapeHtml(effect.flowName)} · ${escapeHtml(effect.stageId)}</strong>${badge(effect.state)}</div><p><a href="/executions/${encodeURIComponent(effect.executionId)}">${escapeHtml(effect.executionId)}</a> · ${escapeHtml(effect.effectKey)}</p><pre>${jsonHtml(effect)}</pre>${effect.state === "RECONCILIATION_REQUIRED" ? effectForm(token, effect.id, "/effects") : ""}</div>`).join("");
        sendHtml(response, 200, layout("Effects & reconciliation", `${data.truncated ? '<p class="warning">Showing first 200 Effects.</p>' : ""}${cards}`)); return;
      }
      if (method === "POST" && path.length === 3 && path[0] === "effects" && path[2] === "reconcile") {
        const form = await readForm(request); requireCsrf(form, token); const effectId = parseEffectId(path[1]); const decision = requireField(form, "decision"); if (decision !== "CONFIRMED_SUCCEEDED" && decision !== "CONFIRMED_FAILED") throw new ConsoleInputError("Unknown reconciliation decision."); const reconciledBy = requireField(form, "reconciledBy"); const externalReference = form.get("externalReference")?.trim(); const input = externalReference ? { effectId, decision, reconciledBy, externalReference } : { effectId, decision, reconciledBy }; await client.reconcileEffect(input); redirect(response, safeReturnTo(form, "/effects")); return;
      }
      sendHtml(response, 404, layout("Not found", '<p class="error">Route not found.</p>'));
    } catch (error) {
      const status = error instanceof ConsoleInputError ? 400 : error instanceof AegisFlowSdkError ? error.status : 500;
      const message = status < 500 && error instanceof Error ? error.message : "Operator console request failed.";
      sendHtml(response, status, layout("Request failed", `<p class="error">${escapeHtml(message)}</p><p><a href="/">Return to overview</a></p>`));
    }
  });
}
