import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifestPath = new URL("../docs/r7-pr10-manifest.sha256", import.meta.url);
const artifacts = [
  "package.json",
  "package-lock.json",
  "packages/cli/package.json",
  "packages/cli/tsconfig.json",
  "packages/cli/src/index.ts",
  "packages/cli/src/bin.ts",
  "packages/cli/test/cli.test.mjs",
  "scripts/check-boundaries.mjs",
  "scripts/clean.mjs",
  "scripts/hash-dependency-lock.mjs",
  "scripts/hash-pr10-artifacts.mjs",
  "docs/dependency-lock-manifest.sha256",
  "docs/cli.md",
  "docs/r7-pr10-requirements.md",
  "docs/r7-pr10-evidence.md",
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
  console.log("r7-pr10-manifest: expected manifest not committed yet; generated hashes above");
  process.exit(0);
}
if (expected !== text) {
  console.error("r7-pr10-manifest: artifact digest mismatch");
  console.error("--- expected ---\n" + expected + "--- generated ---\n" + text);
  process.exit(1);
}
console.log(`r7-pr10-manifest: verified ${artifacts.length} PR10 artifacts`);
