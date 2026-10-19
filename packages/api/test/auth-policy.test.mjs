import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import test from "node:test";
import { createControlServer, PROTECTED_ROUTE_POLICY, requiredCapability } from "../dist/index.js";

const routes = [
  {
    "method": "GET",
    "path": "/v1/flows",
    "capability": "read"
  },
  {
    "method": "POST",
    "path": "/v1/flows",
    "capability": "execute"
  },
  {
    "method": "GET",
    "path": "/v1/flows/:flowId",
    "capability": "read"
  },
  {
    "method": "GET",
    "path": "/v1/executions",
    "capability": "read"
  },
  {
    "method": "POST",
    "path": "/v1/executions",
    "capability": "execute"
  },
  {
    "method": "GET",
    "path": "/v1/executions/:executionId",
    "capability": "read"
  },
  {
    "method": "POST",
    "path": "/v1/executions/:executionId/cancel",
    "capability": "execute"
  },
  {
    "method": "GET",
    "path": "/v1/executions/:executionId/events",
    "capability": "read"
  },
  {
    "method": "GET",
    "path": "/v1/executions/:executionId/effects",
    "capability": "read"
  },
  {
    "method": "GET",
    "path": "/v1/executions/:executionId/gates",
    "capability": "read"
  },
  {
    "method": "GET",
    "path": "/v1/executions/:executionId/signals",
    "capability": "read"
  },
  {
    "method": "POST",
    "path": "/v1/executions/:executionId/signals/:signalName",
    "capability": "execute"
  },
  {
    "method": "GET",
    "path": "/v1/gates/pending",
    "capability": "read"
  },
  {
    "method": "GET",
    "path": "/v1/gates/:gateId",
    "capability": "read"
  },
  {
    "method": "POST",
    "path": "/v1/gates/:gateId/approve",
    "capability": "approve"
  },
  {
    "method": "POST",
    "path": "/v1/gates/:gateId/reject",
    "capability": "approve"
  },
  {
    "method": "GET",
    "path": "/v1/effects",
    "capability": "read"
  },
  {
    "method": "GET",
    "path": "/v1/effects/:effectId",
    "capability": "read"
  },
  {
    "method": "POST",
    "path": "/v1/effects/:effectId/reconcile",
    "capability": "reconcile"
  }
];
const roles = ["reader", "operator", "approver", "reconciler", "admin"];
const allowed = {
  reader: ["read"], operator: ["read", "execute"], approver: ["read", "approve"],
  reconciler: ["read", "reconcile"], admin: ["read", "execute", "approve", "reconcile"],
};
const tokenFor = (role) => "aegisflowPolicyTest_" + role + "_".repeat(1) + "x".repeat(35);
const credentials = roles.map((role) => ({
  id: role + "-service", role,
  sha256: createHash("sha256").update(tokenFor(role)).digest("hex"),
}));
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
}
function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function fixtureUrl(path) {
  return path.replace(":flowId", "flow_aaaaaaaa")
    .replace(":executionId", "exec_aaaaaaaa")
    .replace(":gateId", "gate_aaaaaaaa")
    .replace(":effectId", "effect_aaaaaaaa")
    .replace(":signalName", "signal-one");
}
function payload(route, role) {
  if (route === "/v1/flows") return { definition: {} };
  if (route === "/v1/executions") return { flowId: "flow_aaaaaaaa" };
  if (route.endsWith("/approve") || route.endsWith("/reject")) return { actorId: role + "-service" };
  if (route.endsWith("/reconcile")) return { reconciledBy: role + "-service", decision: "CONFIRMED_SUCCEEDED" };
  return {};
}
function raw(port, method, path, headers) {
  return new Promise((resolve, reject) => {
    const r = request({ port, hostname: "127.0.0.1", method, path, headers },
      (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
    r.once("error", reject); r.end();
  });
}
test("policy inventory matches every implemented protected route exactly (no wildcard)", () => {
  assert.equal(PROTECTED_ROUTE_POLICY.length, 19);
  assert.deepEqual(PROTECTED_ROUTE_POLICY.map((p) => ({...p})), routes);
  for (const row of routes) {
    assert.equal(requiredCapability(row.method, fixtureUrl(row.path).slice(1).split("/")), row.capability);
    assert.equal(requiredCapability("DELETE", fixtureUrl(row.path).slice(1).split("/")), undefined);
  }
  for (const [method, path] of [["POST", "/v1/effects/effect_aaaaaaaa/force"],
    ["GET", "/v1/executions/exec_aaaaaaaa/admin"], ["GET", "/v1/new-private"],
    ["PUT", "/v1/flows"], ["HEAD", "/v1/flows"], ["OPTIONS", "/v1/flows"]]) {
    assert.equal(requiredCapability(method, path.slice(1).split("/")), undefined);
  }
});
test("full route x role matrix (95 decisions) enforces permission before any work", async (t) => {
  let work = 0;
  const pool = { query: async () => { work++; return { rows: [], rowCount: 0 }; } };
  const stub = new Proxy({ pool }, { get(target, key) {
    if (key === "pool") return pool;
    return async () => { work++; return { created: true, replayed: false, changed: true }; };
  }});
  const server = createControlServer(stub, credentials);
  await listen(server); t.after(() => close(server));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  for (const role of roles) for (const row of routes) {
    const before = work, permits = allowed[role].includes(row.capability);
    const headers = { authorization: "Bearer " + tokenFor(role) };
    if (row.method === "POST") {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = "policy-test-key";
    }
    const result = await fetch(base + fixtureUrl(row.path), {
      method: row.method, headers,
      ...(row.method === "POST" ? { body: JSON.stringify(payload(row.path, role)) } : {}),
    });
    assert.equal(result.status, permits ? (row.method === "POST" && ["/v1/flows", "/v1/executions", "/v1/executions/:executionId/signals/:signalName"].includes(row.path) ? 201 : 200) : 403,
      row.method + " " + row.path + " as " + role);
    assert.equal(work > before, permits, "work boundary: " + row.path + " " + role);
  }
});
test("unknown routes/methods, traversal and aliases fail before touching the service", async (t) => {
  let work = 0;
  const server = createControlServer({ pool: { query: async () => { work++; return { rows: [] }; } } }, credentials);
  await listen(server); t.after(() => close(server));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
    const result = await fetch(base + "/v1/flows", { method, headers: { authorization: "Bearer " + tokenFor("admin") } });
    assert.equal(result.status, 404, method);
  }
  for (const path of ["/v1/effects/effect_aaaaaaaa/force", "/v1/executions/exec_aaaaaaaa/admin"]) {
    const result = await fetch(base + path, { headers: { authorization: "Bearer " + tokenFor("admin") } });
    assert.equal(result.status, 404);
  }
  for (const path of ["/v1/%2e%2e/effects", "/v1/flows%2fx", "/v1/flows%5cx", "/v1//flows"]) {
    assert.equal(await raw(address.port, "GET", path, { Authorization: "Bearer " + tokenFor("admin") }), 400, path);
  }
  assert.equal(work, 0);
});
test("duplicate auth headers, forged headers, expired/revoked tokens cannot reach work", async (t) => {
  let work = 0;
  const server = createControlServer({ pool: { query: async () => { work++; return { rows: [] }; } } }, credentials);
  await listen(server); t.after(() => close(server));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  assert.ok([400, 401].includes(await raw(address.port, "GET", "/v1/flows", [
    "Authorization", "Bearer " + tokenFor("admin"),
    "authorization", "Bearer " + tokenFor("reader"),
  ])), "duplicate Authorization must fail closed (parser 400 or authenticator 401)");
  const base = "http://127.0.0.1:" + address.port;
  for (const headers of [
    { authorization: "Bearer " + "Z".repeat(44) },
    { authorization: "Basic " + tokenFor("admin") },
    { "x-user-id": "admin-service", "x-role": "admin", "x-tenant-id": "spoof" },
    { authorization: "Bearer " + tokenFor("admin") + "," + tokenFor("reader") },
  ]) {
    assert.equal((await fetch(base + "/v1/flows", { headers })).status, 401);
  }
  assert.equal(work, 0);
  const expired = createControlServer({ pool: { query: async () => { work++; return { rows: [] }; } } },
    [{ ...credentials[0], expiresAt: "2020-01-01T00:00:00Z" }]);
  await listen(expired); t.after(() => close(expired));
  const expiryPort = expired.address().port;
  assert.equal((await fetch("http://127.0.0.1:" + expiryPort + "/v1/flows",
    { headers: { authorization: "Bearer " + tokenFor("reader") } })).status, 401);
  const rotated = createControlServer({ pool: { query: async () => { work++; return { rows: [] }; } } },
    [{ id: "reader", role: "reader", sha256: createHash("sha256").update("rotated-service-key-xxxxxxxxxxxxxxxxxxxxxxxxxx").digest("hex") }]);
  await listen(rotated); t.after(() => close(rotated));
  assert.equal((await fetch("http://127.0.0.1:" + rotated.address().port + "/v1/flows",
    { headers: { authorization: "Bearer " + tokenFor("reader") } })).status, 401);
  assert.equal(work, 0);
});
