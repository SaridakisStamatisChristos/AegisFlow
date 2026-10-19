import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  parseAttemptId,
  parseGateId,
} from "@aegisflow/contracts";
import {
  ConnectorInvocationError,
  ConnectorRegistry,
  PostgresToolRuntime,
  ToolRuntimeError,
  agentToolEffectIdentity,
} from "@aegisflow/connectors";
import { PostgresEffectLedger } from "@aegisflow/effects";
import { migrateUp } from "@aegisflow/persistence";
import { PostgresWorkerQueue, QueueError } from "@aegisflow/queue";
import { PostgresAgentRuntime, ProviderRegistry } from "@aegisflow/providers";
import { AegisFlowClient } from "@aegisflow/sdk";
import { createControlServer, PostgresControlService } from "@aegisflow/api";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the deterministic demo suite.");

const pool = new Pool({ connectionString: databaseUrl, max: 24 });
const service = new PostgresControlService(pool);
const queue = new PostgresWorkerQueue(pool);
const effects = new PostgresEffectLedger(pool);
const apiToken = "aegisflowTestToken_xxxxxxxxxxxxxxxxxxxxx";
const server = createControlServer(service, [{ id: "operator-demo", sha256: createHash("sha256").update(apiToken).digest("hex"), role: "admin" }]);
let client;

async function dropSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS signals, api_idempotency, agent_tool_results, agent_provider_results,
      gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims,
      execution_events, attempts, stage_executions, executions, flow_versions, flows CASCADE;
    DROP FUNCTION IF EXISTS aegisflow_reject_signal_mutation();
    DROP FUNCTION IF EXISTS aegisflow_validate_signal_execution();
    DROP FUNCTION IF EXISTS aegisflow_reject_agent_tool_result_mutation();
    DROP FUNCTION IF EXISTS aegisflow_validate_agent_tool_result();
    DROP FUNCTION IF EXISTS aegisflow_reject_agent_provider_result_mutation();
    DROP FUNCTION IF EXISTS aegisflow_validate_agent_provider_result();
    DROP FUNCTION IF EXISTS aegisflow_enforce_gate_protection();
    DROP FUNCTION IF EXISTS aegisflow_reject_gate_resolution_mutation();
    DROP FUNCTION IF EXISTS aegisflow_reject_effect_reconciliation_mutation();
    DROP FUNCTION IF EXISTS aegisflow_reject_flow_version_mutation();
    DROP TABLE IF EXISTS aegisflow_schema_migrations;
  `);
}

async function resetData() {
  await pool.query(`
    TRUNCATE signals, api_idempotency, agent_tool_results, agent_provider_results,
      gate_resolutions, gate_protections, gates, effect_reconciliations, effects, claims,
      execution_events, attempts, stage_executions, executions, flow_versions, flows
    RESTART IDENTITY CASCADE
  `);
}

function listen(serverInstance) {
  return new Promise((resolve, reject) => {
    serverInstance.once("error", reject);
    serverInstance.listen(0, "127.0.0.1", resolve);
  });
}

function close(serverInstance) {
  return new Promise((resolve, reject) => {
    serverInstance.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function stageById(execution, stageId) {
  const stage = execution.stages.find((item) => item.stageId === stageId);
  assert.ok(stage, `Expected StageExecution for '${stageId}'.`);
  return stage;
}

async function startSingleStageFlow(name, stage, idempotencyKey) {
  const registered = await client.registerFlow({ name, stages: [stage] });
  const started = await client.startExecution({
    flowId: registered.flow.id,
    flowVersionId: registered.version.id,
    idempotencyKey,
  });
  return { registered, started, stage: started.stages[0] };
}

async function forceClaimExpired(attemptId) {
  const result = await pool.query(
    "UPDATE claims SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE attempt_id = $1 AND state = 'ACTIVE'",
    [attemptId],
  );
  assert.equal(result.rowCount, 1, `Expected active claim for ${attemptId}.`);
}

function testConnector(toolName, execute) {
  return new ConnectorRegistry([{ toolName, authorityScope: `demo:${toolName}`, execute }]);
}

async function waitForChildClaim(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Worker child did not claim in ${timeoutMs}ms. stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onOut = (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("CLAIMED")) {
        cleanup();
        resolve(stdout.trim());
      }
    };
    const onErr = (chunk) => { stderr += String(chunk); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Worker child exited before claim: code=${code} signal=${signal} stderr=${stderr}`));
    };
    const onError = (error) => { cleanup(); reject(error); };
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

