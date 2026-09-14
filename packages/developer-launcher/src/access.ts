import { Duration, Effect, Option } from "effect";
import net from "node:net";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { AccessChecker, AccessCheckRequest, AccessCheckResult } from "./types";

const readinessTimeoutMs = 30_000;

const checkHttpAccessEffect = (
  request: AccessCheckRequest,
): Effect.Effect<AccessCheckResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(HttpClientRequest.head(request.origin));
    return {
      reachable: response.status < 500,
      status: response.status,
    } satisfies AccessCheckResult;
  }).pipe(
    Effect.timeoutOption(Duration.millis(request.timeoutMs)),
    Effect.flatMap((result) =>
      Option.isNone(result)
        ? Effect.succeed({
            reachable: false,
            timedOut: true,
            reason: "request timed out",
          } satisfies AccessCheckResult)
        : Effect.succeed<AccessCheckResult>(result.value),
    ),
    Effect.catch((error) =>
      Effect.succeed({
        reachable: false,
        reason: error instanceof Error ? error.message : "request failed",
      } satisfies AccessCheckResult),
    ),
  );

export const checkHttpAccess: AccessChecker = (request) =>
  Effect.runPromise(checkHttpAccessEffect(request).pipe(Effect.provide(FetchHttpClient.layer)));

export const checkTcpAccess = (origin: string, timeoutMs: number): Promise<AccessCheckResult> => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return Promise.resolve({ reachable: false, reason: "invalid TCP endpoint" });
  }
  const port = Number(url.port || 6379);
  return Effect.runPromise(
    Effect.callback<AccessCheckResult>((resume) => {
      const socket = net.createConnection({
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port,
      });
      let settled = false;
      const finish = (result: AccessCheckResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resume(Effect.succeed(result));
      };
      const timer = setTimeout(
        () => finish({ reachable: false, timedOut: true, reason: "TCP check timed out" }),
        timeoutMs,
      );
      socket.once("connect", () => finish({ reachable: true }));
      socket.once("error", (error: NodeJS.ErrnoException) =>
        finish({ reachable: false, reason: error.code ?? "TCP check failed" }),
      );
      return Effect.sync(() => {
        clearTimeout(timer);
        socket.destroy();
      });
    }),
  );
};

const waitForHttpEffect = (
  origin: string,
  timeoutMs = readinessTimeoutMs,
  exited?: Promise<{ readonly exitCode: number }>,
): Effect.Effect<AccessCheckResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited !== undefined) {
        const completed = yield* Effect.race(
          Effect.promise(() => exited),
          Effect.sleep(Duration.millis(100)).pipe(Effect.as(undefined)),
        );
        if (completed !== undefined) {
          return {
            reachable: false,
            reason: `process exited with code ${completed.exitCode}`,
          };
        }
      } else {
        yield* Effect.sleep(Duration.millis(100));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = yield* checkHttpAccessEffect({
        mode: "fast",
        dependency: "sheet-web",
        origin,
        timeoutMs: Math.min(1_000, remaining),
        optional: false,
      });
      if (result.reachable) return result;
    }
    return { reachable: false, timedOut: true, reason: "readiness check timed out" };
  });

export const waitForHttp = (
  origin: string,
  timeoutMs = readinessTimeoutMs,
  exited?: Promise<{ readonly exitCode: number }>,
): Promise<AccessCheckResult> =>
  Effect.runPromise(
    waitForHttpEffect(origin, timeoutMs, exited).pipe(Effect.provide(FetchHttpClient.layer)),
  );
