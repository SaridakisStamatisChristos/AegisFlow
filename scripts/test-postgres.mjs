import { spawn } from "node:child_process";
import { rename } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests.");
}

const legacyProviderRuntimePattern = [
  "Agent Stage executes one provider call",
  "provider result evidence is database-enforced immutable",
  "database validation rejects provider evidence",
  "schema mismatch fails the Stage",
  "tool request is durably recorded",
  "provider cannot request a tool",
  "recovery reuses a durable provider result",
  "orphaned in-flight provider call",
  "known and ambiguous provider failures",
  "non-Agent Stage and missing provider",
].join("|");

const persistenceSuite = {
  path: "packages/persistence/test/persistence.integration.test.mjs",
  args: [],
};

const legacySuites = [
  { path: "packages/queue/test/queue.integration.test.mjs", args: [] },
  { path: "packages/effects/test/effects.integration.test.mjs", args: [] },
  { path: "packages/effects/test/cancel-quarantine.integration.test.mjs", args: [] },
  { path: "packages/gates/test/gates.integration.test.mjs", args: [] },
  {
    path: "packages/providers/test/runtime.integration.test.mjs",
    args: [`--test-name-pattern=${legacyProviderRuntimePattern}`],
  },
  { path: "packages/connectors/test/runtime.integration.test.mjs", args: [] },
  { path: "packages/providers/test/runtime-v8.integration.test.mjs", args: [] },
  { path: "packages/providers/test/runtime-v8-fencing.integration.test.mjs", args: [] },
];

const apiSuites = [
  { path: "packages/api/test/control-api.integration.test.mjs", args: [] },
  { path: "packages/api/test/operator-views.integration.test.mjs", args: [] },
];

const migrationUp = new URL("../packages/persistence/migrations/0007_control_api.up.sql", import.meta.url);
const migrationDown = new URL("../packages/persistence/migrations/0007_control_api.down.sql", import.meta.url);
const hiddenMigrationUp = new URL("../packages/persistence/migrations/0007_control_api.up.sql.pr9-hidden", import.meta.url);
const hiddenMigrationDown = new URL("../packages/persistence/migrations/0007_control_api.down.sql.pr9-hidden", import.meta.url);

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

async function cleanFeatureExtensions() {
  await pool.query(`
    DROP TABLE IF EXISTS signals CASCADE;
    DROP TABLE IF EXISTS api_idempotency CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_reject_signal_mutation();
    DROP FUNCTION IF EXISTS aegisflow_validate_signal_execution();
    DROP TABLE IF EXISTS agent_tool_results CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_reject_agent_tool_result_mutation();
    DROP FUNCTION IF EXISTS aegisflow_validate_agent_tool_result();
    DROP TABLE IF EXISTS agent_provider_results CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_reject_agent_provider_result_mutation();
    DROP FUNCTION IF EXISTS aegisflow_validate_agent_provider_result();
  `);
}

async function runSuite(suite) {
  await cleanFeatureExtensions();
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--test", "--test-concurrency=1", ...suite.args, suite.path],
      { stdio: "inherit", env: process.env },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${suite.path} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

async function withLegacyMigrationHorizon(work) {
  await rename(migrationUp, hiddenMigrationUp);
  try {
    await rename(migrationDown, hiddenMigrationDown);
  } catch (error) {
    await rename(hiddenMigrationUp, migrationUp);
    throw error;
  }

  try {
    return await work();
  } finally {
    await rename(hiddenMigrationDown, migrationDown);
    await rename(hiddenMigrationUp, migrationUp);
  }
}

try {
  await runSuite(persistenceSuite);
  await withLegacyMigrationHorizon(async () => {
    for (const suite of legacySuites) await runSuite(suite);
  });
  for (const suite of apiSuites) await runSuite(suite);
} finally {
  await pool.end();
}
