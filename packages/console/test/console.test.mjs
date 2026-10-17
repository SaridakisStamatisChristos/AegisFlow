import assert from "node:assert/strict";
import test from "node:test";
import { createOperatorConsoleServer } from "../dist/index.js";

const csrf = "test-csrf-token";
function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
function close(server) { return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
function fakeClient(overrides = {}) {
  return {
    async listFlows() { return { flows: [{ id: "flow_aaaaaaaa", name: '<script>alert("x")</script>', description: "demo", latestVersionId: "flowv_aaaaaaaa", latestVersion: 1, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" }], truncated: false }; },
    async getFlow() { return { flow: { id: "flow_aaaaaaaa", name: "demo", description: null, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" }, versions: [{ id: "flowv_aaaaaaaa", version: 1, definition: { name: "demo", stages: [] }, createdAt: "2026-10-17T00:00:00Z" }] }; },
    async startExecution() { return { execution: { id: "exec_aaaaaaaa", flowId: "flow_aaaaaaaa", flowVersionId: "flowv_aaaaaaaa", state: "RUNNING", createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" }, stages: [], replayed: false }; },
    async listExecutions() { return { executions: [], truncated: false }; },
    async getExecution() { return { execution: { id: "exec_aaaaaaaa", flowId: "flow_aaaaaaaa", flowVersionId: "flowv_aaaaaaaa", state: "RUNNING", createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" }, stages: [{ id: "stagex_aaaaaaaa", stageId: "approval", state: "WAITING", createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" }] }; },
    async getExecutionEvents() { return { events: [{ eventType: "execution.started", payload: { unsafe: "<img src=x>" } }] }; },
    async getExecutionEffects() { return { effects: [] }; },
    async getExecutionGates() { return { gates: [] }; },
    async listPendingGates() { return { gates: [], truncated: false }; },
    async approveGate() { return { snapshot: {}, changed: true }; },
    async rejectGate() { return { snapshot: {}, changed: true }; },
    async listEffects() { return { effects: [], truncated: false }; },
    async reconcileEffect() { return { reconciliation: {}, created: true }; },
    ...overrides,
  };
}

async function withServer(client, work) {
  const server = createOperatorConsoleServer({ client, csrfToken: csrf }); await listen(server);
  try { const address = server.address(); if (address === null || typeof address === "string") throw new Error("console did not bind"); await work(`http://127.0.0.1:${address.port}`); } finally { await close(server); }
}

test("console renders bounded Flow list and HTML-escapes durable data", async () => {
  await withServer(fakeClient(), async (base) => {
    const response = await fetch(`${base}/flows`); const html = await response.text();
    assert.equal(response.status, 200); assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/u); assert.doesNotMatch(html, /<script>alert/u);
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/u);
  });
});

test("execution detail exposes stage status and escaped evidence timeline", async () => {
  await withServer(fakeClient(), async (base) => {
    const html = await (await fetch(`${base}/executions/exec_aaaaaaaa`)).text();
    assert.match(html, /Stage status/u); assert.match(html, /Evidence timeline/u); assert.match(html, /&lt;img src=x&gt;/u); assert.doesNotMatch(html, /<img src=x>/u);
  });
});

test("Gate decisions require action token and delegate through SDK client", async () => {
  const calls = [];
  await withServer(fakeClient({ async approveGate(input) { calls.push(input); return { snapshot: {}, changed: true }; } }), async (base) => {
    const denied = await fetch(`${base}/gates/gate_aaaaaaaa/decide`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ actorId: "operator", decision: "approve" }), redirect: "manual" });
    assert.equal(denied.status, 400); assert.equal(calls.length, 0);
    const accepted = await fetch(`${base}/gates/gate_aaaaaaaa/decide`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, actorId: "operator", decision: "approve", evidence: '{"ticket":"CHG-1"}', returnTo: "/gates" }), redirect: "manual" });
    assert.equal(accepted.status, 303); assert.equal(accepted.headers.get("location"), "/gates"); assert.deepEqual(calls[0].evidence, { ticket: "CHG-1" });
  });
});

test("Effect reconciliation is explicit and rejects unknown decisions", async () => {
  const calls = [];
  await withServer(fakeClient({ async reconcileEffect(input) { calls.push(input); return { reconciliation: {}, created: true }; } }), async (base) => {
    const bad = await fetch(`${base}/effects/effect_aaaaaaaa/reconcile`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, reconciledBy: "operator", decision: "RETRY" }), redirect: "manual" });
    assert.equal(bad.status, 400); assert.equal(calls.length, 0);
    const ok = await fetch(`${base}/effects/effect_aaaaaaaa/reconcile`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, reconciledBy: "operator", decision: "CONFIRMED_FAILED", externalReference: "remote-7", returnTo: "/effects" }), redirect: "manual" });
    assert.equal(ok.status, 303); assert.equal(calls[0].decision, "CONFIRMED_FAILED"); assert.equal(calls[0].externalReference, "remote-7");
  });
});

test("Flow start preserves rendered idempotency key and version pin", async () => {
  const calls = [];
  await withServer(fakeClient({ async startExecution(input) { calls.push(input); return { execution: { id: "exec_aaaaaaaa", flowId: input.flowId, flowVersionId: input.flowVersionId ?? "flowv_aaaaaaaa", state: "RUNNING", createdAt: "x", updatedAt: "x" }, stages: [], replayed: false }; } }), async (base) => {
    const response = await fetch(`${base}/flows/flow_aaaaaaaa/start`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, idempotencyKey: "console-stable-key", flowVersionId: "flowv_aaaaaaaa" }), redirect: "manual" });
    assert.equal(response.status, 303); assert.deepEqual(calls[0], { flowId: "flow_aaaaaaaa", flowVersionId: "flowv_aaaaaaaa", idempotencyKey: "console-stable-key" });
  });
});

test("oversized form bodies fail closed before SDK mutation", async () => {
  let called = false;
  await withServer(fakeClient({ async approveGate() { called = true; return { snapshot: {}, changed: true }; } }), async (base) => {
    const response = await fetch(`${base}/gates/gate_aaaaaaaa/decide`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${csrf}&actorId=operator&decision=approve&evidence=${"x".repeat(70_000)}` });
    assert.equal(response.status, 400); assert.equal(called, false);
  });
});
