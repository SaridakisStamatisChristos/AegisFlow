export type GateLedgerErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "NOT_GATE_STAGE"
  | "KEY_CONFLICT"
  | "STALE_STATE"
  | "DECISION_CONFLICT"
  | "PROTECTED"
  | "INTEGRITY"
  | "CONFLICT"
  | "TRANSACTION";

export class GateLedgerError extends Error {
  constructor(
    readonly code: GateLedgerErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "GateLedgerError";
  }
}
