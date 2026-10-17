import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifestPath = new URL("../docs/r7-pr11-manifest.sha256", import.meta.url);
const artifacts = [
  "package.json",
  "package-lock.json",
  "packages/api/src/http.ts",
  "packages/api/src/operator-views.ts",
  "packages/api/test/operator-views.integration.test.mjs",
  "packages/sdk/src/client.ts",
  "packages/console/package.json",
  "packages/console/tsconfig.json",
  "packages/console/src/index.ts",
  "packages/console/src/main.ts",
  "packages/console/test/console.test.mjs",
  "scripts/check-boundaries.mjs",
  "scripts/clean.mjs",
  "scripts/hash-dependency-lock.mjs",
  "scripts/hash-pr11-artifacts.mjs",
  "scripts/test-postgres.mjs",
  "docs/dependency-lock-manifest.sha256",
  "docs/operator-console.md",
  "docs/r7-pr11-requirements.md",
  "docs/r7-pr11-evidence.md",
];
const generated = [];
for (const path of artifacts) {
  const bytes = await readFile(new URL(path, root));
  generated.push(`${createHash("sha256").update(bytes).digest("hex")}  ${path}`);
}
const text = `${generated.join("\n")}\n`;
let expected;
try { expected = await readFile(manifestPath, "utf8"); }
catch (error) {
  if (error?.code !== "ENOENT") throw error;
  process.stdout.write(text); console.log("r7-pr11-manifest: expected manifest not committed yet; generated hashes above"); process.exit(0);
}
if (expected !== text) {
  console.error("r7-pr11-manifest: artifact digest mismatch");
  console.error("--- expected ---\n" + expected + "--- generated ---\n" + text); process.exit(1);
}
console.log(`r7-pr11-manifest: verified ${artifacts.length} PR11 artifacts`);
