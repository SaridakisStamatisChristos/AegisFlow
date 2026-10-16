export type QueueErrorCode =
  | "INVALID_INPUT"
  | "NOT_CLAIMABLE"
  | "STALE_CLAIM"
  | "LEASE_EXPIRED"
  | "INTEGRITY"
  | "CONFLICT"
  | "TRANSACTION";

export class QueueError extends Error {
  constructor(
    readonly code: QueueErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "QueueError";
  }
}
