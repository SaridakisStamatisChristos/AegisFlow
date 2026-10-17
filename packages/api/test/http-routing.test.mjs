import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { createControlServer } from "../dist/index.js";

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
  const server = createControlServer({});
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
