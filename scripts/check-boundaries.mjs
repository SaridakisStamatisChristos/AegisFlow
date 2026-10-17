import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const failures = [];
const rules = [
  ["contracts", ["@aegisflow/contracts"]],
  ["core", ["@aegisflow/contracts"]],
  ["persistence", ["@aegisflow/contracts", "pg"]],
  ["queue", ["@aegisflow/contracts", "@aegisflow/core", "@aegisflow/persistence", "pg"]],
  ["effects", ["@aegisflow/contracts", "@aegisflow/core", "@aegisflow/persistence", "pg"]],
  ["gates", ["@aegisflow/contracts", "@aegisflow/core", "@aegisflow/persistence", "pg"]],
  ["connectors", ["@aegisflow/contracts", "@aegisflow/effects", "pg"]],
  ["providers", ["@aegisflow/connectors", "@aegisflow/contracts", "@aegisflow/effects", "@aegisflow/queue", "pg"]],
  ["sdk", ["@aegisflow/contracts"]],
  ["api", ["@aegisflow/contracts", "@aegisflow/core", "@aegisflow/effects", "@aegisflow/gates", "pg"]],
];

const importPattern = /(?:from\s+|import\s*)["']([^"']+)["']/g;

async function walk(packageName, allowed, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(packageName, allowed, path);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1];
      const okay = specifier !== undefined && (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier.startsWith("node:") ||
        allowed.includes(specifier)
      );
      if (!okay) failures.push(`${relative(root, path)} imports forbidden module '${specifier}'`);
    }
  }
}

for (const [packageName, allowed] of rules) {
  await walk(packageName, allowed, join(root, "packages", packageName, "src"));
}

if (failures.length > 0) {
  console.error("architecture boundary violation:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("boundaries: domain layers remain inward-facing; SDK -> contracts; API -> contracts/core/effects/gates/PostgreSQL");
