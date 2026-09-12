import type { AccessChecker, AccessCheckRequest, AccessCheckResult } from "./types";

const readinessTimeoutMs = 30_000;

export const checkHttpAccess: AccessChecker = async (
  request: AccessCheckRequest,
): Promise<AccessCheckResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.origin, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });
    return { reachable: response.status < 500, status: response.status };
  } catch (error) {
    return {
      reachable: false,
      timedOut: controller.signal.aborted,
      reason: error instanceof Error ? error.message : "request failed",
    };
  } finally {
    clearTimeout(timer);
  }
};

export const waitForHttp = async (
  origin: string,
  timeoutMs = readinessTimeoutMs,
  exited?: Promise<{ readonly exitCode: number }>,
): Promise<AccessCheckResult> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (exited !== undefined) {
      const completed = await Promise.race([
        exited.then((result) => result),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), Math.min(100, remaining)),
        ),
      ]);
      if (completed !== undefined) {
        return { reachable: false, reason: `process exited with code ${completed.exitCode}` };
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
    const fetchBudget = deadline - Date.now();
    if (fetchBudget <= 0) break;
    const result = await checkHttpAccess({
      mode: "fast",
      dependency: "sheet-web",
      origin,
      timeoutMs: Math.min(1_000, fetchBudget),
      optional: false,
    });
    if (result.reachable) return result;
  }
  return { reachable: false, timedOut: true, reason: "readiness check timed out" };
};
