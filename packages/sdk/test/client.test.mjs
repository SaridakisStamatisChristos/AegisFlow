import assert from "node:assert/strict";
import test from "node:test";
import { AegisFlowClient, AegisFlowSdkError } from "../dist/index.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("SDK emits the public execution contract and idempotency header", async () => {
  const calls = [];
  const client = new AegisFlowClient({
    baseUrl: "https://example.test/",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(201, {
        execution: { id: "exec_aaaaaaaa", flowId: "flow_aaaaaaaa", flowVersionId: "flowv_aaaaaaaa", state: "RUNNING" },
        stages: [],
        replayed: false,
      });
    },
  });
  const response = await client.startExecution({ flowId: "flow_aaaaaaaa", idempotencyKey: "request-1" });
  assert.equal(response.replayed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/v1/executions");
  assert.equal(calls[0].init.headers.get("idempotency-key"), "request-1");
  assert.deepEqual(JSON.parse(calls[0].init.body), { flowId: "flow_aaaaaaaa" });
});

test("SDK surfaces structured API errors", async () => {
  const client = new AegisFlowClient({
    baseUrl: "https://example.test",
    fetch: async () => jsonResponse(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "conflict" } }),
  });
  await assert.rejects(
    client.startExecution({ flowId: "flow_aaaaaaaa", idempotencyKey: "request-1" }),
    (error) => error instanceof AegisFlowSdkError && error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT",
  );
});
