import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const allowedExtensions = new Set([".ts", ".mjs", ".json", ".md", ".yml", ".yaml"]);
const ignored = new Set(["node_modules", "dist", ".git"]);
const failures = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!allowedExtensions.has(extname(entry.name))) continue;
    const text = await readFile(path, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (line.includes("\t")) failures.push(`${relative(root.pathname, path)}:${index + 1}: tab character`);
      if (/\s+$/.test(line) && line.length > 0 && extname(entry.name) !== ".md") {
        failures.push(`${relative(root.pathname, path)}:${index + 1}: trailing whitespace`);
      }
    });
    if (!text.endsWith("\n")) failures.push(`${relative(root.pathname, path)}: missing final newline`);
  }
}

await walk(root.pathname);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("lint: repository text hygiene passed");
