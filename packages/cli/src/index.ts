import { readFile as nodeReadFile } from "node:fs/promises";
import {
  ContractError,
  parseExecutionId,
  parseFlowId,
  parseFlowVersionId,
  parseGateId,
  validateFlowDefinition,
  type JsonObject,
} from "@aegisflow/contracts";
import { AegisFlowClient, AegisFlowSdkError } from "@aegisflow/sdk";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const MAX_JSON_FILE_BYTES = 1_048_576;

export interface CliDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

interface ParsedGlobals {
  readonly baseUrl: string;
  readonly args: readonly string[];
}

interface CommandOptions {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

const HELP = `AegisFlow CLI

Usage:
  aegisflow [--base-url URL] flow validate <flow.json>
  aegisflow [--base-url URL] flow submit <flow.json>
  aegisflow [--base-url URL] execution start <flow-id> --idempotency-key <key> [--version <flow-version-id>]
  aegisflow [--base-url URL] execution inspect <execution-id>
  aegisflow [--base-url URL] gate approve <gate-id> --actor <actor-id> [--evidence <evidence.json>]
  aegisflow [--base-url URL] gate reject <gate-id> --actor <actor-id> [--evidence <evidence.json>]

Environment:
  AEGISFLOW_BASE_URL   Control API URL (default: ${DEFAULT_BASE_URL})

Exit codes:
  0  command completed successfully
  1  API, network, or unexpected runtime failure
  2  invalid CLI input, identifier, JSON, or Flow definition
`;

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseGlobals(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedGlobals {
  const args: string[] = [];
  let baseUrl = env.AEGISFLOW_BASE_URL ?? DEFAULT_BASE_URL;
  let sawBaseUrl = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base-url") {
      if (sawBaseUrl) throw new CliUsageError("--base-url may be specified only once.");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError("--base-url requires a URL.");
      }
      baseUrl = value;
      sawBaseUrl = true;
      index += 1;
      continue;
    }
    if (token !== undefined) args.push(token);
  }

  return { baseUrl, args };
}

function parseCommandOptions(
  args: readonly string[],
  allowedValueOptions: readonly string[],
): CommandOptions {
  const allowed = new Set(allowedValueOptions);
  const positionals: string[] = [];
  const values: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!allowed.has(token)) throw new CliUsageError(`Unknown option '${token}'.`);
    if (values[token] !== undefined) throw new CliUsageError(`${token} may be specified only once.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${token} requires a value.`);
    }
    values[token] = value;
    index += 1;
  }

  return { positionals, values };
}

function requireSinglePositional(options: CommandOptions, label: string): string {
  if (options.positionals.length !== 1 || options.positionals[0] === undefined) {
    throw new CliUsageError(`Expected exactly one ${label}.`);
  }
  return options.positionals[0];
}

function requireOption(options: CommandOptions, name: string): string {
  const value = options.values[name];
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`${name} is required.`);
  }
  return value;
}

function optionalOption(options: CommandOptions, name: string): string | undefined {
  return options.values[name];
}

function ensureIdempotencyKey(value: string): string {
  if (value.length === 0 || value.length > 200) {
    throw new CliUsageError("--idempotency-key must contain between 1 and 200 characters.");
  }
  return value;
}

