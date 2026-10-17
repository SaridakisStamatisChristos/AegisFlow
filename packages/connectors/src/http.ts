import type { JsonObject, JsonValue } from "@aegisflow/contracts";
import type { ConnectorExecutionContext, ConnectorResult, ToolConnector } from "./connector.js";
import { ConnectorInvocationError, ToolRuntimeError } from "./errors.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const FORBIDDEN_INPUT_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "host",
  "content-length",
  "transfer-encoding",
]);
const MAX_RESPONSE_BYTES = 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value || /[\u0000\r\n]/u.test(value)) {
    throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_input", `${label} is invalid.`);
  }
  return value;
}

function parseHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_headers", "headers must be an object.");
  const output: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(lower) || FORBIDDEN_INPUT_HEADERS.has(lower)) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "forbidden_header", `header '${name}' is not allowed from tool input.`);
    }
    output[lower] = requireString(raw, `header '${name}'`, 8_192);
  }
  return output;
}

function parseMethod(value: unknown): string {
  if (value === undefined) return "GET";
  const method = requireString(value, "method", 16).toUpperCase();
  if (!METHODS.has(method)) throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_method", `HTTP method '${method}' is not allowed.`);
  return method;
}

function parseTimeout(value: unknown): number {
  if (value === undefined) return 30_000;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 120_000) {
    throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_timeout", "timeoutMs must be an integer between 1 and 120000.");
  }
  return value as number;
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
      throw new ConnectorInvocationError("AMBIGUOUS", "response_too_large", "HTTP response exceeds the 1 MiB evidence limit.");
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new ConnectorInvocationError("AMBIGUOUS", "response_too_large", "HTTP response exceeds the 1 MiB evidence limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function responseBody(text: string, contentType: string | null): JsonValue {
  if (text.length === 0) return null;
  if (contentType?.toLowerCase().includes("json")) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}

export interface HttpConnectorOptions {
  readonly allowedOrigins: readonly string[];
  readonly authorityScope: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: FetchLike;
}

export class HttpConnector implements ToolConnector {
  readonly toolName = "http.request";
  readonly authorityScope: string;
  private readonly origins: ReadonlySet<string>;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly transport: FetchLike;

  constructor(options: HttpConnectorOptions) {
    if (options.allowedOrigins.length === 0) throw new ToolRuntimeError("INVALID_INPUT", "HttpConnector requires at least one allowed origin.");
    this.authorityScope = options.authorityScope;
    this.origins = new Set(options.allowedOrigins.map((raw) => {
      const url = new URL(raw);
      if (url.protocol !== "https:") throw new ToolRuntimeError("INVALID_INPUT", "HTTP connector origins must use https.");
      return url.origin;
    }));
    this.defaultHeaders = Object.freeze({ ...(options.defaultHeaders ?? {}) });
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async execute(input: JsonObject, context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const method = parseMethod(input.method);
    const urlText = requireString(input.url, "url", 2_048);
    let url: URL;
    try { url = new URL(urlText); } catch (error) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_url", "url is not a valid absolute URL.", { cause: error });
    }
    if (url.protocol !== "https:" || !this.origins.has(url.origin)) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "origin_not_allowed", `origin '${url.origin}' is not allowed.`);
    }
    if ((method === "GET") && input.body !== undefined) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "body_not_allowed", "GET requests cannot contain a body.");
    }
    const timeoutMs = parseTimeout(input.timeoutMs);
    const headers = { ...this.defaultHeaders, ...parseHeaders(input.headers) };
    let body: string | undefined;
    if (input.body !== undefined) {
      body = JSON.stringify(input.body);
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("connector timeout")), timeoutMs);
    const relay = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", relay, { once: true });
    try {
      let response: Response;
      try {
        response = await this.transport(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        throw new ConnectorInvocationError("AMBIGUOUS", "transport_error", "HTTP transport failed with an unknown remote outcome.", { cause: error });
      }
      const text = await readBoundedBody(response);
      const output: JsonObject = Object.freeze({
        status: response.status,
        ok: response.ok,
        body: responseBody(text, response.headers.get("content-type")),
      });
      const reference = response.headers.get("x-request-id") ?? response.headers.get("x-github-request-id") ?? undefined;
      return Object.freeze({ output, ...(reference === undefined ? {} : { externalReference: reference }) });
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", relay);
    }
  }
}
