import type { Diagnostic } from "./types";

export const makeDiagnostic = (
  code: Diagnostic["code"],
  message: string,
  remediation: string,
  details: Partial<Pick<Diagnostic, "mode" | "action" | "dependency" | "origin" | "port">> = {},
): Diagnostic => ({
  code,
  kind: "error",
  message,
  mode: details.mode ?? null,
  action: details.action ?? null,
  dependency: details.dependency ?? null,
  origin: details.origin ?? null,
  port: details.port ?? null,
  remediation,
});

export const makeWarning = (
  code: Diagnostic["code"],
  message: string,
  remediation: string,
  details: Partial<Pick<Diagnostic, "mode" | "action" | "dependency" | "origin" | "port">> = {},
): Diagnostic => ({
  ...makeDiagnostic(code, message, remediation, details),
  kind: "warning",
});
