import { Zero } from "@rocicorp/zero";
import {
  Cache,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Predicate,
  Queue,
  Redacted,
  Schedule,
} from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import {
  makeSheetServiceClient,
  mutators,
  schema,
  serviceApi,
  type DelegatedWorkflowEnqueueRequest,
  type Schema as SheetZeroSchema,
} from "sheet-db-schema/zero";
import { ZeroClient as BaseZeroClient } from "typhoon-zero/client";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

type WorkflowZeroConnectionState = Zero<
  SheetZeroSchema,
  undefined,
  unknown
>["connection"]["state"]["current"];

class WorkflowZeroConnectionError extends Data.TaggedError("WorkflowZeroConnectionError")<{
  readonly state: WorkflowZeroConnectionState;
}> {}

/** @internal */
export const shouldRefreshWorkflowZeroAuth = (state: WorkflowZeroConnectionState) =>
  Match.value(state).pipe(
    Match.when({ name: "needs-auth" }, () => true),
    // zero-cache reports an expired-token revalidation as a fatal error state
    // instead of needs-auth. Reconnect with a fresh token so workflow dispatches
    // do not remain broken after the service credential expires.
    Match.when({ name: "error" }, (current) =>
      current.reason.includes("Fetch from API server returned non-OK status"),
    ),
    Match.orElse(() => false),
  );

const isWorkflowZeroConnectionError = (error: unknown): error is WorkflowZeroConnectionError =>
  Predicate.isTagged("WorkflowZeroConnectionError")(error);

const requiresFreshAuthentication = (error: unknown) =>
  isWorkflowZeroConnectionError(error) && shouldRefreshWorkflowZeroAuth(error.state);

const makeGetAuth = Effect.fn("WorkflowZeroClient.makeGetAuth")(function* () {
  const sheetAuthClient = yield* SheetAuthClient;
  const clientId = yield* config.sheetAuthOAuthClientId;
  const clientSecret = yield* config.sheetAuthOAuthClientSecret;
  const resource = yield* config.zeroOAuthAudience;
  const cache = yield* Cache.makeWith(
    Effect.fn("WorkflowZeroClient.getOAuthToken")(() =>
      createOAuthClientCredentialsToken(sheetAuthClient, {
        clientId,
        clientSecret,
        resource,
        scope: ["service", "ingress.forward"],
      }).pipe(
        Effect.map((token) => ({
          accessToken: token.accessToken,
          timeToLive: Duration.max(
            Duration.seconds(token.expiresAt - Math.floor(Date.now() / 1000) - 60),
            Duration.zero,
          ),
        })),
      ),
    ),
    {
      capacity: 1,
      timeToLive: Exit.match({
        onFailure: () => Duration.seconds(1),
        onSuccess: ({ timeToLive }) => timeToLive,
      }),
    },
  );

  const readAccessToken = (token: { readonly accessToken: Redacted.Redacted<string> }) =>
    Redacted.value(token.accessToken);

  return {
    getAuth: Effect.fn("WorkflowZeroClient.getAuth")(function* () {
      return readAccessToken(yield* Cache.get(cache, resource));
    }),
    refreshAuth: Effect.fn("WorkflowZeroClient.refreshAuth")(function* () {
      return readAccessToken(yield* Cache.refresh(cache, resource));
    }),
  };
});

type AuthenticationRequest = "get-auth" | "refresh-auth";

const authenticationSchedule = Schedule.exponential(Duration.millis(250)).pipe(
  Schedule.modifyDelay((_output, delay) =>
    Effect.succeed(Duration.min(delay, Duration.seconds(30))),
  ),
);

export const makeZero = Effect.fn("WorkflowZeroClient.makeZero")(function* () {
  const { getAuth, refreshAuth } = yield* makeGetAuth();
  const server = yield* config.zeroCacheServer;
  const userID = yield* config.zeroCacheUserId;

  const authenticate = (request: AuthenticationRequest) =>
    Match.value(request).pipe(
      Match.when("get-auth", () => getAuth()),
      Match.when("refresh-auth", () => refreshAuth()),
      Match.exhaustive,
      Effect.timeout(Duration.seconds(30)),
      Effect.tapError((error) =>
        Effect.logWarning("Failed to authenticate the workflow Zero client; retrying").pipe(
          Effect.annotateLogs({ error, request }),
        ),
      ),
      Effect.retry({ schedule: authenticationSchedule }),
    );

  // Authentication is a mandatory startup dependency. Retry without a total
  // limit so transient auth outages delay readiness instead of crashing and
  // relying on an external process restart loop.
  const initialAuth = yield* authenticate("get-auth");
  const zero = new Zero({
    server,
    userID,
    schema,
    mutators,
    auth: initialAuth,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => zero.close()));

  const reconnectRequests = yield* Queue.sliding<void>(1);
  const reconnect = (auth: string) =>
    Effect.tryPromise(() => zero.connection.connect({ auth })).pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.flatMap(() =>
        Match.value(zero.connection.state.current).pipe(
          Match.when({ name: "connected" }, () => Effect.void),
          Match.orElse((state) => Effect.fail(new WorkflowZeroConnectionError({ state }))),
        ),
      ),
      Effect.tapError((error) =>
        Effect.logWarning("Failed to reauthenticate the workflow Zero client; retrying").pipe(
          Effect.annotateLogs({ error }),
        ),
      ),
      Effect.retry({
        schedule: authenticationSchedule,
        while: (error) => !requiresFreshAuthentication(error),
      }),
    );
  yield* Effect.forkScoped(
    Queue.take(reconnectRequests).pipe(
      Effect.flatMap(() =>
        authenticate("refresh-auth").pipe(
          Effect.flatMap(reconnect),
          Effect.retry({
            schedule: authenticationSchedule,
            while: requiresFreshAuthentication,
          }),
        ),
      ),
      Effect.ignore({
        log: "Warn",
        message: "Workflow Zero reconnect request failed after retries",
      }),
      Effect.forever,
    ),
  );

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      zero.connection.state.subscribe((state) =>
        shouldRefreshWorkflowZeroAuth(state)
          ? Queue.offerUnsafe(reconnectRequests, undefined)
          : false,
      ),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

  return zero;
});

class WorkflowZeroExecutor extends BaseZeroClient.ZeroClient<
  SheetZeroSchema,
  undefined,
  unknown
>() {
  static readonly layer = Layer.effect(
    WorkflowZeroExecutor,
    Effect.gen({ self: this }, function* () {
      const zero = yield* makeZero();
      return yield* this.make(zero);
    }),
  ).pipe(Layer.provide(SheetAuthClient.layer));
}

export class WorkflowZeroClient extends Context.Service<WorkflowZeroClient>()(
  "sheet-ingress-server/WorkflowZeroClient",
  {
    make: Effect.gen(function* () {
      const executor = yield* WorkflowZeroExecutor;
      const client = yield* makeSheetServiceClient(executor);
      return {
        enqueueAsCaller: (args: DelegatedWorkflowEnqueueRequest) =>
          client.execute(serviceApi.runs.enqueueAsCaller, args),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(WorkflowZeroClient, this.make).pipe(
    Layer.provide(WorkflowZeroExecutor.layer),
  );
}
