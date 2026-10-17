import type { JsonObject, JsonValue } from "@aegisflow/contracts";
import type { ConnectorExecutionContext, ConnectorResult, ToolConnector } from "./connector.js";
import { ConnectorInvocationError, ToolRuntimeError } from "./errors.js";
import { HttpConnector, type FetchLike } from "./http.js";

export interface SlackConnectorOptions {
  readonly token: string;
  readonly authorityScope: string;
  readonly fetch?: FetchLike;
}

export class SlackConnector implements ToolConnector {
  readonly toolName = "slack.postMessage";
  readonly authorityScope: string;
  private readonly http: HttpConnector;

  constructor(options: SlackConnectorOptions) {
    if (typeof options.token !== "string" || options.token.length < 1 || /[\u0000\r\n]/u.test(options.token)) {
      throw new ToolRuntimeError("INVALID_INPUT", "Slack token is invalid.");
    }
    this.authorityScope = options.authorityScope;
    this.http = new HttpConnector({
      allowedOrigins: ["https://slack.com"],
      authorityScope: options.authorityScope,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      defaultHeaders: {
        authorization: `Bearer ${options.token}`,
        "user-agent": "AegisFlow/0.1",
      },
    });
  }

  async execute(input: JsonObject, context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const channel = input.channel;
    const text = input.text;
    if (typeof channel !== "string" || channel.length < 1 || channel.length > 128 || /[\u0000\r\n]/u.test(channel)) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_channel", "Slack channel is invalid.");
    }
    if (typeof text !== "string" || text.length < 1 || text.length > 40_000 || /\u0000/u.test(text)) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_text", "Slack text is invalid.");
    }
    const threadTs = input.threadTs;
    if (threadTs !== undefined && (typeof threadTs !== "string" || !/^\d{1,20}\.\d{1,20}$/u.test(threadTs))) {
      throw new ConnectorInvocationError("KNOWN_FAILURE", "invalid_thread_ts", "Slack threadTs is invalid.");
    }
    const result = await this.http.execute({
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      body: { channel, text, ...(threadTs === undefined ? {} : { thread_ts: threadTs }) },
    }, context);
    const output = result.output;
    let reference = result.externalReference;
    if (typeof output === "object" && output !== null && !Array.isArray(output)) {
      const record = output as Readonly<Record<string, JsonValue>>;
      const body = record.body;
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        const bodyRecord = body as Readonly<Record<string, JsonValue>>;
        if (typeof bodyRecord.ts === "string") reference = bodyRecord.ts;
      }
    }
    return Object.freeze({ output, ...(reference === undefined ? {} : { externalReference: reference }) });
  }
}
