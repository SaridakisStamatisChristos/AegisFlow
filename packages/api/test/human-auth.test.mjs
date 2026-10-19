import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createControlServer, createHumanAuthenticator, readHumanSettings } from "../dist/index.js";

const issuer = "https://login.example.invalid";
const audience = "aegisflow-console";
const token = "humanBoundMachineToken_xxxxxxxxxxxxxxxx";
const credentials = [{ id: "console-machine", sha256: createHash("sha256").update(token).digest("hex"),
  role: "admin", requiresHuman: true }];
async function bind(server) {
  await new Promise((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", ok); });
  return "http://127.0.0.1:" + server.address().port;
}
async function close(server) { await new Promise((ok, no) => server.close(err => err ? no(err) : ok())); }

test("human configuration rejects unknown roles and untrusted JWKS URI", () => {
  const env = { AEGISFLOW_OIDC_ISSUER: issuer, AEGISFLOW_OIDC_CLIENT_ID: audience,
    AEGISFLOW_OIDC_JWKS_URI: "https://login.example.invalid/keys",
    AEGISFLOW_HUMAN_ACCESS_JSON: JSON.stringify({ "operator-one": "reader" }) };
  assert.equal(readHumanSettings(env).users["operator-one"], "reader");
  assert.throws(() => readHumanSettings({ ...env, AEGISFLOW_OIDC_JWKS_URI: "http://attacker.test/jwks" }), /HTTPS/);
  assert.throws(() => readHumanSettings({ ...env, AEGISFLOW_HUMAN_ACCESS_JSON: '{"operator-one":"superadmin"}' }), /invalid/);
});

test("human OIDC proof and service permission must BOTH authorize before side effects", async (t) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-kid", alg: "RS256", use: "sig" };
  const users = { "operator-one": "approver", "operator-two": "reader" };
  const human = createHumanAuthenticator({
    issuer, audience, jwksUri: "https://login.example.invalid/keys", users,
  }, createLocalJWKSet({ keys: [jwk] }));
  let work = 0, recordedActor = "";
  const service = { pool: { async query() { work++; return { rows: [] }; } },
    async resolveGate(_id, _decision, actor) { work++; recordedActor = actor; return { changed: true }; } };
  const server = createControlServer(service, credentials, human);
  const base = await bind(server); t.after(() => close(server));
  async function jwt(sub, opts = {}) {
    return await new SignJWT({ ...opts }).setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(opts.issuer ?? issuer).setAudience(opts.audience ?? audience)
      .setSubject(sub).setIssuedAt().setExpirationTime(opts.exp ?? "5m").sign(privateKey);
  }
  async function send(sub, opts = {}) {
    const headers = { authorization: "Bearer " + (opts.machine ?? token),
      ...(opts.noHuman ? {} : { "x-aegisflow-human-id-token": opts.humanToken ?? await jwt(sub) }),
      "content-type": "application/json" };
    return await fetch(base + "/v1/gates/gate_aaaaaaaa/approve", { method: "POST", headers,
      body: JSON.stringify({ actorId: "forged-admin", evidence: { source: "test" } }) });
  }
  assert.equal((await send("operator-one", { noHuman: true })).status, 401);
  assert.equal((await send("operator-one", { machine: "invalid-token-xxxxxxxxxxxxxxxxxxxxxxxx" })).status, 401);
  assert.equal((await send("operator-two")).status, 403, "reader cannot approve via direct API");
  assert.equal((await send("unlisted-person")).status, 403);
  assert.equal((await send("operator-one", { humanToken: await jwt("operator-one", { audience: "wrong-audience" }) })).status, 401);
  assert.equal((await send("operator-one", { humanToken: await jwt("operator-one", { issuer: "https://evil.invalid" }) })).status, 401);
  assert.equal((await send("operator-one", { humanToken: await jwt("operator-one", { exp: "-1h" }) })).status, 401);
  assert.equal((await send("operator-one", { humanToken: "garbage.invalid.signature" })).status, 401);
  assert.equal(work, 0, "none of the denied attempts touch DB/business service");
  assert.equal((await send("operator-one")).status, 200);
  assert.equal(work, 1);
  assert.match(recordedActor, /^oidc-[0-9a-f]{64}$/);
  assert.notEqual(recordedActor, "forged-admin");
  assert.notEqual(recordedActor, credentials[0].id);
});

test("human-bound service credential cannot silently work without verifier", () => {
  assert.throws(() => createControlServer({ pool: {} }, credentials), /OIDC verifier/);
});
