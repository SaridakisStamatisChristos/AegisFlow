export type ContractErrorCode =
  | "INVALID_FLOW"
  | "INVALID_ID"
  | "INVALID_VERSION"
  | "DUPLICATE_STAGE_ID"
  | "UNKNOWN_STAGE_KIND"
  | "UNKNOWN_DEPENDENCY"
  | "CYCLE_DETECTED"
  | "INVALID_STAGE_CONFIG";

export class ContractError extends Error {
  readonly code: ContractErrorCode;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ContractErrorCode,
    message: string,
    options: {
      path?: string;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    if (options.path !== undefined) {
      this.path = options.path;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}
