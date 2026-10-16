import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const contractsRoot = join(root, "packages", "contracts", "src");
const forbiddenImport = /from\s+["'](?!\.\/|\.\.\/)([^"']+)["']/g;
const failures = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(forbiddenImport)) {
      failures.push(`${relative(root, path)} imports external module '${match[1]}'`);
    }
  }
}

await walk(contractsRoot);
if (failures.length > 0) {
  console.error("contracts boundary violation:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("boundaries: @aegisflow/contracts has no adapter/framework dependencies");
