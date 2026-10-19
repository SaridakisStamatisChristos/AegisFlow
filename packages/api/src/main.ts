#!/usr/bin/env node
import { PostgresFlowScheduler } from "@aegisflow/flows";
import { Pool } from "pg";
import { PostgresControlService } from "./control-service.js";
import { createControlServer } from "./http.js";
import { parseApiCredentials } from "./auth.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required.");
}
const parsedPort = Number(process.env.PORT ?? "8080");
if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const schedulerIntervalMs = Number(process.env.AEGISFLOW_SCHEDULER_INTERVAL_MS ?? "1000");
if (
  !Number.isSafeInteger(schedulerIntervalMs) ||
  schedulerIntervalMs < 50 ||
  schedulerIntervalMs > 60_000
) {
  throw new Error("AEGISFLOW_SCHEDULER_INTERVAL_MS must be an integer between 50 and 60000.");
}

const pool = new Pool({ connectionString: databaseUrl });
const service = new PostgresControlService(pool);
const scheduler = new PostgresFlowScheduler(pool);
const server = createControlServer(service, parseApiCredentials(process.env.AEGISFLOW_API_KEYS_JSON));
const bindHost = process.env.AEGISFLOW_API_HOST ?? "127.0.0.1";
let schedulerRunning = false;
let shuttingDown = false;

async function runSchedulerTick(): Promise<void> {
  if (schedulerRunning || shuttingDown) return;
  schedulerRunning = true;
  try {
    await scheduler.tick();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown scheduler failure";
    process.stderr.write(`AegisFlow scheduler tick failed: ${message}\n`);
  } finally {
    schedulerRunning = false;
  }
}

const schedulerTimer = setInterval(() => void runSchedulerTick(), schedulerIntervalMs);
schedulerTimer.unref();

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(schedulerTimer);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

server.listen(parsedPort, bindHost, () => {
  process.stdout.write(`AegisFlow Control API listening on port ${parsedPort}\n`);
  void runSchedulerTick();
});
