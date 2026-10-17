import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifestPath = new URL("../docs/r7-pr9-manifest.sha256", import.meta.url);
const artifacts = [
  "package.json",
  "packages/api/package.json",
  "packages/api/tsconfig.json",
  "packages/api/src/errors.ts",
  "packages/api/src/control-service.ts",
  "packages/api/src/http.ts",
  "packages/api/src/index.ts",
  "packages/api/src/main.ts",
  "packages/api/test/control-api.integration.test.mjs",
  "packages/sdk/package.json",
  "packages/sdk/tsconfig.json",
  "packages/sdk/src/client.ts",
  "packages/sdk/src/index.ts",
  "packages/sdk/test/client.test.mjs",
  "packages/persistence/migrations/0007_control_api.up.sql",
  "packages/persistence/migrations/0007_control_api.down.sql",
  "packages/persistence/test/persistence.integration.test.mjs",
  "scripts/check-boundaries.mjs",
  "scripts/clean.mjs",
  "scripts/test-postgres.mjs",
  "scripts/hash-pr9-artifacts.mjs",
  "docs/control-api.md",
  "docs/r7-pr9-requirements.md",
  "docs/r7-pr9-evidence.md",
];

const generated = [];
for (const path of artifacts) {
  const bytes = await readFile(new URL(path, root));
  generated.push(`${createHash("sha256").update(bytes).digest("hex")}  ${path}`);
}
const text = `${generated.join("\n")}\n`;

let expected;
try {
  expected = await readFile(manifestPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  process.stdout.write(text);
  console.log("r7-pr9-manifest: expected manifest not committed yet; generated hashes above");
  process.exit(0);
}
if (expected !== text) {
  console.error("r7-pr9-manifest: artifact digest mismatch");
  console.error("--- expected ---\n" + expected + "--- generated ---\n" + text);
  process.exit(1);
}
console.log(`r7-pr9-manifest: verified ${artifacts.length} PR9 artifacts`);
