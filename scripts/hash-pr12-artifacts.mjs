import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifestPath = new URL("../docs/r7-pr12-manifest.sha256", import.meta.url);
const artifacts = [
  "package.json",
  ".github/workflows/ci.yml",
  "benchmarks/pr12-demo.mjs",
  "benchmarks/worker-crash-child.mjs",
  "examples/incident-response.flow.json",
  "docs/demo-benchmark.md",
  "docs/r7-pr12-requirements.md",
  "docs/r7-pr12-evidence.md",
  "docs/dependency-lock-manifest.sha256",
  "scripts/hash-pr12-artifacts.mjs",
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
  console.log("r7-pr12-manifest: expected manifest not committed yet; generated hashes above");
  process.exit(0);
}
if (expected !== text) {
  console.error("r7-pr12-manifest: artifact digest mismatch");
  console.error("--- expected ---\n" + expected + "--- generated ---\n" + text);
  process.exit(1);
}
console.log(`r7-pr12-manifest: verified ${artifacts.length} PR12 artifacts`);
