import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import test from "node:test";
import { createControlServer, parseApiCredentials } from "../dist/index.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("malformed percent-encoding is a 400 client error rather than a 500", async () => {
  const server = createControlServer({}, [{ id: "tester", sha256: createHash("sha256").update("aegisflowTestToken_xxxxxxxxxxxxxxxxxxxxx").digest("hex"), role: "reader" }]);
  await listen(server);
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await rawGet(address.port, "/v1/flows/%E0%A4%A");
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        code: "INVALID_INPUT",
        message: "Request path contains malformed percent-encoding.",
      },
    });
  } finally {
    await close(server);
  }
});

const testToken = "aegisflowTestToken_xxxxxxxxxxxxxxxxxxxxx";
const credential = (role, id = "agent") => ({
  id, role, sha256: createHash("sha256").update(testToken).digest("hex"),
});

test("API rejects missing, malformed and forged credentials before reads or side effects", async (t) => {
  let operations = 0;
  const service = {
    pool: { query: async () => { operations++; throw new Error("unauthorized DB access"); } },
    inspectExecution: async () => { operations++; return { authorized: true }; },
    cancelExecution: async () => { operations++; return { cancelled: true }; },
  };
  const server = createControlServer(service, [credential("operator")]);
  await listen(server);
  t.after(() => close(server));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const missing = await fetch(`${base}/v1/executions/exec_aaaaaaaa`);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="aegisflow"');
  assert.equal(missing.headers.get("cache-control"), "no-store");
  const wrong = await fetch(`${base}/v1/executions/exec_aaaaaaaa`, { headers: { authorization: "Bearer " + "b".repeat(43) } });
  assert.equal(wrong.status, 401);
  const malformed = await fetch(`${base}/v1/executions/exec_aaaaaaaa`, { headers: { authorization: "Basic " + testToken } });
  assert.equal(malformed.status, 401);
  const spoof = await fetch(`${base}/v1/executions/exec_aaaaaaaa`, { headers: { "x-user-id": "admin", "x-tenant-id": "other" } });
  assert.equal(spoof.status, 401);
  assert.equal(operations, 0);
  assert.equal((await fetch(`${base}/health/live`)).status, 200);
  const allowed = await fetch(`${base}/v1/executions/exec_aaaaaaaa`, { headers: { authorization: `Bearer ${testToken}` } });
  assert.equal(allowed.status, 200);
  assert.equal(operations, 1);
});

test("role permissions reject escalation before mutation and accept permitted execution", async (t) => {
  let mutations = 0;
  const service = {
    cancelExecution: async () => { mutations++; return { cancelled: true }; },
    resolveGate: async () => { mutations++; return { resolved: true }; },
    reconcileEffect: async () => { mutations++; return { reconciled: true }; },
  };
  const server = createControlServer(service, [credential("operator")]);
  await listen(server);
  t.after(() => close(server));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const options = { method: "POST", headers: { authorization: `Bearer ${testToken}`, "content-type": "application/json" }, body: "{}" };
  assert.equal((await fetch(`${base}/v1/executions/exec_aaaaaaaa/cancel`, options)).status, 200);
  assert.equal(mutations, 1);
  assert.equal((await fetch(`${base}/v1/gates/gate_aaaaaaaa/approve`, { ...options, body: JSON.stringify({ actorId: "admin" }) })).status, 403);
  assert.equal((await fetch(`${base}/v1/effects/effect_aaaaaaaa/reconcile`, { ...options, body: JSON.stringify({ decision: "CONFIRMED_SUCCEEDED", reconciledBy: "admin" }) })).status, 403);
  assert.equal(mutations, 1);
});

test("verified approver identity is required and expired credentials cannot act", async (t) => {
  let actor;
  const service = { resolveGate: async (_id, _decision, id) => { actor = id; return { resolved: true }; } };
  const server = createControlServer(service, [credential("approver", "reviewer")]);
  await listen(server);
  t.after(() => close(server));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const path = `http://127.0.0.1:${address.port}/v1/gates/gate_aaaaaaaa/approve`;
  const options = { method: "POST", headers: { authorization: `Bearer ${testToken}`, "content-type": "application/json" } };
  assert.equal((await fetch(path, { ...options, body: JSON.stringify({ actorId: "forged" }) })).status, 403);
  assert.equal(actor, undefined);
  assert.equal((await fetch(path, { ...options, body: JSON.stringify({ actorId: "reviewer" }) })).status, 200);
  assert.equal(actor, "reviewer");
  const expired = createControlServer({}, [{ ...credential("admin"), expiresAt: "2020-01-01T00:00:00Z" }]);
  await listen(expired);
  t.after(() => close(expired));
  const other = expired.address();
  assert.ok(other && typeof other !== "string");
  assert.equal((await fetch(`http://127.0.0.1:${other.port}/v1/flows`, { headers: { authorization: `Bearer ${testToken}` } })).status, 401);
});

test("empty, duplicate or malformed authorization configuration fails at startup", () => {
  assert.throws(() => createControlServer({}, []));
  assert.throws(() => parseApiCredentials(undefined));
  assert.throws(() => parseApiCredentials("not-json"));
  const sample = credential("admin");
  assert.throws(() => createControlServer({}, [sample, { ...sample, id: "other" }]));
  assert.throws(() => createControlServer({}, [{ ...sample, sha256: "0".repeat(64), role: "superuser" }]));
});