const scenarios = [
  {
    id: "flagship-incident-definition",
    title: "Flagship incident-response Flow is a valid public contract",
    run: async () => {
      const definition = JSON.parse(await readFile(new URL("../examples/incident-response.flow.json", import.meta.url), "utf8"));
      const registered = await client.registerFlow(definition);
      const started = await client.startExecution({
        flowId: registered.flow.id,
        flowVersionId: registered.version.id,
        idempotencyKey: "demo-flagship-start",
      });
      assert.equal(started.stages.length, definition.stages.length);
      assert.equal(stageById(started, "validate").state, "READY");
      assert.ok(started.stages.filter((stage) => stage.state === "BLOCKED").length >= 1);
      return { stageCount: started.stages.length, initialReady: 1 };
    },
  },
  {
    id: "deterministic-flow",
    title: "Deterministic Flow executes through API, worker queue, and durable state",
    run: async () => {
      const { started, stage } = await startSingleStageFlow(
        "demo-deterministic",
        { id: "validate", type: "task", dependsOn: [], handler: "demo.validate" },
        "demo-deterministic-start",
      );
      const claim = await queue.claimStage({
        stageExecutionId: stage.id,
        attemptId: parseAttemptId("attempt_demodet01"),
        ownerId: "demo-worker",
        leaseMs: 60_000,
      });
      assert.ok(claim);
      const completion = await queue.completeClaim({
        stageExecutionId: stage.id,
        attemptId: claim.attempt.id,
        ownerId: claim.claim.ownerId,
        generation: claim.claim.generation,
        event: "SUCCEED",
      });
      assert.equal(completion.stage.state, "SUCCEEDED");
      const durable = await client.getExecution(started.execution.id);
      assert.equal(durable.stages[0].state, "SUCCEEDED");
      const events = await client.getExecutionEvents(started.execution.id);
      assert.ok(events.events.some((event) => event.eventType === "execution.started"));
      return { attempts: 1, finalStageState: "SUCCEEDED", durableEvents: events.events.length };
    },
  },
  {
    id: "agent-reasoning",
    title: "Agent reasoning uses deterministic provider and durable provider Effect evidence",
    run: async () => {
      const { started, stage } = await startSingleStageFlow(
        "demo-agent",
        {
          id: "classify",
          type: "agent",
          dependsOn: [],
          provider: "demo.provider",
          instruction: "Classify the incident severity.",
          allowedTools: [],
          maxSteps: 1,
          outputSchema: {
            type: "object",
            required: ["severity"],
            properties: { severity: { enum: ["high"] } },
            additionalProperties: false,
          },
        },
        "demo-agent-start",
      );
      let calls = 0;
      const runtime = new PostgresAgentRuntime(
        pool,
        new ProviderRegistry([{ id: "demo.provider", generate: async () => {
          calls += 1;
          return { kind: "final", output: { severity: "high" }, providerReference: "demo-provider-response" };
        } }]),
      );
      const result = await runtime.runAgentStage({
        stageExecutionId: stage.id,
        attemptId: parseAttemptId("attempt_demoagent1"),
        ownerId: "agent-worker",
        leaseMs: 60_000,
      });
      assert.equal(calls, 1);
      assert.equal(result.providerResult.response.kind, "final");
      assert.deepEqual(result.providerResult.response.output, { severity: "high" });
      assert.equal(result.effect.state, "SUCCEEDED");
      assert.equal((await client.getExecution(started.execution.id)).stages[0].state, "SUCCEEDED");
      return { providerCalls: calls, providerEffect: result.effect.state };
    },
  },
  {
    id: "human-gate",
    title: "Human Gate is durable, evidence-bearing, and duplicate approval is deterministic",
    run: async () => {
      const registered = await client.registerFlow({
        name: "demo-gate",
        stages: [
          { id: "approval", type: "gate", dependsOn: [], prompt: "Approve incident escalation?" },
          { id: "after", type: "task", dependsOn: ["approval"], handler: "demo.after-gate" },
        ],
      });
      const started = await client.startExecution({ flowId: registered.flow.id, idempotencyKey: "demo-gate-start" });
      const gateStage = stageById(started, "approval");
      const gateId = parseGateId("gate_demogate01");
      const created = await service.gates.createGate({
        id: gateId,
        executionId: started.execution.id,
        stageExecutionId: gateStage.id,
      });
      assert.equal(created.snapshot.gate.state, "WAITING");
      assert.equal((await service.gates.getStageGateAuthorization(stageById(started, "after").id)).allowed, false);
      const approved = await client.approveGate({ gateId, actorId: "operator-demo", evidence: { ticket: "INC-42" } });
      assert.equal(approved.changed, true);
      assert.equal(approved.snapshot.gate.state, "APPROVED");
      assert.equal((await service.gates.getStageGateAuthorization(stageById(started, "after").id)).allowed, true);
      const duplicate = await client.approveGate({ gateId, actorId: "operator-demo", evidence: { overwrite: true } });
      assert.equal(duplicate.changed, false);
      assert.equal(duplicate.snapshot.resolution.actorId, "operator-demo");
      assert.deepEqual(duplicate.snapshot.resolution.evidence, { ticket: "INC-42" });
      return { firstDecisionChanged: true, duplicateDecisionChanged: false, finalGateState: "APPROVED" };
    },
  },
  {
    id: "external-effect",
    title: "External connector Effect succeeds once and durable replay suppresses duplicate action",
    run: async () => {
      const { started, stage } = await startSingleStageFlow(
        "demo-effect",
        {
          id: "agent_action",
          type: "agent",
          dependsOn: [],
          provider: "demo.provider",
          instruction: "Create one incident issue.",
          allowedTools: ["demo.github.create_issue"],
          maxSteps: 1,
        },
        "demo-effect-start",
      );
      const claim = await queue.claimStage({
        stageExecutionId: stage.id,
        attemptId: parseAttemptId("attempt_demoeffect1"),
        ownerId: "effect-worker",
        leaseMs: 60_000,
      });
      assert.ok(claim);
      let externalCalls = 0;
      const runtime = new PostgresToolRuntime(
        pool,
        testConnector("demo.github.create_issue", async (input) => {
          externalCalls += 1;
          return { output: { issueNumber: 42, title: input.title }, externalReference: "github-issue-42" };
        }),
      );
      const input = {
        executionId: started.execution.id,
        stageExecutionId: stage.id,
        providerStep: 1,
        call: { id: "create-issue", name: "demo.github.create_issue", input: { title: "Incident INC-42" } },
        recovered: false,
      };
      const first = await runtime.executeToolCall(input);
      const replay = await runtime.executeToolCall(input);
      assert.equal(externalCalls, 1);
      assert.equal(first.effect.state, "SUCCEEDED");
      assert.equal(replay.effect.state, "SUCCEEDED");
      assert.equal(replay.result.externalReference, "github-issue-42");
      await queue.completeClaim({
        stageExecutionId: stage.id,
        attemptId: claim.attempt.id,
        ownerId: claim.claim.ownerId,
        generation: claim.claim.generation,
        event: "SUCCEED",
      });
      return { externalCalls, replaySuppressedDuplicate: true, effectState: first.effect.state };
    },
  },
  {
    id: "transient-failure-retry",
    title: "Transient lease timeout becomes a new Attempt and succeeds on retry",
    run: async () => {
      const { stage } = await startSingleStageFlow(
        "demo-transient-retry",
        { id: "work", type: "task", dependsOn: [], handler: "demo.transient" },
        "demo-transient-start",
      );
      const first = await queue.claimStage({
        stageExecutionId: stage.id,
        attemptId: parseAttemptId("attempt_demoretry1"),
        ownerId: "transient-worker-1",
        leaseMs: 60_000,
      });
      assert.ok(first);
      await forceClaimExpired(first.attempt.id);
      const second = await queue.claimStage({
        stageExecutionId: stage.id,
        attemptId: parseAttemptId("attempt_demoretry2"),
        ownerId: "transient-worker-2",
        leaseMs: 60_000,
      });
      assert.ok(second);
      assert.equal(second.recovered, true);
      assert.equal(second.attempt.sequence, 2);
      const done = await queue.completeClaim({
        stageExecutionId: stage.id,
        attemptId: second.attempt.id,
        ownerId: second.claim.ownerId,
        generation: second.claim.generation,
        event: "SUCCEED",
      });
      assert.equal(done.stage.state, "SUCCEEDED");
      const attempts = await pool.query("SELECT sequence, state FROM attempts WHERE stage_execution_id = $1 ORDER BY sequence", [stage.id]);
      assert.deepEqual(attempts.rows.map((row) => [row.sequence, row.state]), [[1, "TIMED_OUT"], [2, "SUCCEEDED"]]);
      return { attempts: 2, attemptStates: ["TIMED_OUT", "SUCCEEDED"] };
    },
  },
  {
    id: "worker-crash-recovery",
    title: "Actual killed worker process is recovered after lease expiry",
    run: async () => {
      const { stage } = await startSingleStageFlow(
        "demo-process-crash",
        { id: "work", type: "task", dependsOn: [], handler: "demo.crash" },
        "demo-crash-start",
      );
      const childPath = fileURLToPath(new URL("./worker-crash-child.mjs", import.meta.url));
      const child = spawn(process.execPath, [childPath, stage.id, "attempt_democrash1", "250"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForChildClaim(child);
        const exitPromise = once(child, "exit");
        assert.equal(child.kill("SIGKILL"), true);
        const [code, signal] = await exitPromise;
        assert.ok(code !== 0 || signal !== null);
        await sleep(650);
        const recovered = await queue.claimStage({
          stageExecutionId: stage.id,
          attemptId: parseAttemptId("attempt_democrash2"),
          ownerId: "recovery-worker",
          leaseMs: 60_000,
        });
        assert.ok(recovered);
        assert.equal(recovered.recovered, true);
        assert.equal(recovered.attempt.sequence, 2);
        await queue.completeClaim({
          stageExecutionId: stage.id,
          attemptId: recovered.attempt.id,
          ownerId: recovered.claim.ownerId,
          generation: recovered.claim.generation,
          event: "SUCCEED",
        });
        return { killedProcess: true, recoveredGeneration: Number(recovered.claim.generation), attempts: 2 };
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
  },
  {
    id: "stale-worker-fencing",
    title: "Stale worker cannot complete after a newer generation owns the Stage",
    run: async () => {
      const { stage } = await startSingleStageFlow(
        "demo-fencing",
        { id: "work", type: "task", dependsOn: [], handler: "demo.fencing" },
        "demo-fencing-start",
      );
      const first = await queue.claimStage({
        stageExecutionId: stage.id,
        attemptId: parseAttemptId("attempt_demofence1"),
        ownerId: "stale-worker",
        leaseMs: 60_000,
      });
      assert.ok(first);
      await forceClaimExpired(first.attempt.id);
      const second = await queue.claimStage({
        stageExecutionId: stage.id,
        attemptId: parseAttemptId("attempt_demofence2"),
        ownerId: "fresh-worker",
        leaseMs: 60_000,
      });
      assert.ok(second);
      await assert.rejects(
        queue.completeClaim({
          stageExecutionId: stage.id,
          attemptId: first.attempt.id,
          ownerId: first.claim.ownerId,
          generation: first.claim.generation,
          event: "SUCCEED",
        }),
        (error) => error instanceof QueueError && error.code === "STALE_CLAIM",
      );
      await queue.completeClaim({
        stageExecutionId: stage.id,
        attemptId: second.attempt.id,
        ownerId: second.claim.ownerId,
        generation: second.claim.generation,
        event: "SUCCEED",
      });
      return { staleCompletionRejected: true, generations: [Number(first.claim.generation), Number(second.claim.generation)] };
    },
  },
  {
    id: "wait-signal-resume",
    title: "Durable signal resumes a waiting Signal Stage and duplicate delivery is idempotent",
    run: async () => {
      const { started } = await startSingleStageFlow(
        "demo-signal",
        { id: "await_release", type: "signal", dependsOn: [], signalName: "release" },
        "demo-signal-start",
      );
      const first = await client.sendSignal({
        executionId: started.execution.id,
        signalName: "release",
        idempotencyKey: "demo-release-1",
        payload: { ticket: "INC-42" },
      });
      assert.equal(first.replayed, false);
      assert.equal(first.resumedStageExecutionIds.length, 1);
      const replay = await client.sendSignal({
        executionId: started.execution.id,
        signalName: "release",
        idempotencyKey: "demo-release-1",
        payload: { ticket: "INC-42" },
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.signal.id, first.signal.id);
      assert.equal((await client.getExecution(started.execution.id)).stages[0].state, "SUCCEEDED");
      return { resumedStages: first.resumedStageExecutionIds.length, duplicateReplayed: true };
    },
  },
  {
    id: "ambiguous-effect-reconciliation",
    title: "Ambiguous side effect is quarantined and requires explicit reconciliation",
    run: async () => {
      const { started, stage } = await startSingleStageFlow(
        "demo-ambiguous-effect",
        {
          id: "agent_action",
          type: "agent",
          dependsOn: [],
          provider: "demo.provider",
          instruction: "Send one alert.",
          allowedTools: ["demo.slack.send_message"],
          maxSteps: 1,
        },
        "demo-ambiguous-start",
      );
      const claim = await queue.claimStage({
        stageExecutionId: stage.id,
        attemptId: parseAttemptId("attempt_demoambig1"),
        ownerId: "ambiguous-worker",
        leaseMs: 60_000,
      });
      assert.ok(claim);
      const runtime = new PostgresToolRuntime(
        pool,
        testConnector("demo.slack.send_message", async () => {
          throw new ConnectorInvocationError("AMBIGUOUS", "timeout_after_send", "remote outcome unknown");
        }),
      );
      const call = { id: "ambiguous-alert", name: "demo.slack.send_message", input: { channel: "incidents", text: "INC-42" } };
      await assert.rejects(
        runtime.executeToolCall({
          executionId: started.execution.id,
          stageExecutionId: stage.id,
          providerStep: 1,
          call,
          recovered: false,
        }),
        (error) => error instanceof ToolRuntimeError && error.code === "AMBIGUOUS",
      );
      const identity = agentToolEffectIdentity(stage.id, 1, call.id);
      const snapshot = await effects.getEffect(identity.effectId);
      assert.equal(snapshot.effect.state, "RECONCILIATION_REQUIRED");
      await queue.completeClaim({
        stageExecutionId: stage.id,
        attemptId: claim.attempt.id,
        ownerId: claim.claim.ownerId,
        generation: claim.claim.generation,
        event: "FAIL",
      });
      const reconciliation = await client.reconcileEffect({
        effectId: identity.effectId,
        decision: "CONFIRMED_FAILED",
        reconciledBy: "operator-demo",
        externalReference: "incident-alert-unknown",
      });
      assert.equal(reconciliation.created, true);
      assert.equal(reconciliation.reconciliation.decision, "CONFIRMED_FAILED");
      return { quarantined: true, effectState: snapshot.effect.state, reconciliation: "CONFIRMED_FAILED" };
    },
  },
];

const report = {
  suite: "aegisflow-deterministic-demo-benchmark",
  benchmarkKind: "semantic-correctness",
  performanceClaim: false,
  scenarios: [],
};

let failed = false;
try {
  await dropSchema();
  await migrateUp(pool);
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Control API did not bind.");
  client = new AegisFlowClient({ baseUrl: `http://127.0.0.1:${address.port}`, apiToken });

  for (const scenario of scenarios) {
    await resetData();
    const startedAt = process.hrtime.bigint();
    try {
      const metrics = await scenario.run();
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      report.scenarios.push({ id: scenario.id, title: scenario.title, status: "PASS", elapsedMs, metrics });
      console.log(`PASS ${scenario.id} (${elapsedMs.toFixed(1)} ms)`);
    } catch (error) {
      failed = true;
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const detail = {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        code: typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
      };
      report.scenarios.push({ id: scenario.id, title: scenario.title, status: "FAIL", elapsedMs, error: detail });
      console.error(`FAIL ${scenario.id}: ${detail.message}`);
    }
  }
} finally {
  if (server.listening) await close(server);
  await pool.end();
}

report.summary = {
  total: report.scenarios.length,
  passed: report.scenarios.filter((scenario) => scenario.status === "PASS").length,
  failed: report.scenarios.filter((scenario) => scenario.status === "FAIL").length,
};
console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
