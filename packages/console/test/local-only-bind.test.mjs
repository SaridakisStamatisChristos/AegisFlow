import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
test("console refuses non-loopback binds even when proxy flag is supplied", () => {
  for (const host of ["0.0.0.0", "::", "localhost", "192.0.2.10"]) {
    const result = spawnSync(process.execPath, ["packages/console/dist/main.js"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 5000,
      env: { ...process.env, AEGISFLOW_API_TOKEN: "x".repeat(48),
        AEGISFLOW_CONSOLE_HOST: host, AEGISFLOW_CONSOLE_TRUSTED_PROXY: "1" },
    });
    assert.equal(result.status, 1, host);
    assert.match(result.stderr, /local-only/u, host);
  }
});

test("DNS-rebinding Host and cross-origin form submission are rejected before SDK use", async () => {
  const { createOperatorConsoleServer } = await import("../dist/index.js");
  const { request } = await import("node:http");
  let reads = 0, writes = 0;
  const server = createOperatorConsoleServer({
    csrfToken: "protected-form",
    client: {
      async listFlows() { reads++; return { flows: [], truncated: false }; },
      async startExecution() { writes++; return {}; },
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const send = (method, path, headers, body = "") => new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: address.port, path, method, headers },
        (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
      req.once("error", reject); req.end(body);
    });
    assert.equal(await send("GET", "/flows", { Host: "attacker.example" }), 400);
    assert.equal(reads, 0);
    const authority = "127.0.0.1:" + address.port;
    assert.equal(await send("GET", "/flows", { Host: authority }), 200);
    assert.equal(reads, 1);
    assert.equal(await send("POST", "/flows/flow_aaaaaaaa/start", {
      Host: authority, Origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded",
    }, "csrf=protected-form&idempotencyKey=safe"), 400);
    assert.equal(writes, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
