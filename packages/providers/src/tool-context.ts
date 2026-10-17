import type { JsonValue } from "@aegisflow/contracts";

export interface ProviderToolResult {
  readonly callId: string;
  readonly name: string;
  readonly output: JsonValue;
}

declare module "./provider.js" {
  interface ProviderRequest {
    readonly toolResults?: readonly ProviderToolResult[];
  }
}
