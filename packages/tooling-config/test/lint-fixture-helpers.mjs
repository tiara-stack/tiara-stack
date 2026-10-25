import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// The shortest integration-test budget is 30 seconds, so each synchronous
// fixture subprocess must fail before Vitest's timeout can be blocked.
const LINT_FIXTURE_TIMEOUT_MS = 25_000;

const commandText = (command, args) => [command, ...args].join(" ");

const subprocessError = (message, result) => {
  const error = new Error(message);
  error.cause = result.error;
  error.code = result.error?.code;
  error.signal = result.signal;
  error.status = result.status;
  error.stdout = result.stdout ?? "";
  error.stderr = result.stderr ?? "";
  return error;
};

const timeoutError = (result, label, timeoutMs) =>
  result.error?.code === "ETIMEDOUT"
    ? subprocessError(
        `Synchronous fixture subprocess timed out after ${timeoutMs} ms: ${label}`,
        result,
      )
    : undefined;
const spawnError = (result, label) =>
  result.error && result.error.code !== "ETIMEDOUT"
    ? subprocessError(
        `Could not start fixture subprocess: ${label}: ${result.error.message}`,
        result,
      )
    : undefined;
const signalError = (result, label) =>
  result.signal !== null
    ? subprocessError(`Fixture subprocess terminated by ${result.signal}: ${label}`, result)
    : undefined;
const missingExitStatusError = (result, label) =>
  result.status === null
    ? subprocessError(`Fixture subprocess ended without an exit status: ${label}`, result)
    : undefined;
const findSubprocessError = (result, label, timeoutMs) => {
  const checks = [timeoutError, spawnError, signalError, missingExitStatusError];
  for (const check of checks) {
    const error = check(result, label, timeoutMs);
    if (error !== undefined) return error;
  }
  return undefined;
};

const subprocessReceiptStatus = (result) => ({
  pid: result.pid ?? null,
  exitCode: result.status ?? null,
  signal: result.signal ?? null,
});

const subprocessReceiptOutcome = (result) => ({
  childLaunched: result.pid !== undefined,
  timedOut: result.error?.code === "ETIMEDOUT",
});

const captureFixtureSubprocess = (result, command, args, cwd, startedAt, completedAt) => {
  const captureDirectory = process.env.TIA230_FIXTURE_CHILD_CAPTURE_DIR;
  if (captureDirectory === undefined) return;
  mkdirSync(captureDirectory, { recursive: true });
  const stem = `${process.pid}-${randomUUID()}`;
  const stdoutPath = path.join(captureDirectory, `${stem}.stdout.raw`);
  const stderrPath = path.join(captureDirectory, `${stem}.stderr.raw`);
  const stdout = Buffer.from(result.stdout ?? "", "utf8");
  const stderr = Buffer.from(result.stderr ?? "", "utf8");
  writeFileSync(stdoutPath, stdout, { flag: "wx" });
  writeFileSync(stderrPath, stderr, { flag: "wx" });
  const receipt = {
    ...subprocessReceiptStatus(result),
    ...subprocessReceiptOutcome(result),
    startedAt,
    completedAt,
    argv: [command, ...args],
    cwd,
    stdout: {
      path: stdoutPath,
      bytes: stdout.byteLength,
      sha256: createHash("sha256").update(stdout).digest("hex"),
    },
    stderr: {
      path: stderrPath,
      bytes: stderr.byteLength,
      sha256: createHash("sha256").update(stderr).digest("hex"),
    },
  };
  writeFileSync(
    path.join(captureDirectory, `${stem}.receipt.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
};

// The integration suites have a 30-second minimum Vitest deadline. Cap each
// synchronous child below it so one stalled lint cannot block the worker.
export const runCommand = (
  command,
  args,
  { cwd = process.cwd(), env = {}, timeoutMs = LINT_FIXTURE_TIMEOUT_MS } = {},
) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("Fixture subprocess timeoutMs must be a positive integer");

  const startedAt = new Date().toISOString();
  const childEnvironment = { ...process.env, ...env };
  if (
    env.TIARA_NESTED_TERNARY_BASELINE_PATH !== undefined &&
    env.TIARA_NESTED_TERNARY_TEST_BASELINE === undefined
  ) {
    childEnvironment.NODE_ENV = "test";
    childEnvironment.TIARA_NESTED_TERNARY_TEST_BASELINE = "1";
  }
  const result = spawnSync(command, args, {
    cwd,
    env: childEnvironment,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const completedAt = new Date().toISOString();
  captureFixtureSubprocess(result, command, args, cwd, startedAt, completedAt);
  const label = commandText(command, args);
  const failure = findSubprocessError(result, label, timeoutMs);
  if (failure !== undefined) throw failure;

  return result;
};

export const runPnpm = (args, options = {}) => runCommand("pnpm", args, options);

const jsonContainerClosers = new Map([
  ["{", "}"],
  ["[", "]"],
]);
const isJsonContainerClose = (character) => character === "}" || character === "]";
const advanceJsonStringState = (state, character) => {
  if (state.escaped) {
    state.escaped = false;
    return;
  }
  if (character === "\\") {
    state.escaped = true;
    return;
  }
  if (character === '"') state.inString = false;
};
const advanceJsonStructure = (stack, character) => {
  const close = jsonContainerClosers.get(character);
  if (close !== undefined) {
    stack.push(close);
    return false;
  }
  if (!isJsonContainerClose(character)) return false;
  if (stack.pop() !== character) throw new SyntaxError("Mismatched JSON container");
  return stack.length === 0;
};
const advanceJsonDocument = (state, character) => {
  if (state.inString) {
    advanceJsonStringState(state, character);
    return false;
  }
  if (character === '"') {
    state.inString = true;
    return false;
  }
  return advanceJsonStructure(state.stack, character);
};
const jsonDocumentEnd = (source, start) => {
  const state = { stack: [], inString: false, escaped: false };
  for (let index = start; index < source.length; index++)
    if (advanceJsonDocument(state, source[index])) return index + 1;
  throw new SyntaxError("Incomplete JSON document in lint output");
};
const parseLintJsonDocuments = (stdout) => {
  const documents = [];
  const unstructured = [];
  let cursor = 0;
  while (cursor < stdout.length) {
    const start = stdout.indexOf("{", cursor);
    if (start < 0) {
      unstructured.push(stdout.slice(cursor));
      break;
    }
    unstructured.push(stdout.slice(cursor, start));
    const end = jsonDocumentEnd(stdout, start);
    documents.push(JSON.parse(stdout.slice(start, end)));
    cursor = end;
  }
  return { documents, unstructuredStdout: unstructured.join("") };
};

const validateLintDocuments = (documents) => {
  for (const document of documents) {
    if (!Array.isArray(document.diagnostics))
      throw new Error("Lint JSON document did not contain a diagnostics array");
  }
};

export const diagnostics = (result) => {
  const parsed = parseLintJsonDocuments(result.stdout);
  if (parsed.documents.length === 0)
    throw new Error(
      `Expected JSON lint diagnostics, received: ${parsed.unstructuredStdout || "empty stdout"}`,
    );
  validateLintDocuments(parsed.documents);
  result.jsonDocuments = parsed.documents;
  result.unstructuredStdout = parsed.unstructuredStdout;
  return parsed.documents.flatMap((document) => document.diagnostics);
};
