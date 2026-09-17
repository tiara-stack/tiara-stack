import {
  type BaseDefaultContext,
  type BaseDefaultSchema,
  type ConnectionState,
  type ZeroOptions,
  Zero,
} from "@rocicorp/zero";
import {
  Data,
  Deferred,
  Duration,
  Effect,
  Match,
  Predicate,
  Queue,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";

export interface SheetZeroAuthToken {
  readonly accessToken: string;
  readonly expiresAtEpochSeconds: number | undefined;
}

export interface SheetZeroAuthProvider {
  readonly get: () => Effect.Effect<SheetZeroAuthToken, unknown>;
  readonly refresh: () => Effect.Effect<SheetZeroAuthToken, unknown>;
}

export interface SheetZeroAuthContext {
  readonly currentTokenExpiresAtEpochSeconds: number | undefined;
  readonly nowEpochSeconds: number;
}

export class SheetZeroAuthorizationFailure extends Data.TaggedError(
  "SheetZeroAuthorizationFailure",
)<{
  readonly message: string;
}> {}

class SheetZeroConnectionError extends Data.TaggedError("SheetZeroConnectionError")<{
  readonly state: ConnectionState;
}> {}

const isSheetZeroConnectionError = (error: unknown): error is SheetZeroConnectionError =>
  Predicate.isTagged("SheetZeroConnectionError")(error);

const zeroApiServerStatus = (reason: string) => {
  const prefix = "Fetch from API server returned non-OK status ";
  if (!reason.startsWith(prefix)) return undefined;

  const status = Number(reason.slice(prefix.length));
  return Number.isInteger(status) ? status : undefined;
};

const isExpiredTokenRevalidation = (reason: string, context: SheetZeroAuthContext) =>
  zeroApiServerStatus(reason) === 500 &&
  context.currentTokenExpiresAtEpochSeconds !== undefined &&
  context.currentTokenExpiresAtEpochSeconds <= context.nowEpochSeconds;

export const shouldRefreshSheetZeroAuth = (state: ConnectionState, context: SheetZeroAuthContext) =>
  Match.value(state).pipe(
    Match.when({ name: "needs-auth" }, () => true),
    Match.when({ name: "error" }, (current) => isExpiredTokenRevalidation(current.reason, context)),
    Match.orElse(() => false),
  );

const isRecoverableSheetZeroError = (reason: string) => reason.includes("CONNECTION_CLOSED");

export const shouldReconnectSheetZero = (state: ConnectionState) =>
  Match.value(state).pipe(
    Match.when({ name: "needs-auth" }, () => true),
    Match.when({ name: "error" }, ({ reason }) => isRecoverableSheetZeroError(reason)),
    Match.orElse(() => false),
  );

const isPermanentSheetZeroAuthorizationFailure = (error: unknown) =>
  Predicate.isTagged("SheetZeroAuthorizationFailure")(error);

const authenticationSchedule = Schedule.exponential(Duration.millis(250)).pipe(
  Schedule.modifyDelay((_output, delay) =>
    Effect.succeed(Duration.min(delay, Duration.seconds(30))),
  ),
);
const initialAuthenticationSchedule = Schedule.both(authenticationSchedule, Schedule.recurs(3));
const initialReconnectDelay = Duration.millis(250);

type ReconnectRequest = undefined;

interface ReconnectState {
  readonly refreshAuth: boolean;
  readonly reconnectPending: boolean;
  readonly reconnectActive: boolean;
  readonly wakeUpPending: boolean;
  readonly permanentlyFailed: boolean;
}

export interface ResilientSheetZero<S extends BaseDefaultSchema, C extends BaseDefaultContext> {
  readonly zero: Zero<S, undefined, C>;
  /** Fails when a refresh proves that the original principal is no longer valid. */
  readonly permanentAuthorizationFailure: Stream.Stream<never, unknown>;
}

export interface ResilientSheetZeroOptions<
  S extends BaseDefaultSchema,
  C extends BaseDefaultContext,
> {
  readonly cacheURL: string;
  readonly userID: string;
  readonly storageKey?: string | undefined;
  readonly schema: S;
  readonly mutators?: ZeroOptions<S, undefined, C>["mutators"];
  readonly context?: C | undefined;
  readonly auth: SheetZeroAuthProvider;
}

/**
 * Keeps one Zero instance bound to one auth provider and reconnects it only in
 * response to the connection state. Query views remain attached to the same
 * Zero instance, so reconnect never re-enqueues or changes the observed run.
 */
export const makeResilientSheetZero = <S extends BaseDefaultSchema, C extends BaseDefaultContext>(
  options: ResilientSheetZeroOptions<S, C>,
): Effect.Effect<ResilientSheetZero<S, C>, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    let currentTokenExpiresAtEpochSeconds: number | undefined;
    const authenticationRequests = {
      "get-auth": options.auth.get,
      "refresh-auth": options.auth.refresh,
    } satisfies Record<"get-auth" | "refresh-auth", SheetZeroAuthProvider["get"]>;

    const authenticate = (
      request: "get-auth" | "refresh-auth",
      retrySchedule: Schedule.Schedule<unknown, unknown, never, never> = authenticationSchedule,
    ) =>
      Effect.suspend(() => authenticationRequests[request]()).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.tap((token) =>
          Effect.sync(() => {
            currentTokenExpiresAtEpochSeconds = token.expiresAtEpochSeconds;
          }),
        ),
        Effect.map((token) => token.accessToken),
        Effect.retry({
          schedule: retrySchedule,
          while: (error) => !isPermanentSheetZeroAuthorizationFailure(error),
        }),
      );

    const initialAuth = yield* authenticate("get-auth", initialAuthenticationSchedule);
    const zeroOptions: ZeroOptions<S, undefined, C> = {
      cacheURL: options.cacheURL,
      userID: options.userID,
      schema: options.schema,
      auth: initialAuth,
      ...(options.storageKey === undefined ? {} : { storageKey: options.storageKey }),
      ...(options.mutators === undefined ? {} : { mutators: options.mutators }),
      ...(options.context === undefined ? {} : { context: options.context }),
    };
    const zero = new Zero(zeroOptions);
    yield* Effect.addFinalizer(() => Effect.promise(() => zero.close()).pipe(Effect.ignore));

    const permanentAuthorizationFailure = yield* Deferred.make<never, unknown>();
    const reconnectRequests = yield* Queue.sliding<ReconnectRequest>(1);
    const refreshReconnectRequests = yield* Queue.sliding<ReconnectRequest>(1);
    const reconnectState = yield* Ref.make<ReconnectState>({
      refreshAuth: false,
      reconnectPending: false,
      reconnectActive: false,
      wakeUpPending: false,
      permanentlyFailed: false,
    });

    const beginReconnect = Ref.modify(
      reconnectState,
      (current) =>
        [
          { refreshAuth: current.refreshAuth },
          {
            ...current,
            refreshAuth: false,
            reconnectActive: true,
            reconnectPending: false,
            wakeUpPending: true,
          },
        ] as const,
    ).pipe(Effect.tap(() => Queue.poll(refreshReconnectRequests)));
    const finishReconnect = Ref.modify(reconnectState, (current) => [
      { shouldWakeWorker: current.reconnectPending && !current.permanentlyFailed },
      {
        ...current,
        refreshAuth: current.reconnectPending ? current.refreshAuth : false,
        reconnectActive: false,
        reconnectPending: false,
        wakeUpPending: current.reconnectPending && !current.permanentlyFailed,
      },
    ]);
    const markReconnectSucceeded = Ref.update(reconnectState, (current) => ({
      ...current,
      reconnectActive: false,
    }));

    const currentAuthContext = (): SheetZeroAuthContext => ({
      currentTokenExpiresAtEpochSeconds,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    });
    const requiresFreshAuthentication = (error: unknown) =>
      isSheetZeroConnectionError(error) &&
      shouldRefreshSheetZeroAuth(error.state, currentAuthContext());
    const isUnauthorizedConnectionError = (error: unknown) =>
      isSheetZeroConnectionError(error) &&
      Match.value(error.state).pipe(
        Match.when({ name: "needs-auth" }, () => true),
        Match.orElse(() => false),
      );

    const reconnect = (auth: string) =>
      Effect.tryPromise(() => zero.connection.connect({ auth })).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.flatMap(() =>
          Match.value(zero.connection.state.current).pipe(
            Match.when({ name: "connected" }, () => Effect.void),
            Match.orElse((state) => Effect.fail(new SheetZeroConnectionError({ state }))),
          ),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Failed to reconnect a sheet-bot Zero client; retrying").pipe(
            Effect.annotateLogs({ error }),
          ),
        ),
      );

    const reconnectAfterRequest = (refreshAuth: boolean): Effect.Effect<void, unknown> => {
      let shouldRefreshAuth = refreshAuth;

      const reconnectAttempt = Effect.suspend(() =>
        Ref.get(reconnectState).pipe(
          Effect.tap(({ refreshAuth: pendingRefresh }) =>
            pendingRefresh
              ? Effect.sync(() => {
                  shouldRefreshAuth = true;
                })
              : Effect.void,
          ),
          Effect.flatMap(() => authenticate(shouldRefreshAuth ? "refresh-auth" : "get-auth")),
        ),
      ).pipe(
        Effect.flatMap(reconnect),
        Effect.catch((error: unknown) => {
          const requiresRefresh = requiresFreshAuthentication(error);
          const isUnauthorized = isUnauthorizedConnectionError(error);
          if (!requiresRefresh && !isUnauthorized) return Effect.fail(error);
          if (isUnauthorized && shouldRefreshAuth) {
            return Effect.fail(
              new SheetZeroAuthorizationFailure({
                message: "Zero rejected refreshed observation credentials",
              }),
            );
          }
          shouldRefreshAuth = true;
          return Effect.fail(error);
        }),
      );

      const retry = (delay: Duration.Duration): Effect.Effect<void, unknown> =>
        reconnectAttempt.pipe(
          Effect.catch((error: unknown) =>
            isPermanentSheetZeroAuthorizationFailure(error)
              ? Effect.fail(error)
              : Effect.race(
                  Queue.take(refreshReconnectRequests).pipe(Effect.as("refresh" as const)),
                  Effect.sleep(delay).pipe(Effect.as("delay" as const)),
                ).pipe(
                  Effect.tap((reason) =>
                    Match.value(reason).pipe(
                      Match.when("refresh", () =>
                        Effect.sync(() => {
                          shouldRefreshAuth = true;
                        }),
                      ),
                      Match.orElse(() => Effect.void),
                    ),
                  ),
                  Effect.andThen(
                    Effect.suspend(() =>
                      retry(Duration.min(Duration.times(delay, 2), Duration.seconds(30))),
                    ),
                  ),
                ),
          ),
        );

      return retry(initialReconnectDelay);
    };

    const signalPermanentAuthorizationFailure = (error: unknown) =>
      Deferred.fail(permanentAuthorizationFailure, error).pipe(
        Effect.andThen(
          Ref.update(reconnectState, (current) => ({
            ...current,
            refreshAuth: false,
            reconnectPending: false,
            reconnectActive: false,
            wakeUpPending: false,
            permanentlyFailed: true,
          })),
        ),
        Effect.asVoid,
      );

    yield* Effect.forkScoped(
      Queue.take(reconnectRequests).pipe(
        Effect.flatMap(() => beginReconnect),
        Effect.flatMap(({ refreshAuth }) =>
          reconnectAfterRequest(refreshAuth).pipe(
            Effect.tap(() => markReconnectSucceeded),
            Effect.catch((error) =>
              isPermanentSheetZeroAuthorizationFailure(error)
                ? signalPermanentAuthorizationFailure(error)
                : Effect.fail(error),
            ),
            Effect.ensuring(
              finishReconnect.pipe(
                Effect.tap(({ shouldWakeWorker }) =>
                  shouldWakeWorker
                    ? Effect.sync(() => Queue.offerUnsafe(reconnectRequests, undefined))
                    : Effect.void,
                ),
              ),
            ),
          ),
        ),
        Effect.ignore({
          log: "Warn",
          message: "Sheet-bot Zero reconnect request failed after retries",
        }),
        Effect.forever,
      ),
    );

    const requestReconnect = (refreshAuth: boolean) => {
      const { shouldWakeRefresh, shouldWakeWorker } = Effect.runSync(
        Ref.modify(reconnectState, (current) => {
          if (current.permanentlyFailed) {
            return [{ shouldWakeRefresh: false, shouldWakeWorker: false }, current] as const;
          }
          const shouldWake = !current.wakeUpPending;
          const shouldWakeRefresh = current.reconnectActive && refreshAuth && !current.refreshAuth;
          return [
            { shouldWakeRefresh, shouldWakeWorker: shouldWake },
            {
              ...current,
              refreshAuth: current.refreshAuth || refreshAuth,
              reconnectPending: true,
              wakeUpPending: current.wakeUpPending || shouldWake,
            },
          ];
        }),
      );
      if (shouldWakeWorker) Queue.offerUnsafe(reconnectRequests, undefined);
      if (shouldWakeRefresh) Queue.offerUnsafe(refreshReconnectRequests, undefined);
    };

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        zero.connection.state.subscribe((state) => {
          const refreshAuth = shouldRefreshSheetZeroAuth(state, currentAuthContext());
          if (!refreshAuth && !shouldReconnectSheetZero(state)) return;
          requestReconnect(refreshAuth);
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    return {
      zero,
      permanentAuthorizationFailure: Stream.fromEffect(
        Deferred.await(permanentAuthorizationFailure),
      ),
    };
  });
