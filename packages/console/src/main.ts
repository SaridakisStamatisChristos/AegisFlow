#!/usr/bin/env node
import { AegisFlowClient } from "@aegisflow/sdk";
import { createOperatorConsoleServer } from "./index.js";

const apiBaseUrl = process.env.AEGISFLOW_BASE_URL ?? "http://127.0.0.1:8080";
const host = process.env.AEGISFLOW_CONSOLE_HOST ?? "127.0.0.1";
const portValue = process.env.AEGISFLOW_CONSOLE_PORT ?? "8081";
const port = Number.parseInt(portValue, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AEGISFLOW_CONSOLE_PORT must be an integer from 1 to 65535.");

const server = createOperatorConsoleServer({ client: new AegisFlowClient({ baseUrl: apiBaseUrl }) });
server.listen(port, host, () => {
  console.log(`AegisFlow operator console listening on http://${host}:${port} (API ${apiBaseUrl})`);
});
