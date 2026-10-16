export type AgentRuntimeErrorCode =
  | "INVALID_INPUT"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_CONFLICT"
  | "PROVIDER_FAILED"
  | "PROVIDER_AMBIGUOUS"
  | "PROVIDER_RECONCILIATION_REQUIRED"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "INVALID_OUTPUT_SCHEMA"
  | "OUTPUT_SCHEMA_MISMATCH"
  | "TOOL_NOT_ALLOWED"
  | "TOOL_EXECUTION_UNAVAILABLE"
  | "NOT_AGENT_STAGE"
  | "CLAIM_BUSY"
  | "STALE_AUTHORITY"
  | "INTEGRITY"
  | "TRANSACTION";

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentRuntimeErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}