async function readJson(
  path: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<unknown> {
  let text: string;
  try {
    text = await readTextFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`Cannot read '${path}': ${message}`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_FILE_BYTES) {
    throw new CliUsageError(`'${path}' exceeds the 1 MiB CLI JSON file limit.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new CliUsageError(`'${path}' is not valid JSON: ${message}`);
  }
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliUsageError(`${label} must contain a JSON object.`);
  }
  return value as JsonObject;
}

function createClient(baseUrl: string, fetcher: typeof globalThis.fetch | undefined): AegisFlowClient {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new CliUsageError("--base-url / AEGISFLOW_BASE_URL must be an http(s) URL.");
  }
  return fetcher === undefined
    ? new AegisFlowClient({ baseUrl })
    : new AegisFlowClient({ baseUrl, fetch: fetcher });
}

async function handleFlow(
  action: string | undefined,
  args: readonly string[],
  getClient: () => AegisFlowClient,
  readTextFile: (path: string) => Promise<string>,
  stdout: (text: string) => void,
): Promise<void> {
  if (action !== "validate" && action !== "submit") {
    throw new CliUsageError("flow action must be 'validate' or 'submit'.");
  }
  const options = parseCommandOptions(args, []);
  const path = requireSinglePositional(options, "Flow JSON path");
  const definition = validateFlowDefinition(await readJson(path, readTextFile));

  if (action === "validate") {
    writeJson(stdout, {
      valid: true,
      name: definition.name,
      stageCount: definition.stages.length,
    });
    return;
  }

  const registered = await getClient().registerFlow(definition);
  writeJson(stdout, {
    flowId: registered.flow.id,
    flowVersionId: registered.version.id,
    version: registered.version.version,
    name: registered.flow.name,
    created: registered.created,
  });
}

async function handleExecution(
  action: string | undefined,
  args: readonly string[],
  client: AegisFlowClient,
  stdout: (text: string) => void,
): Promise<void> {
  if (action === "start") {
    const options = parseCommandOptions(args, ["--idempotency-key", "--version"]);
    const flowId = parseFlowId(requireSinglePositional(options, "Flow ID"));
    const idempotencyKey = ensureIdempotencyKey(requireOption(options, "--idempotency-key"));
    const version = optionalOption(options, "--version");
    const response = version === undefined
      ? await client.startExecution({ flowId, idempotencyKey })
      : await client.startExecution({
          flowId,
          flowVersionId: parseFlowVersionId(version),
          idempotencyKey,
        });
    writeJson(stdout, response);
    return;
  }

  if (action === "inspect") {
    const options = parseCommandOptions(args, []);
    const executionId = parseExecutionId(requireSinglePositional(options, "Execution ID"));
    writeJson(stdout, await client.getExecution(executionId));
    return;
  }

  throw new CliUsageError("execution action must be 'start' or 'inspect'.");
}

async function handleGate(
  action: string | undefined,
  args: readonly string[],
  client: AegisFlowClient,
  readTextFile: (path: string) => Promise<string>,
  stdout: (text: string) => void,
): Promise<void> {
  if (action !== "approve" && action !== "reject") {
    throw new CliUsageError("gate action must be 'approve' or 'reject'.");
  }
  const options = parseCommandOptions(args, ["--actor", "--evidence"]);
  const gateId = parseGateId(requireSinglePositional(options, "Gate ID"));
  const actorId = requireOption(options, "--actor");
  const evidencePath = optionalOption(options, "--evidence");
  const evidence = evidencePath === undefined
    ? undefined
    : requireJsonObject(await readJson(evidencePath, readTextFile), "Gate evidence file");

  const input = evidence === undefined
    ? { gateId, actorId }
    : { gateId, actorId, evidence };
  const response = action === "approve"
    ? await client.approveGate(input)
    : await client.rejectGate(input);
  writeJson(stdout, response);
}

function errorPayload(error: unknown): { readonly error: { readonly code: string; readonly message: string; readonly status?: number; readonly path?: string } } {
  if (error instanceof AegisFlowSdkError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
      },
    };
  }
  if (error instanceof ContractError) {
    const base = { code: error.code, message: error.message };
    return error.path === undefined
      ? { error: base }
      : { error: { ...base, path: error.path } };
  }
  if (error instanceof CliUsageError) {
    return { error: { code: "CLI_USAGE", message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: { code: "CLI_ERROR", message } };
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const readTextFile = dependencies.readTextFile
    ?? ((path: string) => nodeReadFile(path, "utf8"));

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    stdout(HELP);
    return 0;
  }

  try {
    const { baseUrl, args } = parseGlobals(argv, env);
    const [resource, action, ...rest] = args;
    if (resource === undefined) throw new CliUsageError("A resource command is required.");
    let client: AegisFlowClient | undefined;
    const getClient = (): AegisFlowClient => {
      client ??= createClient(baseUrl, dependencies.fetch);
      return client;
    };

    if (resource === "flow") {
      await handleFlow(action, rest, getClient, readTextFile, stdout);
      return 0;
    }
    if (resource === "execution") {
      await handleExecution(action, rest, getClient(), stdout);
      return 0;
    }
    if (resource === "gate") {
      await handleGate(action, rest, getClient(), readTextFile, stdout);
      return 0;
    }
    throw new CliUsageError(`Unknown resource '${resource}'.`);
  } catch (error) {
    writeJson(stderr, errorPayload(error));
    return error instanceof CliUsageError || error instanceof ContractError ? 2 : 1;
  }
}

export { HELP as CLI_HELP };
