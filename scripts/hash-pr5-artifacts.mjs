import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifestUrl = new URL("docs/r7-pr5-manifest.sha256", root);
const artifacts = Object.freeze([
  "package.json",
  "scripts/check-boundaries.mjs",
  "scripts/clean.mjs",
  "scripts/hash-pr5-artifacts.mjs",
  "packages/persistence/migrations/0003_effect_ledger.up.sql",
  "packages/persistence/migrations/0003_effect_ledger.down.sql",
  "packages/persistence/test/persistence.integration.test.mjs",
  "packages/queue/test/queue.integration.test.mjs",
  "packages/effects/package.json",
  "packages/effects/tsconfig.json",
  "packages/effects/src/errors.ts",
  "packages/effects/src/effects.ts",
  "packages/effects/src/index.ts",
  "packages/effects/test/effects.integration.test.mjs",
]);

const lines = [];
for (const path of artifacts) {
  const content = await readFile(new URL(path, root));
  const digest = createHash("sha256").update(content).digest("hex");
  lines.push(`${digest}  ${path}`);
}
const generated = `${lines.join("\n")}\n`;

let expected = null;
try {
  expected = await readFile(manifestUrl, "utf8");
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

if (expected === null) {
  process.stdout.write(generated);
  console.log("pr5-manifest: expected manifest not committed yet; generated hashes above");
} else if (expected !== generated) {
  console.error("pr5-manifest: mismatch");
  console.error("expected:\n" + expected);
  console.error("generated:\n" + generated);
  process.exit(1);
} else {
  console.log(`pr5-manifest: verified ${artifacts.length} artifacts`);
}
