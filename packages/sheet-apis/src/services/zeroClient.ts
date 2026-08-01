import { Zero } from "@rocicorp/zero";
import {
  Cause,
  Clock,
  Data,
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

type AuthenticationReason = "initial" | "proactive" | "connection-state";
type ZeroConnectionState = Zero<Schema, undefined, unknown>["connection"]["state"]["current"];

class ZeroConnectionError extends Data.TaggedError("ZeroConnectionError")<{
  readonly state: ZeroConnectionState;
}> {}

const authRefreshLeadTime = Duration.seconds(60);
const minimumAuthRefreshDelay = Duration.seconds(1);
const authenticationTimeout = Duration.seconds(30);
const authenticationSchedule = Schedule.exponential(Duration.millis(250)).pipe(
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

const isZeroConnectionError = (error: unknown): error is ZeroConnectionError =>
  Predicate.isTagged("ZeroConnectionError")(error);

const requiresFreshAuthentication = (error: unknown) =>
  isZeroConnectionError(error) && shouldRefreshZeroAuth(error.state);

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

const hasNonInterruptReason = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some((reason) => !Cause.isInterruptReason(reason));

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
    const now = yield* Clock.currentTimeMillis;
    return {
      auth: Redacted.value(token.accessToken),
      refreshAfter: zeroAuthRefreshDelay(token.expiresAt, Math.floor(now / 1000)),
    };
  });
});

/** @internal */
export const makeZero = Effect.fn("zero.makeZero")(function* () {
  const getAuth = yield* makeGetAuth();
  const zeroCacheServer = yield* config.zeroCacheServer;
  const zeroCacheUserId = yield* config.zeroCacheUserId;

  const authenticate = Effect.fn("zero.authenticate")((reason: AuthenticationReason) =>
    getAuth().pipe(
      Effect.timeout(authenticationTimeout),
      Effect.tapError((error) =>
        Effect.logWarning("Failed to authenticate the sheet Zero client; retrying").pipe(
          Effect.annotateLogs({ error, reason }),
        ),
      ),
      Effect.retry({ schedule: authenticationSchedule }),
    ),
  );

  // Zero authentication is a mandatory dependency for both startup and the
  // long-lived client. Retry without a total limit so a transient auth outage
  // delays readiness or reconnection instead of permanently stopping refresh.
  const initialToken = yield* authenticate("initial");
  const zero = new Zero({
    server: zeroCacheServer,
    userID: zeroCacheUserId,
    auth: initialToken.auth,
    schema,
    mutators,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => zero.close()));

  const authRefreshSemaphore = yield* Semaphore.make(1);
  const reconnect = Effect.fn("zero.reconnect")(
    (token: ZeroAuthToken, reason: Exclude<AuthenticationReason, "initial">) =>
      Effect.tryPromise(() => zero.connection.connect({ auth: token.auth })).pipe(
        Effect.timeout(authenticationTimeout),
        Effect.flatMap(() =>
          Match.value(zero.connection.state.current).pipe(
            Match.when({ name: "connected" }, () => Effect.succeed(token)),
            Match.orElse((state) => Effect.fail(new ZeroConnectionError({ state }))),
          ),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Failed to reconnect the sheet Zero client; retrying").pipe(
            Effect.annotateLogs({ error, reason }),
          ),
        ),
        Effect.retry({
          schedule: authenticationSchedule,
          while: (error) => !requiresFreshAuthentication(error),
        }),
      ),
  );
  const refreshAuth = Effect.fn("zero.refreshAuth")(
    (reason: Exclude<AuthenticationReason, "initial">) =>
      authRefreshSemaphore.withPermit(
        authenticate(reason).pipe(
          Effect.flatMap((token) => reconnect(token, reason)),
          Effect.retry({
            schedule: authenticationSchedule,
            while: requiresFreshAuthentication,
          }),
          Effect.tap((token) =>
            Effect.logInfo("Refreshed sheet Zero OAuth credentials").pipe(
              Effect.annotateLogs({ reason, refreshAfter: Duration.format(token.refreshAfter) }),
            ),
          ),
        ),
      ),
  );

  const logUnexpectedWorkerFailure = (worker: "proactive" | "connection-state") =>
    Effect.tapCauseIf(hasNonInterruptReason, (cause) =>
      Effect.logFatal("Sheet Zero OAuth refresh worker stopped unexpectedly").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause), worker }),
      ),
    );

  yield* runProactiveZeroAuthRefresh(initialToken.refreshAfter, () =>
    refreshAuth("proactive"),
  ).pipe(logUnexpectedWorkerFailure("proactive"), Effect.forkScoped);

  const connectionStateRefreshRequests = yield* Queue.sliding<void>(1);
  yield* Queue.take(connectionStateRefreshRequests).pipe(
    Effect.flatMap(() => refreshAuth("connection-state")),
    Effect.forever,
    logUnexpectedWorkerFailure("connection-state"),
    Effect.forkScoped,
  );

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      zero.connection.state.subscribe((state) =>
        shouldRefreshZeroAuth(state)
          ? Queue.offerUnsafe(connectionStateRefreshRequests, undefined)
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
