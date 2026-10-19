import type {
  EffectId, EffectState, ExecutionId, FlowDefinition, FlowId, FlowVersionId,
  GateId, GateState, JsonObject, SignalId, StageExecutionId,
} from "@aegisflow/contracts";

export interface AegisFlowClientOptions { readonly baseUrl: string; readonly fetch?: typeof globalThis.fetch; readonly apiToken?: string; }
export interface RegisteredFlowResponse {
  readonly flow: { readonly id: FlowId; readonly name: string; readonly description: string | null };
  readonly version: { readonly id: FlowVersionId; readonly version: number; readonly definition: FlowDefinition };
  readonly created: boolean;
}
export interface FlowResponse {
  readonly flow: { readonly id: FlowId; readonly name: string; readonly description: string | null; readonly createdAt: string; readonly updatedAt: string };
  readonly versions: readonly { readonly id: FlowVersionId; readonly version: number; readonly definition: FlowDefinition; readonly createdAt: string }[];
}
export interface FlowListResponse {
  readonly flows: readonly { readonly id: FlowId; readonly name: string; readonly description: string | null; readonly latestVersionId: FlowVersionId | null; readonly latestVersion: number | null; readonly createdAt: string; readonly updatedAt: string }[];
  readonly truncated: boolean;
}
export interface ExecutionResponse {
  readonly execution: { readonly id: ExecutionId; readonly flowId: FlowId; readonly flowVersionId: FlowVersionId; readonly state: string; readonly createdAt: string; readonly updatedAt: string };
  readonly stages: readonly { readonly id: StageExecutionId; readonly stageId: string; readonly state: string; readonly createdAt: string; readonly updatedAt: string }[];
  readonly replayed?: boolean;
}
export interface ExecutionListResponse {
  readonly executions: readonly { readonly id: ExecutionId; readonly flowId: FlowId; readonly flowVersionId: FlowVersionId; readonly flowName: string; readonly state: string; readonly createdAt: string; readonly updatedAt: string }[];
  readonly truncated: boolean;
}
export interface PendingGateListResponse {
  readonly gates: readonly { readonly id: GateId; readonly executionId: ExecutionId; readonly stageExecutionId: StageExecutionId; readonly stageId: string; readonly flowName: string; readonly state: GateState; readonly expiresAt: string | null; readonly createdAt: string; readonly updatedAt: string }[];
  readonly truncated: boolean;
}
export interface EffectListResponse {
  readonly effects: readonly { readonly id: EffectId; readonly executionId: ExecutionId; readonly stageExecutionId: StageExecutionId; readonly stageId: string; readonly flowName: string; readonly effectKey: string; readonly state: string; readonly resolutionCode: string | null; readonly externalReference: string | null; readonly createdAt: string; readonly updatedAt: string; readonly reconciliation: null | { readonly decision: string; readonly reconciledBy: string | null; readonly reconciledAt: string | null } }[];
  readonly truncated: boolean;
}
export interface GateSnapshotResponse {
  readonly gate: { readonly id: GateId; readonly executionId: ExecutionId; readonly stageExecutionId: StageExecutionId; readonly state: GateState; readonly expiresAt: string | null; readonly resolvedAt: string | null; readonly createdAt: string; readonly updatedAt: string };
  readonly resolution: null | { readonly gateId: GateId; readonly outcome: "APPROVED" | "REJECTED" | "EXPIRED"; readonly actorId: string | null; readonly evidence: JsonObject; readonly resolvedAt: string };
  readonly protectedStageExecutionIds: readonly StageExecutionId[];
}
export interface GateResolutionResponse { readonly snapshot: GateSnapshotResponse; readonly changed: boolean; }
export interface EffectSnapshotResponse {
  readonly effect: { readonly id: EffectId; readonly executionId: ExecutionId; readonly stageExecutionId: StageExecutionId; readonly effectKey: string; readonly intentDigest: string; readonly state: EffectState; readonly claimedAt: string | null; readonly resolvedAt: string | null; readonly resolutionCode: string | null; readonly externalReference: string | null; readonly createdAt: string; readonly updatedAt: string };
  readonly reconciliation: null | EffectReconciliationRecordResponse;
}
export interface EffectReconciliationRecordResponse { readonly effectId: EffectId; readonly decision: "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED"; readonly reconciledBy: string; readonly externalReference: string | null; readonly reconciledAt: string; }
export interface EffectReconciliationResponse { readonly reconciliation: EffectReconciliationRecordResponse; readonly created: boolean; }
export interface SignalResponse {
  readonly signal: { readonly id: SignalId; readonly executionId: ExecutionId; readonly signalName: string; readonly idempotencyKey: string; readonly payload: JsonObject; readonly createdAt: string };
  readonly replayed: boolean; readonly resumedStageExecutionIds: readonly StageExecutionId[];
}
export class AegisFlowSdkError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "AegisFlowSdkError"; }
}
function normalizeBaseUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("baseUrl must be a non-empty URL string.");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("baseUrl must use http or https.");
  return url.toString().replace(/\/$/u, "");
}
export class AegisFlowClient {
  private readonly baseUrl: string; private readonly fetcher: typeof globalThis.fetch;
  private readonly apiToken: string | undefined;
  constructor(options: AegisFlowClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl); this.fetcher = options.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== "function") throw new TypeError("A fetch implementation is required.");
    this.apiToken = options.apiToken;
    if (this.apiToken !== undefined) {
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(this.apiToken)) throw new TypeError("apiToken must be a valid opaque bearer token.");
      const url = new URL(this.baseUrl);
      if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        throw new TypeError("Bearer credentials require HTTPS or a local loopback API URL.");
      }
    }
  }
  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers = new Headers({ accept: "application/json" }); let encodedBody: string | undefined;
    if (body !== undefined) { headers.set("content-type", "application/json"); encodedBody = JSON.stringify(body); }
    if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
    if (this.apiToken !== undefined) headers.set("authorization", `Bearer ${this.apiToken}`);
    const init: RequestInit = { method, headers }; if (encodedBody !== undefined) init.body = encodedBody;
    const response = await this.fetcher(`${this.baseUrl}${path}`, init); const payload = await response.json() as unknown;
    if (!response.ok) {
      const error = payload as { readonly error?: { readonly code?: unknown; readonly message?: unknown } };
      const code = typeof error.error?.code === "string" ? error.error.code : "HTTP_ERROR";
      const message = typeof error.error?.message === "string" ? error.error.message : `HTTP ${response.status}`;
      throw new AegisFlowSdkError(response.status, code, message);
    }
    return payload as T;
  }
  registerFlow(definition: FlowDefinition): Promise<RegisteredFlowResponse> { return this.request("POST", "/v1/flows", { definition }); }
  listFlows(): Promise<FlowListResponse> { return this.request("GET", "/v1/flows"); }
  getFlow(flowId: FlowId): Promise<FlowResponse> { return this.request("GET", `/v1/flows/${encodeURIComponent(flowId)}`); }
  startExecution(input: { readonly flowId: FlowId; readonly flowVersionId?: FlowVersionId; readonly idempotencyKey: string }): Promise<ExecutionResponse> {
    const body = input.flowVersionId === undefined ? { flowId: input.flowId } : { flowId: input.flowId, flowVersionId: input.flowVersionId };
    return this.request("POST", "/v1/executions", body, input.idempotencyKey);
  }
  listExecutions(): Promise<ExecutionListResponse> { return this.request("GET", "/v1/executions"); }
  getExecution(executionId: ExecutionId): Promise<ExecutionResponse> { return this.request("GET", `/v1/executions/${encodeURIComponent(executionId)}`); }
  cancelExecution(executionId: ExecutionId): Promise<ExecutionResponse> { return this.request("POST", `/v1/executions/${encodeURIComponent(executionId)}/cancel`, {}); }
  getExecutionEvents(executionId: ExecutionId): Promise<{ readonly events: readonly unknown[] }> { return this.request("GET", `/v1/executions/${encodeURIComponent(executionId)}/events`); }
  getExecutionEffects(executionId: ExecutionId): Promise<{ readonly effects: readonly unknown[] }> { return this.request("GET", `/v1/executions/${encodeURIComponent(executionId)}/effects`); }
  getExecutionGates(executionId: ExecutionId): Promise<{ readonly gates: readonly unknown[] }> { return this.request("GET", `/v1/executions/${encodeURIComponent(executionId)}/gates`); }
  getExecutionSignals(executionId: ExecutionId): Promise<{ readonly signals: readonly unknown[] }> { return this.request("GET", `/v1/executions/${encodeURIComponent(executionId)}/signals`); }
  sendSignal(input: { readonly executionId: ExecutionId; readonly signalName: string; readonly idempotencyKey: string; readonly payload?: JsonObject }): Promise<SignalResponse> {
    return this.request("POST", `/v1/executions/${encodeURIComponent(input.executionId)}/signals/${encodeURIComponent(input.signalName)}`, { payload: input.payload ?? {} }, input.idempotencyKey);
  }
  listPendingGates(): Promise<PendingGateListResponse> { return this.request("GET", "/v1/gates/pending"); }
  getGate(gateId: GateId): Promise<GateSnapshotResponse> { return this.request("GET", `/v1/gates/${encodeURIComponent(gateId)}`); }
  approveGate(input: { readonly gateId: GateId; readonly actorId: string; readonly evidence?: JsonObject }): Promise<GateResolutionResponse> { return this.request("POST", `/v1/gates/${encodeURIComponent(input.gateId)}/approve`, { actorId: input.actorId, evidence: input.evidence ?? {} }); }
  rejectGate(input: { readonly gateId: GateId; readonly actorId: string; readonly evidence?: JsonObject }): Promise<GateResolutionResponse> { return this.request("POST", `/v1/gates/${encodeURIComponent(input.gateId)}/reject`, { actorId: input.actorId, evidence: input.evidence ?? {} }); }
  listEffects(): Promise<EffectListResponse> { return this.request("GET", "/v1/effects"); }
  getEffect(effectId: EffectId): Promise<EffectSnapshotResponse> { return this.request("GET", `/v1/effects/${encodeURIComponent(effectId)}`); }
  reconcileEffect(input: { readonly effectId: EffectId; readonly decision: "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED"; readonly reconciledBy: string; readonly externalReference?: string }): Promise<EffectReconciliationResponse> {
    const body = input.externalReference === undefined ? { decision: input.decision, reconciledBy: input.reconciledBy } : { decision: input.decision, reconciledBy: input.reconciledBy, externalReference: input.externalReference };
    return this.request("POST", `/v1/effects/${encodeURIComponent(input.effectId)}/reconcile`, body);
  }
}
