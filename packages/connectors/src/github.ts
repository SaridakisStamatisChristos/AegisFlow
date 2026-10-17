import type { JsonObject, JsonValue } from "@aegisflow/contracts";
import type { ConnectorExecutionContext, ConnectorResult, ToolConnector } from "./connector.js";
import { ConnectorInvocationError, ToolRuntimeError } from "./errors.js";
import { HttpConnector, type FetchLike } from "./http.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAllowedPrefix(raw: string): string {
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > 2_048 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("://") ||
    raw.includes("?") ||
    raw.includes("#") ||
    /[\u0000\r\n]/u.test(raw)
  ) {
    throw new ToolRuntimeError("INVALID_INPUT", "GitHub allowedPathPrefixes must contain bounded absolute API paths without query or fragment.");
  }
  const normalized = new URL(raw, "https://api.github.com").pathname.replace(/\/$/u, "") || "/";
  if (normalized === "/") {
    throw new ToolRuntimeError("INVALID_INPUT", "GitHub connector cannot grant the entire API root.");
  }
  return normalized;
}

function pathAllowed(pathname: string, prefixes: ReadonlySet<string>): boolean {
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export interface GitHubConnectorOptions {
  readonly token: string;
  readonly authorityScope: string;
  readonly allowedPathPrefixes: readonly string[];
  readonly fetch?: FetchLike;
  readonly apiVersion?: string;
}

export class GitHubConnector implements ToolConnector {
  readonly toolName = "github.request";
  readonly authorityScope: string;
  private readonly http: HttpConnector;
  private readonly allowedPathPrefixes: ReadonlySet<string>;

  constructor(options: GitHubConnectorOptions) {
    if (typeof options.token !== "string" || options.token.length < 1 || /[\u0000\r\n]/u.test(options.token)) {
      throw new ToolRuntimeError("INVALID_INPUT", "GitHub token is invalid.");
    }
    if (options.allowedPathPrefixes.length === 0) {
      throw new ToolRuntimeError("INVALID_INPUT", "GitHub connector requires at least one allowed API path prefix.");
    }
    this.authorityScope = options.authorityScope;
    this.allowedPathPrefixes = new Set(options.allowedPathPrefixes.map(normalizeAllowedPrefix));
    this.http = new HttpConnector({
      allowedOrigins: ["https://api.github.com"],
      authorityScope: options.authorityScope,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      defaultHeaders: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": options.apiVersion ?? "2022-11-28",
        "user-agent": "AegisFlow/0.1",
      },
    });
  }

  async execute(input: JsonObject, context: ConnectorExecutionContext): Promise<ConnectorResult> {
    if (
      typeof input.path !== "string" ||
      input.path.length < 1 ||
      input.path.length > 2_048 ||
      !input.path.startsWith("/") ||
      input.path.startsWith("//") ||
      input.path.includes("://") ||
      /[\u0000\r\n]/u.test(input.path)
    ) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_path", "GitHub path must be a bounded absolute API path.");
    }
    const url = new URL(input.path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "origin_not_allowed", "GitHub request escaped api.github.com.");
    }
    if (!pathAllowed(url.pathname, this.allowedPathPrefixes)) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "path_not_allowed", `GitHub API path '${url.pathname}' is outside connector authority.`);
    }
    if (input.query !== undefined) {
      if (!isRecord(input.query)) throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_query", "GitHub query must be an object.");
      for (const [key, raw] of Object.entries(input.query)) {
        if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(key)) throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_query", "GitHub query contains an invalid key.");
        if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
          throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_query", "GitHub query values must be scalar.");
        }
        url.searchParams.append(key, String(raw));
      }
    }
    const request: Record<string, JsonValue> = {
      url: url.toString(),
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    };
    return this.http.execute(request, context);
  }
}
