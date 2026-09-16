import type { DevelopmentLifecycleObservationType } from "./lifecycle-types";
import type { Diagnostic, LauncherOutput, PlannedProcess } from "./types";
import { redactExecutionText, type ExecutionOutcomeStatus } from "./execution-shared";

export const lifecycleEventFormat = "tiara-stack.development.lifecycle" as const;
export const lifecycleEventVersion = 1 as const;

export type LifecycleEventObservation = DevelopmentLifecycleObservationType;

type LifecycleEvent = Readonly<Record<string, unknown>> & {
  readonly format: typeof lifecycleEventFormat;
  readonly eventVersion: typeof lifecycleEventVersion;
  readonly sequence: number;
  readonly type: string;
  readonly mode: LauncherOutput["mode"];
  readonly action: string | null;
  readonly command: string;
};

const redactDiagnostic = (diagnostic: Diagnostic): Diagnostic => ({
  ...diagnostic,
  message: redactExecutionText(diagnostic.message),
  remediation: redactExecutionText(diagnostic.remediation),
  origin: diagnostic.origin === null ? null : redactExecutionText(diagnostic.origin),
});

const plannedProcessFor = (
  observation: LifecycleEventObservation,
  output: LauncherOutput,
): PlannedProcess | undefined => {
  if (observation.type === "step") {
    return output.plannedProcesses.find(({ id }) => id === observation.id);
  }
  if (observation.type !== "started") return undefined;
  if (observation.mode === "fast") {
    return output.plannedProcesses.find(({ id }) => id === observation.service);
  }
  if (observation.mode === "compose") {
    const longLivedProcesses = output.plannedProcesses.filter(({ longLived }) => longLived);
    return longLivedProcesses.length === 1 ? longLivedProcesses[0] : undefined;
  }
  return undefined;
};

const processFields = (process: PlannedProcess | undefined) =>
  process === undefined
    ? {}
    : {
        process: {
          command: redactExecutionText(process.command),
          args: process.args.map(redactExecutionText),
        },
      };

const terminalFields = (observation: LifecycleEventObservation, output: LauncherOutput) => {
  if (observation.type !== "terminal") return {};
  const diagnostics = observation.diagnostics ?? output.errors;
  const warnings = observation.warnings ?? output.warnings;
  return {
    outcome: observation.outcome === "failed" ? "blocked" : observation.outcome,
    ...(observation.outcome === "failed" ? { executionOutcome: "failed" } : {}),
    readiness: observation.readiness ?? output.readiness,
    ...(diagnostics.length === 0 ? {} : { diagnostics: diagnostics.map(redactDiagnostic) }),
    ...(warnings.length === 0 ? {} : { warnings: warnings.map(redactDiagnostic) }),
  };
};

export const lifecycleEventFor = (
  observation: LifecycleEventObservation,
  output: LauncherOutput,
  sequence = observation.sequence,
): LifecycleEvent => {
  const process = plannedProcessFor(observation, output);
  const observationFields: Record<string, unknown> =
    observation.type === "terminal"
      ? (({
          sequence: _sequence,
          diagnostics: _diagnostics,
          outcome: _outcome,
          warnings: _warnings,
          ...fields
        }) => fields)(observation)
      : (({ sequence: _sequence, ...fields }) => fields)(observation);
  if (typeof observationFields.origin === "string") {
    observationFields.origin = redactExecutionText(observationFields.origin);
  }
  if (typeof observationFields.reason === "string") {
    observationFields.reason = redactExecutionText(observationFields.reason);
  }
  return {
    format: lifecycleEventFormat,
    eventVersion: lifecycleEventVersion,
    sequence,
    type: observation.type,
    mode: observation.mode,
    action: observation.action,
    ...observationFields,
    command: output.command,
    ...processFields(process),
    ...terminalFields(observation, output),
  };
};

export const renderLifecycleEvent = (
  observation: LifecycleEventObservation,
  output: LauncherOutput,
  sequence = observation.sequence,
): string => `${JSON.stringify(lifecycleEventFor(observation, output, sequence))}\n`;

export interface LifecycleStreamWriter {
  readonly writeObservation: (observation: LifecycleEventObservation) => void;
  readonly writeTerminal: (
    output: LauncherOutput,
    exitCode?: number,
    outcome?: ExecutionOutcomeStatus,
  ) => string;
  readonly eventCount: () => number;
  readonly hasTerminal: () => boolean;
}

export const makeLifecycleStreamWriter = (
  output: LauncherOutput,
  writeStdout: (value: string) => void,
): LifecycleStreamWriter => {
  let sequence = 0;
  let terminalWritten = false;
  const writeObservation = (observation: LifecycleEventObservation) => {
    if (terminalWritten) return;
    writeStdout(renderLifecycleEvent(observation, output, sequence + 1));
    sequence += 1;
    if (observation.type === "terminal") terminalWritten = true;
  };
  const writeTerminal = (
    terminalOutput: LauncherOutput,
    exitCode = 2,
    outcome?: ExecutionOutcomeStatus,
  ) => {
    if (terminalWritten) return "";
    const event = renderLifecycleTerminal(terminalOutput, exitCode, sequence + 1, outcome);
    writeStdout(event);
    sequence += 1;
    terminalWritten = true;
    return event;
  };
  return {
    writeObservation,
    writeTerminal,
    eventCount: () => sequence,
    hasTerminal: () => terminalWritten,
  };
};

export const renderLifecyclePlan = (output: LauncherOutput, help?: string): string =>
  `${JSON.stringify({
    format: lifecycleEventFormat,
    eventVersion: lifecycleEventVersion,
    sequence: 1,
    type: "planned",
    mode: output.mode,
    action: output.action,
    command: output.command,
    readiness: output.readiness,
    selectedServices: output.selectedServices,
    plannedProcesses: output.plannedProcesses.map((process) => ({
      id: process.id,
      command: redactExecutionText(process.command),
      args: process.args.map(redactExecutionText),
      longLived: process.longLived,
      readOnly: process.readOnly,
    })),
    urls: output.urls.map(({ name, url }) => ({ name, url: redactExecutionText(url) })),
    ...(help === undefined ? {} : { help: redactExecutionText(help) }),
    ...(output.warnings.length === 0 ? {} : { warnings: output.warnings.map(redactDiagnostic) }),
  })}\n`;

export const renderLifecycleTerminal = (
  output: LauncherOutput,
  exitCode = 2,
  sequence = 1,
  executionOutcome: ExecutionOutcomeStatus = output.ok ? "completed" : "blocked",
): string =>
  `${JSON.stringify({
    format: lifecycleEventFormat,
    eventVersion: lifecycleEventVersion,
    sequence,
    type: "terminal",
    mode: output.mode,
    action: output.action,
    command: output.command,
    outcome: executionOutcome === "failed" ? "blocked" : executionOutcome,
    ...(executionOutcome === "failed" ? { executionOutcome: "failed" } : {}),
    readiness: output.readiness,
    exitCode,
    ...(output.errors.length === 0 ? {} : { diagnostics: output.errors.map(redactDiagnostic) }),
    ...(output.warnings.length === 0 ? {} : { warnings: output.warnings.map(redactDiagnostic) }),
  })}\n`;

export type { LifecycleEvent };
