import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ControlApiError } from "./errors.js";

export type ApiRole = "reader" | "operator" | "approver" | "reconciler" | "admin";
export type ApiCapability = "read" | "execute" | "approve" | "reconcile";

export interface ApiCredential {
  readonly id: string;
  /** SHA-256 hex digest of a randomly generated, high-entropy bearer token. Never the token itself. */
  readonly sha256: string;
  readonly role: ApiRole;
  /** Enforces a separately verified human identity for this service credential. */
  readonly requiresHuman?: boolean;
  readonly expiresAt?: string;
}

export interface ApiPrincipal {
  readonly id: string;
  readonly role: ApiRole;
  readonly requiresHuman: boolean;
}

const ROLE_CAPABILITIES: Readonly<Record<ApiRole, readonly ApiCapability[]>> = {
  reader: ["read"],
  operator: ["read", "execute"],
  approver: ["read", "approve"],
  reconciler: ["read", "reconcile"],
  admin: ["read", "execute", "approve", "reconcile"],
};
const MAX_CREDENTIALS = 64;

function validateCredentials(value: unknown): readonly ApiCredential[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CREDENTIALS) {
    throw new Error("AEGISFLOW_API_KEYS_JSON requires between 1 and 64 credential records.");
  }
  const ids = new Set<string>();
  const hashes = new Set<string>();
  return value.map((item: unknown): ApiCredential => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Invalid API credential record.");
    }
    const record = item as Record<string, unknown>;
    const { id, sha256, role, expiresAt, requiresHuman } = record;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id) || ids.has(id)) {
      throw new Error("API credential IDs must be unique, nonempty and URL-safe.");
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || hashes.has(sha256)) {
      throw new Error("API credentials require unique lowercase SHA-256 digests.");
    }
    if (typeof role !== "string" || !Object.hasOwn(ROLE_CAPABILITIES, role)) {
      throw new Error("API credential role is not recognized.");
    }
    if (expiresAt !== undefined && (
      typeof expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiresAt) ||
      Number.isNaN(Date.parse(expiresAt))
    )) {
      throw new Error("API credential expiresAt must be an RFC 3339 UTC timestamp.");
    }
    if (requiresHuman !== undefined && typeof requiresHuman !== "boolean") {
      throw new Error("requiresHuman must be a boolean.");
    }
    ids.add(id);
    hashes.add(sha256);
    const credential = { id, sha256, role: role as ApiRole, requiresHuman: requiresHuman === true };
    return expiresAt === undefined ? credential : { ...credential, expiresAt: expiresAt as string };
  });
}

export function parseApiCredentials(raw: string | undefined): readonly ApiCredential[] {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("AEGISFLOW_API_KEYS_JSON must contain hashed service credentials.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("AEGISFLOW_API_KEYS_JSON is not valid JSON.");
  }
  return validateCredentials(value);
}

/** Total policy for the currently implemented protected HTTP surface.
 * Add a route here before introducing any new handler: unmatched routes are denied.
 * Scope is instance-wide service access; no tenant/resource owner model exists yet.
 */
export const PROTECTED_ROUTE_POLICY: ReadonlyArray<Readonly<{
  method: "GET" | "POST"; path: string; capability: ApiCapability;
}>> = Object.freeze([
  Object.freeze({ method: "GET", path: "/v1/flows", capability: "read" }),
  Object.freeze({ method: "POST", path: "/v1/flows", capability: "execute" }),
  Object.freeze({ method: "GET", path: "/v1/flows/:flowId", capability: "read" }),
  Object.freeze({ method: "GET", path: "/v1/executions", capability: "read" }),
  Object.freeze({ method: "POST", path: "/v1/executions", capability: "execute" }),
  Object.freeze({ method: "GET", path: "/v1/executions/:executionId", capability: "read" }),
  Object.freeze({ method: "POST", path: "/v1/executions/:executionId/cancel", capability: "execute" }),
  Object.freeze({ method: "GET", path: "/v1/executions/:executionId/events", capability: "read" }),
  Object.freeze({ method: "GET", path: "/v1/executions/:executionId/effects", capability: "read" }),
  Object.freeze({ method: "GET", path: "/v1/executions/:executionId/gates", capability: "read" }),
  Object.freeze({ method: "GET", path: "/v1/executions/:executionId/signals", capability: "read" }),
  Object.freeze({ method: "POST", path: "/v1/executions/:executionId/signals/:signalName", capability: "execute" }),
  Object.freeze({ method: "GET", path: "/v1/gates/pending", capability: "read" }),
  Object.freeze({ method: "GET", path: "/v1/gates/:gateId", capability: "read" }),
  Object.freeze({ method: "POST", path: "/v1/gates/:gateId/approve", capability: "approve" }),
  Object.freeze({ method: "POST", path: "/v1/gates/:gateId/reject", capability: "approve" }),
  Object.freeze({ method: "GET", path: "/v1/effects", capability: "read" }),
  Object.freeze({ method: "GET", path: "/v1/effects/:effectId", capability: "read" }),
  Object.freeze({ method: "POST", path: "/v1/effects/:effectId/reconcile", capability: "reconcile" }),
]);

export function requiredCapability(method: string, parts: readonly string[]): ApiCapability | undefined {
  for (const policy of PROTECTED_ROUTE_POLICY) {
    if (method !== policy.method) continue;
    const pattern = policy.path.slice(1).split("/");
    if (pattern.length !== parts.length) continue;
    if (pattern.every((segment, i) => segment.startsWith(":")
      ? typeof parts[i] === "string" && parts[i]!.length > 0
      : segment === parts[i])) return policy.capability;
  }
  return undefined;
}

export function createApiAuthenticator(input: readonly ApiCredential[]): (
  request: IncomingMessage, capability: ApiCapability
) => ApiPrincipal {
  const credentials = validateCredentials(input).map((record) => ({
    id: record.id,
    role: record.role,
    requiresHuman: record.requiresHuman === true,
    digest: Buffer.from(record.sha256, "hex"),
    expiresAtMs: record.expiresAt === undefined ? Infinity : Date.parse(record.expiresAt),
  }));
  return (request, capability) => {
    const headerCount = request.rawHeaders.filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === "authorization",
    ).length;
    const value = request.headers.authorization;
    if (headerCount !== 1 || typeof value !== "string") {
      throw new ControlApiError("UNAUTHENTICATED", "Bearer credential required.");
    }
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(value);
    if (match === null) throw new ControlApiError("UNAUTHENTICATED", "Invalid bearer credential.");
    const token = match[1];
    if (token === undefined) throw new ControlApiError("UNAUTHENTICATED", "Invalid bearer credential.");
    const digest = createHash("sha256").update(token).digest();
    let principal: ApiPrincipal | undefined;
    // Inspect every configured hash; do not short-circuit at the matching credential.
    for (const credential of credentials) {
      if (timingSafeEqual(digest, credential.digest) && credential.expiresAtMs > Date.now()) {
        principal = { id: credential.id, role: credential.role, requiresHuman: credential.requiresHuman };
      }
    }
    if (principal === undefined) throw new ControlApiError("UNAUTHENTICATED", "Invalid bearer credential.");
    if (!ROLE_CAPABILITIES[principal.role].includes(capability)) {
      throw new ControlApiError("FORBIDDEN", "Credential lacks permission for this operation.");
    }
    return principal;
  };
}
