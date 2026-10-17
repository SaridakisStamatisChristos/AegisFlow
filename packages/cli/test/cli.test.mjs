import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/index.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    output: () => ({ stdout, stderr }),
  };
}

const flow = {
  name: "approval-demo",
  stages: [
    { id: "prepare", type: "task", handler: "demo.prepare" },
    { id: "review", type: "gate", dependsOn: ["prepare"], prompt: "Approve?" },
  ],
};

test("flow validate uses the shared contract and does not contact the API", async () => {
  const io = capture();
  let fetched = false;
  const code = await runCli(
    ["flow", "validate", "flow.json"],
    {
      ...io,
      readTextFile: async () => JSON.stringify(flow),
      fetch: async () => {
        fetched = true;
        throw new Error("unexpected fetch");
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(fetched, false);
  assert.deepEqual(JSON.parse(io.output().stdout), {
    valid: true,
    name: "approval-demo",
    stageCount: 2,
  });
  assert.equal(io.output().stderr, "");
});

test("flow validate rejects an invalid Flow before network access", async () => {
  const io = capture();
  let fetched = false;
  const code = await runCli(
    ["flow", "validate", "flow.json"],
    {
      ...io,
      readTextFile: async () => JSON.stringify({ name: "Bad Name", stages: [] }),
      fetch: async () => {
        fetched = true;
        throw new Error("unexpected fetch");
      },
    },
  );
  assert.equal(code, 2);
  assert.equal(fetched, false);
  const payload = JSON.parse(io.output().stderr);
  assert.equal(payload.error.code, "INVALID_FLOW");
});

test("flow submit validates locally and registers through the public SDK", async () => {
  const io = capture();
  const calls = [];
  const code = await runCli(
    ["--base-url", "https://api.example.test", "flow", "submit", "flow.json"],
    {
      ...io,
      readTextFile: async () => JSON.stringify(flow),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(201, {
          flow: { id: "flow_aaaaaaaa", name: flow.name, description: null },
          version: {
            id: "flowv_aaaaaaaa",
            version: 1,
            definition: flow,
          },
          created: true,
        });
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/flows");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { definition: flow });
  assert.deepEqual(JSON.parse(io.output().stdout), {
    flowId: "flow_aaaaaaaa",
    flowVersionId: "flowv_aaaaaaaa",
    version: 1,
    name: "approval-demo",
    created: true,
  });
});

test("execution start preserves the caller supplied idempotency key", async () => {
  const io = capture();
  const calls = [];
  const code = await runCli(
    [
      "execution",
      "start",
      "flow_aaaaaaaa",
      "--version",
      "flowv_aaaaaaaa",
      "--idempotency-key",
      "deploy-42",
    ],
    {
      ...io,
      env: { AEGISFLOW_BASE_URL: "https://api.example.test" },
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(201, {
          execution: {
            id: "exec_aaaaaaaa",
            flowId: "flow_aaaaaaaa",
            flowVersionId: "flowv_aaaaaaaa",
            state: "RUNNING",
            createdAt: "2026-10-17T00:00:00.000Z",
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
          stages: [],
          replayed: false,
        });
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/executions");
  assert.equal(calls[0].init.headers.get("idempotency-key"), "deploy-42");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    flowId: "flow_aaaaaaaa",
    flowVersionId: "flowv_aaaaaaaa",
  });
});

test("execution inspect uses the SDK execution endpoint", async () => {
  const io = capture();
  const calls = [];
  const code = await runCli(
    ["--base-url", "https://api.example.test", "execution", "inspect", "exec_aaaaaaaa"],
    {
      ...io,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, {
          execution: {
            id: "exec_aaaaaaaa",
            flowId: "flow_aaaaaaaa",
            flowVersionId: "flowv_aaaaaaaa",
            state: "RUNNING",
            createdAt: "2026-10-17T00:00:00.000Z",
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
          stages: [],
        });
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(calls[0].url, "https://api.example.test/v1/executions/exec_aaaaaaaa");
  assert.equal(calls[0].init.method, "GET");
});

test("gate approve loads JSON evidence and delegates through the SDK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aegisflow-cli-"));
  try {
    const evidencePath = join(directory, "evidence.json");
    await writeFile(evidencePath, JSON.stringify({ ticket: "CAB-17" }), "utf8");
    const io = capture();
    const calls = [];
    const code = await runCli(
      [
        "--base-url",
        "https://api.example.test",
        "gate",
        "approve",
        "gate_aaaaaaaa",
        "--actor",
        "operator@example.test",
        "--evidence",
        evidencePath,
      ],
      {
        ...io,
        fetch: async (url, init) => {
          calls.push({ url, init });
          return jsonResponse(200, {
            snapshot: {
              gate: {
                id: "gate_aaaaaaaa",
                executionId: "exec_aaaaaaaa",
                stageExecutionId: "stagex_aaaaaaaa",
                state: "APPROVED",
                expiresAt: null,
                resolvedAt: "2026-10-17T00:00:01.000Z",
                createdAt: "2026-10-17T00:00:00.000Z",
                updatedAt: "2026-10-17T00:00:01.000Z",
              },
              resolution: {
                gateId: "gate_aaaaaaaa",
                outcome: "APPROVED",
                actorId: "operator@example.test",
                evidence: { ticket: "CAB-17" },
                resolvedAt: "2026-10-17T00:00:01.000Z",
              },
              protectedStageExecutionIds: [],
            },
            changed: true,
          });
        },
      },
    );
    assert.equal(code, 0);
    assert.equal(calls[0].url, "https://api.example.test/v1/gates/gate_aaaaaaaa/approve");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      actorId: "operator@example.test",
      evidence: { ticket: "CAB-17" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gate reject is supported without optional evidence", async () => {
  const io = capture();
  const calls = [];
  const code = await runCli(
    ["--base-url", "https://api.example.test", "gate", "reject", "gate_aaaaaaaa", "--actor", "reviewer"],
    {
      ...io,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, {
          snapshot: {
            gate: {
              id: "gate_aaaaaaaa",
              executionId: "exec_aaaaaaaa",
              stageExecutionId: "stagex_aaaaaaaa",
              state: "REJECTED",
              expiresAt: null,
              resolvedAt: "2026-10-17T00:00:01.000Z",
              createdAt: "2026-10-17T00:00:00.000Z",
              updatedAt: "2026-10-17T00:00:01.000Z",
            },
            resolution: {
              gateId: "gate_aaaaaaaa",
              outcome: "REJECTED",
              actorId: "reviewer",
              evidence: {},
              resolvedAt: "2026-10-17T00:00:01.000Z",
            },
            protectedStageExecutionIds: [],
          },
          changed: true,
        });
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(calls[0].url, "https://api.example.test/v1/gates/gate_aaaaaaaa/reject");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    actorId: "reviewer",
    evidence: {},
  });
});

test("structured SDK failures become stable CLI error JSON", async () => {
  const io = capture();
  const code = await runCli(
    ["--base-url", "https://api.example.test", "execution", "inspect", "exec_aaaaaaaa"],
    {
      ...io,
      fetch: async () => jsonResponse(404, {
        error: { code: "NOT_FOUND", message: "Execution not found." },
      }),
    },
  );
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(io.output().stderr), {
    error: {
      code: "NOT_FOUND",
      message: "Execution not found.",
      status: 404,
    },
  });
});

test("missing idempotency key is a usage failure and makes no request", async () => {
  const io = capture();
  let fetched = false;
  const code = await runCli(
    ["execution", "start", "flow_aaaaaaaa"],
    {
      ...io,
      fetch: async () => {
        fetched = true;
        throw new Error("unexpected fetch");
      },
    },
  );
  assert.equal(code, 2);
  assert.equal(fetched, false);
  assert.equal(JSON.parse(io.output().stderr).error.code, "CLI_USAGE");
});
