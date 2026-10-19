import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ControlApiError } from "./errors.js";
import type { ApiCapability, ApiPrincipal, ApiRole } from "./auth.js";

export interface HumanAuthSettings {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  readonly users: Readonly<Record<string, ApiRole>>;
}

const capabilities: Readonly<Record<ApiRole, readonly ApiCapability[]>> = {
  reader: ["read"], operator: ["read", "execute"],
  approver: ["read", "approve"], reconciler: ["read", "reconcile"],
  admin: ["read", "execute", "approve", "reconcile"],
};
export function readHumanSettings(env: NodeJS.ProcessEnv): HumanAuthSettings {
  const issuer = env.AEGISFLOW_OIDC_ISSUER;
  const audience = env.AEGISFLOW_OIDC_CLIENT_ID;
  const jwksUri = env.AEGISFLOW_OIDC_JWKS_URI;
  if (!issuer || !audience || !jwksUri) throw new Error("OIDC issuer, client ID and JWKS URI are required for human-bound API credentials.");
  for (const [label, value] of [["issuer", issuer], ["JWKS URI", jwksUri]]) {
    const url = new URL(value!);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("OIDC " + label + " must be an HTTPS URL without credentials/fragments.");
    }
  }
  let users: unknown;
  try { users = JSON.parse(env.AEGISFLOW_HUMAN_ACCESS_JSON ?? ""); }
  catch { throw new Error("AEGISFLOW_HUMAN_ACCESS_JSON must be a JSON map of allowed subjects to roles."); }
  if (typeof users !== "object" || users === null || Array.isArray(users)) throw new Error("Human access must be an object.");
  const entries = Object.entries(users);
  if (entries.length === 0 || entries.length > 256 ||
      entries.some(([id, role]) => !id || id.length > 256 ||
        typeof role !== "string" || !Object.hasOwn(capabilities, role))) {
    throw new Error("Human access contains an invalid subject or role.");
  }
  return { issuer, audience, jwksUri, users: Object.freeze(Object.fromEntries(entries)) as Record<string, ApiRole> };
}

export interface HumanActor { readonly id: string; readonly subject: string; readonly role: ApiRole }
export function createHumanAuthenticator(
  settings: HumanAuthSettings, keySet: JWTVerifyGetKey = createRemoteJWKSet(new URL(settings.jwksUri)),
): (request: IncomingMessage, service: ApiPrincipal, capability: ApiCapability) => Promise<HumanActor | undefined> {
  return async (request, service, capability) => {
    const count = request.rawHeaders.filter((header, i) =>
      i % 2 === 0 && header.toLowerCase() === "x-aegisflow-human-id-token").length;
    if (!service.requiresHuman) {
      if (count !== 0) throw new ControlApiError("FORBIDDEN", "Human assertion requires an explicitly human-bound service credential.");
      return undefined;
    }
    const raw = request.headers["x-aegisflow-human-id-token"];
    if (count !== 1 || typeof raw !== "string" || raw.length > 8192 || raw.length < 32) {
      throw new ControlApiError("UNAUTHENTICATED", "Verified human identity required.");
    }
    try {
      const { payload } = await jwtVerify(raw, keySet, {
        issuer: settings.issuer,
        audience: settings.audience,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["exp", "iat", "sub"],
      });
      if (typeof payload.sub !== "string" || !payload.sub ||
          typeof payload.iat !== "number" || payload.iat > Math.floor(Date.now() / 1000) + 60 ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== settings.audience)) {
        throw new Error("Invalid human token claims.");
      }
      const role = settings.users[payload.sub];
      if (role === undefined) throw new ControlApiError("FORBIDDEN", "Human operator is not provisioned.");
      if (!capabilities[role].includes(capability)) throw new ControlApiError("FORBIDDEN", "Human lacks required permission.");
      const id = "oidc-" + createHash("sha256").update(settings.issuer + "\0" + payload.sub).digest("hex");
      return { id, subject: payload.sub, role };
    } catch (error) {
      if (error instanceof ControlApiError) throw error;
      throw new ControlApiError("UNAUTHENTICATED", "Invalid or expired human identity token.");
    }
  };
}
