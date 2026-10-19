#!/usr/bin/env node
import { createOperatorConsoleServer } from "./index.js";
import { createOidcConsoleAuthorization } from "./oidc.js";

const apiBaseUrl = process.env.AEGISFLOW_BASE_URL ?? "http://127.0.0.1:8080";
const host = process.env.AEGISFLOW_CONSOLE_HOST ?? "127.0.0.1";
const portValue = process.env.AEGISFLOW_CONSOLE_PORT ?? "8081";
const port = Number.parseInt(portValue, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AEGISFLOW_CONSOLE_PORT must be an integer from 1 to 65535.");

const apiToken = process.env.AEGISFLOW_API_TOKEN;
if (apiToken === undefined || apiToken.length === 0) throw new Error("AEGISFLOW_API_TOKEN is required for the console API client.");
// No browser authentication is implemented. Never bind the shared-service console remotely.
if (!["127.0.0.1", "::1"].includes(host)) {
  throw new Error("Operator console is local-only: bind to 127.0.0.1 or ::1. A proxy flag does not establish browser authentication.");
}
const issuer = process.env.AEGISFLOW_OIDC_ISSUER;
const clientId = process.env.AEGISFLOW_OIDC_CLIENT_ID;
const clientSecret = process.env.AEGISFLOW_OIDC_CLIENT_SECRET;
const redirectUri = process.env.AEGISFLOW_OIDC_REDIRECT_URI;
if (!issuer || !clientId || !clientSecret || !redirectUri) {
  throw new Error("Console requires OIDC issuer, client ID, client secret and exact redirect URI.");
}
const expectedRedirect = `http://${host === "::1" ? "[::1]" : host}:${port}/auth/callback`;
if (redirectUri !== expectedRedirect) {
  throw new Error("Local-only console OIDC redirect URI must exactly match " + expectedRedirect);
}
const authorize = await createOidcConsoleAuthorization({
  issuer, clientId, clientSecret, redirectUri, baseUrl: apiBaseUrl, apiToken,
});
const server = createOperatorConsoleServer({ authorize });
server.listen(port, host, () => {
  console.log(`AegisFlow operator console listening on http://${host}:${port} (API ${apiBaseUrl})`);
});
