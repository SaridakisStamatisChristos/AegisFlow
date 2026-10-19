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
