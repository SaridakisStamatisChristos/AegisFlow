import { rm } from "node:fs/promises";

for (const packageName of [
  "contracts",
  "core",
  "persistence",
  "queue",
  "effects",
  "gates",
  "connectors",
  "providers",
  "sdk",
  "api",
  "cli",
]) {
  await rm(new URL(`../packages/${packageName}/dist`, import.meta.url), {
    recursive: true,
    force: true,
  });
}
