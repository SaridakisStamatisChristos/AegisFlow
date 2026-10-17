import type { JsonObject, JsonValue } from "@aegisflow/contracts";
import type { ConnectorExecutionContext, ConnectorResult, ToolConnector } from "./connector.js";
import { ConnectorInvocationError, ToolRuntimeError } from "./errors.js";
import { HttpConnector, type FetchLike } from "./http.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface GitHubConnectorOptions {
  readonly token: string;
  readonly authorityScope: string;
  readonly fetch?: FetchLike;
  readonly apiVersion?: string;
}

export class GitHubConnector implements ToolConnector {
  readonly toolName = "github.request";
  readonly authorityScope: string;
  private readonly http: HttpConnector;

  constructor(options: GitHubConnectorOptions) {
    if (typeof options.token !== "string" || options.token.length < 1 || /[\u0000\r\n]/u.test(options.token)) {
      throw new ToolRuntimeError("INVALID_INPUT", "GitHub token is invalid.");
    }
    this.authorityScope = options.authorityScope;
    this.http = new HttpConnector({
      allowedOrigins: ["https://api.github.com"],
      authorityScope: options.authorityScope,
      fetch: options.fetch,
      defaultHeaders: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": options.apiVersion ?? "2022-11-28",
        "user-agent": "AegisFlow/0.1",
      },
    });
  }

  async execute(input: JsonObject, context: ConnectorExecutionContext): Promise<ConnectorResult> {
    if (typeof input.path !== "string" || input.path.length < 1 || input.path.length > 2_048 || !input.path.startsWith("/") || input.path.includes("://") || /[\u0000\r\n]/u.test(input.path)) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_path", "GitHub path must be a bounded absolute API path.");
    }
    const url = new URL(input.path, "https://api.github.com");
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
