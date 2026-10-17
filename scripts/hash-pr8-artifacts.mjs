import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifestPath = new URL("../docs/r7-pr8-manifest.sha256", import.meta.url);

const artifacts = [
  "package.json",
  "scripts/check-boundaries.mjs",
  "scripts/clean.mjs",
  "scripts/test-postgres.mjs",
  "scripts/hash-pr8-artifacts.mjs",
  "packages/persistence/migrations/0006_agent_tool_results.up.sql",
  "packages/persistence/migrations/0006_agent_tool_results.down.sql",
  "packages/persistence/test/persistence.integration.test.mjs",
  "packages/connectors/package.json",
  "packages/connectors/tsconfig.json",
  "packages/connectors/src/errors.ts",
  "packages/connectors/src/connector.ts",
  "packages/connectors/src/http.ts",
  "packages/connectors/src/github.ts",
  "packages/connectors/src/slack.ts",
  "packages/connectors/src/runtime.ts",
  "packages/connectors/src/index.ts",
  "packages/connectors/test/connectors.test.mjs",
  "packages/connectors/test/runtime.integration.test.mjs",
  "packages/providers/package.json",
  "packages/providers/src/tool-context.ts",
  "packages/providers/src/runtime-v8.ts",
  "packages/providers/src/index.ts",
  "packages/providers/test/runtime.integration.test.mjs",
  "packages/providers/test/runtime-v8.integration.test.mjs",
  "packages/providers/test/runtime-v8-fencing.integration.test.mjs",
];

const generated = [];
for (const path of artifacts) {
  const bytes = await readFile(new URL(path, root));
  const digest = createHash("sha256").update(bytes).digest("hex");
  generated.push(`${digest}  ${path}`);
}
const text = `${generated.join("\n")}\n`;

let expected;
try {
  expected = await readFile(manifestPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  process.stdout.write(text);
  console.log("pr8-manifest: expected manifest not committed yet; generated hashes above");
  process.exit(0);
}

if (expected !== text) {
  console.error("pr8-manifest: artifact digest mismatch");
  console.error("--- expected ---\n" + expected + "--- generated ---\n" + text);
  process.exit(1);
}
console.log(`pr8-manifest: verified ${artifacts.length} executable/config/test artifacts`);
