import { Pool, type PoolClient, type PoolConfig } from "pg";
import { PersistenceError } from "./errors.js";

export function createPostgresPool(config: PoolConfig): Pool {
  return new Pool(config);
}

export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new PersistenceError(
        "TRANSACTION",
        "PostgreSQL transaction failed and rollback also failed.",
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function pingPostgres(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}
