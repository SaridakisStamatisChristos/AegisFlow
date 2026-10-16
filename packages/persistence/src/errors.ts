export type PersistenceErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTEGRITY"
  | "MIGRATION"
  | "TRANSACTION";

export class PersistenceError extends Error {
  constructor(
    readonly code: PersistenceErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function translatePostgresError(error: unknown, context: string): never {
  if (error instanceof PersistenceError) {
    throw error;
  }

  const code = postgresErrorCode(error);
  if (code === "23505") {
    throw new PersistenceError("CONFLICT", `${context}: uniqueness conflict.`, { cause: error });
  }
  if (code === "23503" || code === "23514" || code === "22P02") {
    throw new PersistenceError("INTEGRITY", `${context}: persisted data violates an integrity constraint.`, {
      cause: error,
    });
  }

  throw new PersistenceError("TRANSACTION", `${context}: PostgreSQL operation failed.`, {
    cause: error,
  });
}
