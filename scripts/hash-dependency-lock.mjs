import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifestPath = new URL("../docs/dependency-lock-manifest.sha256", import.meta.url);
const artifacts = [
  "package.json",
  "package-lock.json",
  ".github/workflows/ci.yml",
  "scripts/hash-dependency-lock.mjs",
  "packages/api/package.json",
  "packages/cli/package.json",
  "packages/console/package.json",
  "packages/connectors/package.json",
  "packages/contracts/package.json",
  "packages/core/package.json",
  "packages/effects/package.json",
  "packages/gates/package.json",
  "packages/persistence/package.json",
  "packages/providers/package.json",
  "packages/queue/package.json",
  "packages/sdk/package.json",
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
  process.stdout.write(text); console.log("dependency-lock-manifest: expected manifest not committed yet; generated hashes above"); process.exit(0);
}
if (expected !== text) {
  console.error("dependency-lock-manifest: artifact digest mismatch");
  console.error("--- expected ---\n" + expected + "--- generated ---\n" + text); process.exit(1);
}
console.log(`dependency-lock-manifest: verified ${artifacts.length} dependency/config artifacts`);
