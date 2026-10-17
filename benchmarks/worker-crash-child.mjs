import { parseAttemptId, parseStageExecutionId } from "@aegisflow/contracts";
import { PostgresWorkerQueue } from "@aegisflow/queue";
import { Pool } from "pg";

const [stageExecutionIdText, attemptIdText, leaseMsText] = process.argv.slice(2);
if (!stageExecutionIdText || !attemptIdText || !leaseMsText) {
  throw new Error("usage: worker-crash-child.mjs <stageExecutionId> <attemptId> <leaseMs>");
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const leaseMs = Number.parseInt(leaseMsText, 10);
if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error("leaseMs must be a positive integer.");

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const queue = new PostgresWorkerQueue(pool);
const claim = await queue.claimStage({
  stageExecutionId: parseStageExecutionId(stageExecutionIdText),
  attemptId: parseAttemptId(attemptIdText),
  ownerId: "crash-child",
  leaseMs,
});
if (!claim) throw new Error("Child worker could not claim StageExecution.");
process.stdout.write(`CLAIMED generation=${claim.claim.generation}\n`);

await new Promise(() => {});
