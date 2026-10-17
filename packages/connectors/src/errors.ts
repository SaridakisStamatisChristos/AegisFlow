export type ConnectorFailureClass = "KNOWN_FAILURE" | "AMBIGUOUS";

export class ConnectorInvocationError extends Error {
  constructor(
    readonly classification: ConnectorFailureClass,
    readonly connectorCode: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ConnectorInvocationError";
  }
}

export type ToolRuntimeErrorCode =
  | "INVALID_INPUT"
  | "CONNECTOR_NOT_FOUND"
  | "CONNECTOR_CONFLICT"
  | "KNOWN_FAILURE"
  | "AMBIGUOUS"
  | "RECONCILIATION_REQUIRED"
  | "INTEGRITY"
  | "TRANSACTION";

export class ToolRuntimeError extends Error {
  constructor(
    readonly code: ToolRuntimeErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ToolRuntimeError";
  }
}
