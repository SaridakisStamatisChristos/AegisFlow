import { readdir, readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { PersistenceError } from "./errors.js";

const MIGRATION_LOCK = 0x41454749;
const MIGRATIONS_DIRECTORY = new URL("../migrations/", import.meta.url);
const UP_FILE = /^(\d{4}_[a-z0-9_-]+)\.up\.sql$/;

export interface MigrationDescriptor {
  readonly id: string;
  readonly upUrl: URL;
  readonly downUrl: URL;
}

export async function discoverMigrations(): Promise<readonly MigrationDescriptor[]> {
  const entries = await readdir(MIGRATIONS_DIRECTORY, { withFileTypes: true });
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const migrations: MigrationDescriptor[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = UP_FILE.exec(entry.name);
    if (match === null) continue;
    const id = match[1];
    if (id === undefined) continue;
    const downName = `${id}.down.sql`;
    if (!names.has(downName)) {
      throw new PersistenceError("MIGRATION", `Migration ${id} is missing ${downName}.`);
    }
    migrations.push({
      id,
      upUrl: new URL(entry.name, MIGRATIONS_DIRECTORY),
      downUrl: new URL(downName, MIGRATIONS_DIRECTORY),
    });
  }

  migrations.sort((left, right) => left.id.localeCompare(right.id));
  const duplicate = migrations.find((migration, index) => migrations[index - 1]?.id === migration.id);
  if (duplicate !== undefined) {
    throw new PersistenceError("MIGRATION", `Duplicate migration id ${duplicate.id}.`);
  }
  return Object.freeze(migrations);
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS aegisflow_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function withMigrationLock<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    locked = true;
    await ensureMigrationTable(client);
    return await work(client);
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
    client.release();
  }
}

export async function getAppliedMigrations(pool: Pool): Promise<readonly string[]> {
  return withMigrationLock(pool, async (client) => {
    const result = await client.query<{ id: string }>(
      "SELECT id FROM aegisflow_schema_migrations ORDER BY id ASC",
    );
    return Object.freeze(result.rows.map((row) => row.id));
  });
}

export async function migrateUp(pool: Pool): Promise<readonly string[]> {
  const migrations = await discoverMigrations();
  return withMigrationLock(pool, async (client) => {
    const appliedResult = await client.query<{ id: string }>(
      "SELECT id FROM aegisflow_schema_migrations ORDER BY id ASC",
    );
    const applied = new Set(appliedResult.rows.map((row) => row.id));
    const newlyApplied: string[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      const sql = await readFile(migration.upUrl, "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO aegisflow_schema_migrations (id) VALUES ($1)", [
          migration.id,
        ]);
        await client.query("COMMIT");
        newlyApplied.push(migration.id);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new PersistenceError("MIGRATION", `Failed to apply migration ${migration.id}.`, {
          cause: error,
        });
      }
    }

    return Object.freeze(newlyApplied);
  });
}

export async function rollbackLastMigration(pool: Pool): Promise<string | null> {
  const migrations = await discoverMigrations();
  const byId = new Map(migrations.map((migration) => [migration.id, migration] as const));

  return withMigrationLock(pool, async (client) => {
    const result = await client.query<{ id: string }>(
      "SELECT id FROM aegisflow_schema_migrations ORDER BY id DESC LIMIT 1",
    );
    const id = result.rows[0]?.id;
    if (id === undefined) return null;
    const migration = byId.get(id);
    if (migration === undefined) {
      throw new PersistenceError(
        "MIGRATION",
        `Applied migration ${id} has no matching migration files.`,
      );
    }

    const sql = await readFile(migration.downUrl, "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("DELETE FROM aegisflow_schema_migrations WHERE id = $1", [id]);
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw new PersistenceError("MIGRATION", `Failed to roll back migration ${id}.`, {
        cause: error,
      });
    }
  });
}
