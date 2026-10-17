import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorInvocationError,
  ConnectorRegistry,
  GitHubConnector,
  HttpConnector,
  SlackConnector,
  ToolRuntimeError,
  normalizeConnectorResult,
} from "../dist/index.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

test("registry rejects duplicate tool authority", () => {
  const connector = { toolName: "test.tool", authorityScope: "test", async execute() { return { output: {} }; } };
  const registry = new ConnectorRegistry([connector]);
  assert.throws(() => registry.register(connector), (error) => error instanceof ToolRuntimeError && error.code === "CONNECTOR_CONFLICT");
});

test("normalized connector JSON keeps ordinary semantics without prototype mutation", () => {
  const payload = JSON.parse('{"safe":1,"__proto__":{"polluted":true}}');
  const result = normalizeConnectorResult({ output: payload });
  assert.equal(Object.getPrototypeOf(result.output), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(result.output, "__proto__"), true);
});

test("HTTP connector rejects unapproved origins and credential headers before transport", async () => {
  let calls = 0;
  const connector = new HttpConnector({
    allowedOrigins: ["https://api.example.test"],
    authorityScope: "example-api",
    fetch: async () => { calls += 1; return jsonResponse({ ok: true }); },
  });
  await assert.rejects(
    connector.execute({ url: "https://evil.example.test/x" }, { effectKey: "effect" }),
    (error) => error instanceof ConnectorInvocationError && error.connectorCode === "origin_not_allowed",
  );
  await assert.rejects(
    connector.execute({ url: "https://api.example.test/x", headers: { Authorization: "secret" } }, { effectKey: "effect" }),
    (error) => error instanceof ConnectorInvocationError && error.connectorCode === "forbidden_header",
  );
  assert.equal(calls, 0);
});

test("GitHub connector injects credentials while tool input cannot replace them", async () => {
  let observed;
  const connector = new GitHubConnector({
    token: "github-secret-token",
    authorityScope: "github:repo:test",
    fetch: async (url, init) => {
      observed = { url: String(url), init };
      return jsonResponse({ id: 1 }, { headers: { "x-github-request-id": "GH-123" } });
    },
  });
  const result = await connector.execute({ path: "/repos/acme/demo", query: { page: 2 } }, { effectKey: "effect" });
  assert.match(observed.url, /^https:\/\/api\.github\.com\/repos\/acme\/demo\?page=2$/);
  assert.equal(observed.init.headers.authorization, "Bearer github-secret-token");
  assert.equal(result.externalReference, "GH-123");
});

test("GitHub connector cannot escape api.github.com through network-path references", async () => {
  let calls = 0;
  const connector = new GitHubConnector({
    token: "token",
    authorityScope: "github:test",
    fetch: async () => { calls += 1; return jsonResponse({}); },
  });
  await assert.rejects(
    connector.execute({ path: "//evil.example.test/repos/x" }, { effectKey: "effect" }),
    (error) => error instanceof ConnectorInvocationError && error.connectorCode === "origin_not_allowed",
  );
  assert.equal(calls, 0);
});

test("Slack connector is fixed to chat.postMessage and extracts message ts evidence", async () => {
  let observed;
  const connector = new SlackConnector({
    token: "slack-secret-token",
    authorityScope: "slack:channel:C123",
    fetch: async (url, init) => {
      observed = { url: String(url), init };
      return jsonResponse({ ok: true, channel: "C123", ts: "12345.6789" });
    },
  });
  const result = await connector.execute({ channel: "C123", text: "hello" }, { effectKey: "effect" });
  assert.equal(observed.url, "https://slack.com/api/chat.postMessage");
  assert.equal(observed.init.headers.authorization, "Bearer slack-secret-token");
  assert.equal(result.externalReference, "12345.6789");
});
