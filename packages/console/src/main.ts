#!/usr/bin/env node
import { AegisFlowClient } from "@aegisflow/sdk";
import { createOperatorConsoleServer } from "./index.js";

const apiBaseUrl = process.env.AEGISFLOW_BASE_URL ?? "http://127.0.0.1:8080";
const host = process.env.AEGISFLOW_CONSOLE_HOST ?? "127.0.0.1";
const portValue = process.env.AEGISFLOW_CONSOLE_PORT ?? "8081";
const port = Number.parseInt(portValue, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AEGISFLOW_CONSOLE_PORT must be an integer from 1 to 65535.");

const apiToken = process.env.AEGISFLOW_API_TOKEN;
if (apiToken === undefined || apiToken.length === 0) throw new Error("AEGISFLOW_API_TOKEN is required for the console API client.");
// Browser authentication remains the responsibility of the reverse proxy.
if (!["127.0.0.1", "::1", "localhost"].includes(host) && process.env.AEGISFLOW_CONSOLE_TRUSTED_PROXY !== "1") {
  throw new Error("Non-loopback console binding requires AEGISFLOW_CONSOLE_TRUSTED_PROXY=1 and authenticated reverse-proxy enforcement.");
}
const server = createOperatorConsoleServer({ client: new AegisFlowClient({ baseUrl: apiBaseUrl, apiToken }) });
server.listen(port, host, () => {
  console.log(`AegisFlow operator console listening on http://${host}:${port} (API ${apiBaseUrl})`);
});
