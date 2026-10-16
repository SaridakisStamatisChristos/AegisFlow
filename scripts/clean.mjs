import { rm } from "node:fs/promises";

await rm(new URL("../packages/contracts/dist", import.meta.url), {
  recursive: true,
  force: true,
});
