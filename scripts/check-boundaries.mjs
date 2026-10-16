import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const failures = [];
const packageRules = [
  {
    name: "@aegisflow/contracts",
    sourceRoot: join(root, "packages", "contracts", "src"),
    allows(specifier) {
      return specifier.startsWith("./") || specifier.startsWith("../");
    },
  },
  {
    name: "@aegisflow/core",
    sourceRoot: join(root, "packages", "core", "src"),
    allows(specifier) {
      return (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier === "@aegisflow/contracts"
      );
    },
  },
  {
    name: "@aegisflow/persistence",
    sourceRoot: join(root, "packages", "persistence", "src"),
    allows(specifier) {
      return (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier === "@aegisflow/contracts" ||
        specifier === "pg" ||
        specifier.startsWith("node:")
      );
    },
  },
  {
    name: "@aegisflow/queue",
    sourceRoot: join(root, "packages", "queue", "src"),
    allows(specifier) {
      return (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier === "@aegisflow/contracts" ||
        specifier === "@aegisflow/core" ||
        specifier === "@aegisflow/persistence" ||
        specifier === "pg"
      );
    },
  },
  {
    name: "@aegisflow/effects",
    sourceRoot: join(root, "packages", "effects", "src"),
    allows(specifier) {
      return (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier === "@aegisflow/contracts" ||
        specifier === "@aegisflow/core" ||
        specifier === "@aegisflow/persistence" ||
        specifier === "pg" ||
        specifier.startsWith("node:")
      );
    },
  },
  {
    name: "@aegisflow/gates",
    sourceRoot: join(root, "packages", "gates", "src"),
    allows(specifier) {
      return (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier === "@aegisflow/contracts" ||
        specifier === "@aegisflow/core" ||
        specifier === "@aegisflow/persistence" ||
        specifier === "pg" ||
        specifier.startsWith("node:")
      );
    },
  },
  {
    name: "@aegisflow/providers",
    sourceRoot: join(root, "packages", "providers", "src"),
    allows(specifier) {
      return (
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier === "@aegisflow/contracts" ||
        specifier === "@aegisflow/effects" ||
        specifier === "@aegisflow/queue" ||
        specifier === "pg" ||
        specifier.startsWith("node:")
      );
    },
  },
];

const importPattern = /(?:from\s+|import\s*)["']([^"']+)["']/g;

async function walk(rule, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(rule, path);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier !== undefined && !rule.allows(specifier)) {
        failures.push(`${relative(root, path)} imports forbidden module '${specifier}'`);
      }
    }
  }
}

for (const rule of packageRules) {
  await walk(rule, rule.sourceRoot);
}

if (failures.length > 0) {
  console.error("architecture boundary violation:\n" + failures.join("\n"));
  process.exit(1);
}
console.log(
  "boundaries: contracts isolated; core -> contracts; persistence -> contracts + PostgreSQL; queue/effects/gates -> contracts + core + persistence + PostgreSQL; providers -> contracts + queue + effects + PostgreSQL",
);
