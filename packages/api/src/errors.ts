export type ControlApiErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "TERMINAL_EXECUTION"
  | "INTEGRITY"
  | "TRANSACTION";

export class ControlApiError extends Error {
  constructor(
    readonly code: ControlApiErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ControlApiError";
  }
}
