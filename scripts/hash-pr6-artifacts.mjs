import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifestPath = new URL("../docs/r7-pr6-manifest.sha256", import.meta.url);

const artifacts = [
  "package.json",
  "scripts/check-boundaries.mjs",
  "scripts/clean.mjs",
  "scripts/hash-pr6-artifacts.mjs",
  "packages/persistence/migrations/0004_durable_gates.up.sql",
  "packages/persistence/migrations/0004_durable_gates.down.sql",
  "packages/persistence/test/persistence.integration.test.mjs",
  "packages/queue/test/queue.integration.test.mjs",
  "packages/effects/test/effects.integration.test.mjs",
  "packages/gates/package.json",
  "packages/gates/tsconfig.json",
  "packages/gates/src/errors.ts",
  "packages/gates/src/gates.ts",
  "packages/gates/src/index.ts",
  "packages/gates/test/gates.integration.test.mjs",
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
  console.log("pr6-manifest: expected manifest not committed yet; generated hashes above");
  process.exit(0);
}

if (expected !== text) {
  console.error("pr6-manifest: artifact digest mismatch");
  console.error("--- expected ---\n" + expected + "--- generated ---\n" + text);
  process.exit(1);
}
console.log(`pr6-manifest: verified ${artifacts.length} executable/config artifacts`);
