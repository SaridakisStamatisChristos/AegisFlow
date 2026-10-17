#!/usr/bin/env node
import { Pool } from "pg";
import { PostgresControlService } from "./control-service.js";
import { createControlServer } from "./http.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required.");
}
const parsedPort = Number(process.env.PORT ?? "8080");
if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const pool = new Pool({ connectionString: databaseUrl });
const service = new PostgresControlService(pool);
const server = createControlServer(service);

async function shutdown(): Promise<void> {
  server.close();
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

server.listen(parsedPort, "0.0.0.0", () => {
  process.stdout.write(`AegisFlow Control API listening on port ${parsedPort}\n`);
});
