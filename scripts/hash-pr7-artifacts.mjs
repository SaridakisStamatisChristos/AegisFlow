import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifestPath = new URL("../docs/r7-pr7-manifest.sha256", import.meta.url);

const artifacts = [
  "package.json",
  "scripts/check-boundaries.mjs",
  "scripts/clean.mjs",
  "scripts/test-postgres.mjs",
  "scripts/hash-pr7-artifacts.mjs",
  "packages/persistence/migrations/0005_agent_provider_results.up.sql",
  "packages/persistence/migrations/0005_agent_provider_results.down.sql",
  "packages/persistence/test/persistence.integration.test.mjs",
  "packages/providers/package.json",
  "packages/providers/tsconfig.json",
  "packages/providers/src/errors.ts",
  "packages/providers/src/provider.ts",
  "packages/providers/src/schema.ts",
  "packages/providers/src/runtime.ts",
  "packages/providers/src/index.ts",
  "packages/providers/test/provider.test.mjs",
  "packages/providers/test/runtime.integration.test.mjs",
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
  console.log("pr7-manifest: expected manifest not committed yet; generated hashes above");
  process.exit(0);
}

if (expected !== text) {
  console.error("pr7-manifest: artifact digest mismatch");
  console.error("--- expected ---\n" + expected + "--- generated ---\n" + text);
  process.exit(1);
}
console.log(`pr7-manifest: verified ${artifacts.length} executable/config artifacts`);
