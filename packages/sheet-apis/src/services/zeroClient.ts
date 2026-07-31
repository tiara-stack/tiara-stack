import { Zero } from "@rocicorp/zero";
import {
  Cause,
  Duration,
  Effect,
  Layer,
  Match,
  Predicate,
  Queue,
  Redacted,
  Schedule,
  Semaphore,
} from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { type Schema, schema, mutators } from "sheet-db-schema/zero";
import { ZeroClient as BaseZeroClient } from "typhoon-zero/client";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

interface ZeroAuthToken {
  readonly auth: string;
  readonly refreshAfter: Duration.Duration;
}

type ZeroConnectionState = Zero<Schema, undefined, unknown>["connection"]["state"]["current"];

const authRefreshLeadTime = Duration.seconds(60);
const minimumAuthRefreshDelay = Duration.seconds(1);
const authRefreshTimeout = Duration.seconds(30);
const authRefreshMaxRetries = 5;
const authRefreshRetrySchedule = Schedule.exponential(Duration.millis(250)).pipe(
  Schedule.modifyDelay((_output, delay) =>
    Effect.succeed(Duration.min(delay, Duration.seconds(30))),
  ),
);

/** @internal */
export const zeroAuthRefreshDelay = (expiresAt: number, nowEpochSeconds: number) =>
  Duration.max(
    Duration.subtract(Duration.seconds(expiresAt - nowEpochSeconds), authRefreshLeadTime),
    minimumAuthRefreshDelay,
  );

/** @internal */
export const shouldRefreshZeroAuth = (state: ZeroConnectionState) =>
  Match.value(state).pipe(
    Match.when({ name: "needs-auth" }, () => true),
    // zero-cache revalidates each connection's auth token on its revalidate
    // interval (default 300s). A service token that expires between proactive
    // refreshes makes revalidation fail with TransformFailed, which zero-cache
    // surfaces to the client as a fatal "error" connection state (not
    // "needs-auth") and closes the websocket. Its reason is the string
    // "Fetch from API server returned non-OK status 500". Recover by re-authing
    // and reconnecting with a fresh token instead of leaving the connection
    // dead until the next proactive refresh.
    Match.when({ name: "error" }, (s) =>
      s.reason.includes("Fetch from API server returned non-OK status"),
    ),
    Match.orElse(() => false),
  );

/** @internal */
export const runProactiveZeroAuthRefresh = (
  initialRefreshAfter: Duration.Duration,
  refresh: () => Effect.Effect<ZeroAuthToken, unknown>,
) =>
  Effect.gen(function* () {
    let refreshAfter = initialRefreshAfter;
    while (true) {
      yield* Effect.sleep(refreshAfter);
      const token = yield* refresh();
      refreshAfter = token.refreshAfter;
    }
  });

const makeGetAuth = Effect.fn("zero.makeGetAuth")(function* () {
  const sheetAuthClient = yield* SheetAuthClient;
  const clientId = yield* config.sheetAuthOAuthClientId;
  const clientSecret = yield* config.sheetAuthOAuthClientSecret;
  const resource = yield* config.zeroOAuthAudience;
  return Effect.fn("zero.getAuth")(function* () {
    const token = yield* createOAuthClientCredentialsToken(sheetAuthClient, {
      clientId,
      clientSecret,
      resource,
      scope: ["service"],
    });
    return {
      auth: Redacted.value(token.accessToken),
      refreshAfter: zeroAuthRefreshDelay(token.expiresAt, Math.floor(Date.now() / 1000)),
    };
  });
});

const makeZero = Effect.fn("zero.makeZero")(function* () {
  const getAuth = yield* makeGetAuth();
  const initialToken = yield* getAuth();
  const zeroCacheServer = yield* config.zeroCacheServer;
  const zeroCacheUserId = yield* config.zeroCacheUserId;
  const zero = new Zero({
    server: zeroCacheServer,
    userID: zeroCacheUserId,
    auth: initialToken.auth,
    schema,
    mutators,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => zero.close()));

  const authRefreshSemaphore = yield* Semaphore.make(1);
  const refreshAuth = Effect.fn("zero.refreshAuth")((reason: "proactive" | "connection-state") =>
    authRefreshSemaphore.withPermit(
      getAuth().pipe(
        Effect.timeout(authRefreshTimeout),
        Effect.flatMap((token) =>
          Effect.tryPromise(() => zero.connection.connect({ auth: token.auth })).pipe(
            Effect.timeout(authRefreshTimeout),
            Effect.as(token),
          ),
        ),
        Effect.tap((token) =>
          Effect.logInfo("Refreshed sheet Zero OAuth credentials").pipe(
            Effect.annotateLogs({ reason, refreshAfter: Duration.format(token.refreshAfter) }),
          ),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Failed to refresh sheet Zero OAuth credentials; retrying").pipe(
            Effect.annotateLogs({
              errorMessage: Predicate.isError(error) ? error.message : "OAuth refresh failed",
              reason,
            }),
          ),
        ),
        Effect.retry({ schedule: authRefreshRetrySchedule, times: authRefreshMaxRetries }),
      ),
    ),
  );

  yield* runProactiveZeroAuthRefresh(initialToken.refreshAfter, () =>
    refreshAuth("proactive"),
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.logFatal("Proactive sheet Zero OAuth refresh stopped", Cause.pretty(cause)),
    ),
    Effect.forkScoped,
  );

  const connectionStateRefreshRequests = yield* Queue.sliding<"refresh-auth">(1);
  yield* Queue.take(connectionStateRefreshRequests).pipe(
    Effect.flatMap(() => refreshAuth("connection-state")),
    Effect.forever,
    Effect.tapCause((cause) =>
      Effect.logFatal("Sheet Zero connection-state OAuth refresh stopped", Cause.pretty(cause)),
    ),
    Effect.forkScoped,
  );

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      zero.connection.state.subscribe((state) =>
        shouldRefreshZeroAuth(state)
          ? Queue.offerUnsafe(connectionStateRefreshRequests, "refresh-auth")
          : false,
      ),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

  return zero;
});

export class ZeroClient extends BaseZeroClient.ZeroClient<Schema, undefined, unknown>() {
  static layer = Layer.effect(
    ZeroClient,
    Effect.gen({ self: this }, function* () {
      const zero = yield* makeZero();
      return yield* this.make(zero);
    }),
  ).pipe(Layer.provide(SheetAuthClient.layer));
}
