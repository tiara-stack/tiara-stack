import { Duration, Effect, Option, Predicate } from "effect";
import net from "node:net";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type { AccessChecker, AccessCheckRequest, AccessCheckResult } from "./types";

const isHttpStatusOk: Predicate.Predicate<number | undefined> = (status) =>
  Predicate.isNumber(status) && status >= 200 && status < 300;

export const isHttpReady = (result: AccessCheckResult) =>
  result.reachable && isHttpStatusOk(result.status);

const checkHttpEffect = (
  request: AccessCheckRequest,
  readiness: boolean,
): Effect.Effect<AccessCheckResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(
      readiness ? HttpClientRequest.get(request.origin) : HttpClientRequest.head(request.origin),
    );
    yield* response.arrayBuffer.pipe(Effect.ignore);
    const responseIsReady = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    return {
      reachable: readiness ? responseIsReady : response.status < 500,
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
  Effect.runPromise(checkHttpEffect(request, false).pipe(Effect.provide(FetchHttpClient.layer)));

export const checkHttpReadiness: AccessChecker = (request) =>
  Effect.runPromise(checkHttpEffect(request, true).pipe(Effect.provide(FetchHttpClient.layer)));

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
