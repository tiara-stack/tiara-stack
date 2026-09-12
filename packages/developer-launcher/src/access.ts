import type { AccessChecker, AccessCheckRequest, AccessCheckResult } from "./types";

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
