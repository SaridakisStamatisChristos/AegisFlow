import { spawn } from "node:child_process";
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

const suites = [
  { path: "packages/persistence/test/persistence.integration.test.mjs", args: [] },
  { path: "packages/queue/test/queue.integration.test.mjs", args: [] },
  { path: "packages/effects/test/effects.integration.test.mjs", args: [] },
  { path: "packages/gates/test/gates.integration.test.mjs", args: [] },
  {
    path: "packages/providers/test/runtime.integration.test.mjs",
    args: [`--test-name-pattern=${legacyProviderRuntimePattern}`],
  },
  { path: "packages/connectors/test/runtime.integration.test.mjs", args: [] },
  { path: "packages/providers/test/runtime-v8.integration.test.mjs", args: [] },
];

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

async function cleanFeatureExtensions() {
  await pool.query(`
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

try {
  for (const suite of suites) await runSuite(suite);
} finally {
  await pool.end();
}
