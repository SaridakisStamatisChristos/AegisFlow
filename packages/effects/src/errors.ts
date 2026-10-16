export type EffectLedgerErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "KEY_CONFLICT"
  | "IN_FLIGHT"
  | "RECONCILIATION_REQUIRED"
  | "KNOWN_FAILED"
  | "STALE_STATE"
  | "INTEGRITY"
  | "CONFLICT"
  | "TRANSACTION";

export class EffectLedgerError extends Error {
  constructor(
    readonly code: EffectLedgerErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "EffectLedgerError";
  }
}
