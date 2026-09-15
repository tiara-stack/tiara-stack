import { Effect } from "effect";
import type {
  AccessCheckResult,
  Diagnostic,
  LauncherOutput,
  ProcessResult,
  RunningProcess,
} from "./types";

export const statusCodeFields = (result: AccessCheckResult) =>
  result.status === undefined ? {} : { responseStatus: result.status };

export const reasonFields = (result: AccessCheckResult) =>
  result.reason === undefined ? {} : { reason: result.reason };

const executionTextLimit = 64 * 1024;

const dockerAuthConfigAssignment = /\bDOCKER[_-]?AUTH[_-]?CONFIG["']?\s*[:=]\s*(?=\S)/gi;

const quotedValueEnd = (value: string, start: number, quote: string) => {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return index + 1;
    }
  }
  return value.length;
};

// fallow-ignore-next-line complexity
const dockerAuthConfigValueEnd = (value: string, start: number) => {
  const firstCharacter = value[start];
  if (firstCharacter === '"' || firstCharacter === "'") {
    return quotedValueEnd(value, start, firstCharacter);
  }
  if (firstCharacter !== "{") {
    let index = start;
    while (index < value.length && !/[\s,}]/.test(value[index] ?? "")) index += 1;
    return index;
  }

  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}" && --depth === 0) {
      return index + 1;
    }
  }
  return value.length;
};

const redactDockerAuthConfig = (value: string) => {
  let cursor = 0;
  let searchStart = 0;
  let result = "";
  for (const match of value.matchAll(dockerAuthConfigAssignment)) {
    const assignmentStart = match.index;
    if (assignmentStart === undefined || assignmentStart < searchStart) continue;
    const valueStart = assignmentStart + match[0].length;
    const valueEnd = dockerAuthConfigValueEnd(value, valueStart);
    result += `${value.slice(cursor, valueStart)}<redacted>`;
    cursor = valueEnd;
    searchStart = valueEnd;
  }
  return result + value.slice(cursor);
};

export const redactExecutionText = (value: string) =>
  redactDockerAuthConfig(value.slice(0, executionTextLimit))
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)=)[^&\s]+/gi,
      "$1<redacted>",
    )
    .replace(/(\b(?:Bearer|Basic)\s+)[^\s]+/gi, "$1<redacted>")
    .replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|token|credential|private[_-]?key)["']?\s*[:=]\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"<redacted>"',
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|token|credential|private[_-]?key)["']?\s*[:=]\s*)'(?:\\.|[^'\\])*'/gi,
      "$1'<redacted>'",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|token|credential|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1<redacted>",
    )
    .slice(0, executionTextLimit);

export const terminalOutput = (
  output: LauncherOutput,
  status: ExecutionOutcomeStatus,
  diagnostic?: Diagnostic,
  cleanupDiagnostic?: Diagnostic,
): LauncherOutput => {
  if (diagnostic !== undefined) {
    return {
      ...output,
      ok: false,
      readiness: output.readiness === "ready" ? "ready" : "blocked",
      errors: [diagnostic, ...(cleanupDiagnostic === undefined ? [] : [cleanupDiagnostic])],
    };
  }
  if (cleanupDiagnostic !== undefined) {
    return {
      ...output,
      ok: false,
      readiness: output.readiness === "ready" ? "ready" : "blocked",
      errors: [cleanupDiagnostic],
    };
  }
  return {
    ...output,
    readiness:
      status === "completed" && output.readiness !== "ready"
        ? "completed"
        : status === "stopped" && output.readiness !== "ready"
          ? "stopped"
          : output.readiness,
  };
};

export interface ProcessExitObservation {
  readonly state: { result: ProcessResult | undefined };
  readonly effect: Effect.Effect<ProcessResult>;
}

export const observeProcessExit = (running: RunningProcess): ProcessExitObservation => {
  const state: ProcessExitObservation["state"] = { result: undefined };
  const promise = running.exited.then(
    (result) => {
      state.result = result;
      return result;
    },
    () => {
      const result = {
        exitCode: 127,
        stderr: "process exit could not be observed",
      } satisfies ProcessResult;
      state.result = result;
      return result;
    },
  );
  return { state, effect: Effect.promise(() => promise) };
};

export const currentProcessExit = (observation: ProcessExitObservation) => observation.state.result;

export const processSignals: Effect.Effect<NodeJS.Signals> = Effect.callback<NodeJS.Signals>(
  (resume) => {
    let settled = false;
    const remove = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    const receive = (signal: NodeJS.Signals) => {
      if (settled) return;
      settled = true;
      remove();
      resume(Effect.succeed(signal));
    };
    const onInterrupt = () => receive("SIGINT");
    const onTerminate = () => receive("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    return Effect.sync(remove);
  },
);

export type ExecutionOutcomeStatus = "completed" | "stopped" | "blocked" | "failed";

export interface ExecutionOutcome<Status extends ExecutionOutcomeStatus> {
  readonly status: Status;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly diagnostic?: Diagnostic;
  readonly cleanupDiagnostic?: Diagnostic;
}

export interface ExecutionResult<Status extends ExecutionOutcomeStatus, Observation> {
  readonly output: LauncherOutput;
  readonly observations: readonly Observation[];
  readonly outcome: ExecutionOutcome<Status>;
  readonly readyOutput?: LauncherOutput;
}

const makeExecutionResult = <Status extends ExecutionOutcomeStatus, Observation>(
  output: LauncherOutput,
  observations: readonly Observation[],
  status: Status,
  exitCode: number,
  diagnostic?: Diagnostic,
  cleanupDiagnostic?: Diagnostic,
  readyOutput?: LauncherOutput,
): ExecutionResult<Status, Observation> => ({
  output,
  observations,
  outcome: {
    status,
    ok: status === "completed" || status === "stopped",
    exitCode,
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(cleanupDiagnostic === undefined ? {} : { cleanupDiagnostic }),
  },
  ...(readyOutput === undefined ? {} : { readyOutput }),
});

export const makeExecutionResultFromContext = <Status extends ExecutionOutcomeStatus, Observation>(
  plannedOutput: LauncherOutput,
  observations: readonly Observation[],
  formatOutput: (
    output: LauncherOutput,
    status: Status,
    diagnostic?: Diagnostic,
    cleanupDiagnostic?: Diagnostic,
  ) => LauncherOutput,
  status: Status,
  exitCode: number,
  diagnostic?: Diagnostic,
  cleanupDiagnostic?: Diagnostic,
  readyOutput?: LauncherOutput,
): ExecutionResult<Status, Observation> =>
  makeExecutionResult(
    formatOutput(readyOutput ?? plannedOutput, status, diagnostic, cleanupDiagnostic),
    observations,
    status,
    exitCode,
    diagnostic,
    cleanupDiagnostic,
    readyOutput,
  );
