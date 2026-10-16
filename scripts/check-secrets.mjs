import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const ignored = new Set(["node_modules", "dist", ".git"]);
const textExtensions = new Set([".ts", ".mjs", ".json", ".md", ".yml", ".yaml", ".env"]);
const patterns = [
  ["GitHub token", /gh[pousr]_[A-Za-z0-9_]{30,}/g],
  ["OpenAI-style key", /sk-[A-Za-z0-9_-]{24,}/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];
const failures = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!textExtensions.has(extname(entry.name)) && entry.name !== "LICENSE") continue;
    const text = await readFile(path, "utf8");
    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) failures.push(`${relative(root, path)}: possible ${label}`);
      pattern.lastIndex = 0;
    }
  }
}

await walk(root);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("secret-scan: no high-confidence credential patterns found");
