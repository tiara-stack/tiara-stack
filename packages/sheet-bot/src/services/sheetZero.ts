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
  Option,
  Predicate,
  Queue,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import {
  makeSheetClient,
  mutators,
  schema,
  type Schema as SheetZeroSchema,
  type SheetClient,
} from "sheet-zero-api";
import {
  ConfigWorkspaceRow,
  ConfigWorkspaceSheetRevisionRow,
  ConfigWorkspaceSheetRow,
} from "sheet-zero-api/rows";
import { ZeroClient as BaseZeroClient } from "typhoon-zero/client";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

const teamSubmissionFeatureFlag = "team-submission-confirmations";

type SheetZeroConnectionState = Zero<
  SheetZeroSchema,
  undefined,
  unknown
>["connection"]["state"]["current"];

class SheetZeroConnectionError extends Data.TaggedError("SheetZeroConnectionError")<{
  readonly state: SheetZeroConnectionState;
}> {}

interface SheetZeroAuthContext {
  readonly currentTokenExpiresAtEpochSeconds: number | undefined;
  readonly nowEpochSeconds: number;
}

const zeroApiServerStatus = (reason: string) => {
  const prefix = "Fetch from API server returned non-OK status ";
  if (!reason.startsWith(prefix)) {
    return undefined;
  }

  const status = Number(reason.slice(prefix.length));
  return Number.isInteger(status) ? status : undefined;
};

const isExpiredTokenRevalidation = (reason: string, context: SheetZeroAuthContext) =>
  zeroApiServerStatus(reason) === 500 &&
  context.currentTokenExpiresAtEpochSeconds !== undefined &&
  context.currentTokenExpiresAtEpochSeconds <= context.nowEpochSeconds;

export const shouldRefreshSheetZeroAuth = (
  state: SheetZeroConnectionState,
  context: SheetZeroAuthContext,
) =>
  Match.value(state).pipe(
    Match.when({ name: "needs-auth" }, () => true),
    Match.when({ name: "error" }, (current) => isExpiredTokenRevalidation(current.reason, context)),
    Match.orElse(() => false),
  );

const isSheetZeroConnectionError = (error: unknown): error is SheetZeroConnectionError =>
  Predicate.isTagged("SheetZeroConnectionError")(error);

// Keep authentication and reconnect behavior aligned with the other runtime Zero clients.
// fallow-ignore-next-line code-duplication
const makeGetAuth = Effect.fn("SheetZeroClient.makeGetAuth")(function* () {
  const sheetAuthClient = yield* SheetAuthClient;
  const clientId = yield* config.sheetAuthOAuthClientId;
  const clientSecret = yield* config.sheetAuthOAuthClientSecret;
  const resource = yield* config.zeroOAuthAudience;
  let currentTokenExpiresAtEpochSeconds: number | undefined;
  const cache = yield* Cache.makeWith(
    Effect.fn("SheetZeroClient.getOAuthToken")(() =>
      createOAuthClientCredentialsToken(sheetAuthClient, {
        clientId,
        clientSecret,
        resource,
        scope: ["service"],
      }).pipe(
        Effect.map((token) => {
          currentTokenExpiresAtEpochSeconds = token.expiresAt;
          return {
            accessToken: token.accessToken,
            timeToLive: Duration.max(
              Duration.seconds(token.expiresAt - Math.floor(Date.now() / 1000) - 60),
              Duration.zero,
            ),
          };
        }),
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
    getAuth: Effect.fn("SheetZeroClient.getAuth")(function* () {
      return readAccessToken(yield* Cache.get(cache, resource));
    }),
    refreshAuth: Effect.fn("SheetZeroClient.refreshAuth")(function* () {
      return readAccessToken(yield* Cache.refresh(cache, resource));
    }),
    currentAuthContext: (): SheetZeroAuthContext => ({
      currentTokenExpiresAtEpochSeconds,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    }),
  };
});

type AuthenticationRequest = "get-auth" | "refresh-auth";

const authenticationSchedule = Schedule.exponential(Duration.millis(250)).pipe(
  Schedule.modifyDelay((_output, delay) =>
    Effect.succeed(Duration.min(delay, Duration.seconds(30))),
  ),
);

// Keep authentication and reconnect behavior aligned with the other runtime Zero clients.
// fallow-ignore-next-line code-duplication
const makeSheetZero = Effect.fn("SheetZeroClient.makeZero")(function* () {
  const { currentAuthContext, getAuth, refreshAuth } = yield* makeGetAuth();
  const server = yield* config.zeroCacheServer;
  const userID = yield* config.zeroCacheUserId;

  const requiresFreshAuthentication = (error: unknown) =>
    isSheetZeroConnectionError(error) &&
    shouldRefreshSheetZeroAuth(error.state, currentAuthContext());

  const authenticate = (request: AuthenticationRequest) =>
    Match.value(request).pipe(
      Match.when("get-auth", () => getAuth()),
      Match.when("refresh-auth", () => refreshAuth()),
      Match.exhaustive,
      Effect.timeout(Duration.seconds(30)),
      Effect.tapError((error) =>
        Effect.logWarning("Failed to authenticate the sheet-bot Zero client; retrying").pipe(
          Effect.annotateLogs({ error, request }),
        ),
      ),
      Effect.retry({ schedule: authenticationSchedule }),
    );

  const initialAuth = yield* authenticate("get-auth");
  const zero = new Zero({ server, userID, schema, mutators, auth: initialAuth });
  yield* Effect.addFinalizer(() => Effect.sync(() => zero.close()));

  const reconnectRequests = yield* Queue.sliding<void>(1);
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
        Effect.logWarning("Failed to reauthenticate the sheet-bot Zero client; retrying").pipe(
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
        message: "Sheet-bot Zero reconnect request failed after retries",
      }),
      Effect.forever,
    ),
  );

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      zero.connection.state.subscribe((state) =>
        shouldRefreshSheetZeroAuth(state, currentAuthContext())
          ? Queue.offerUnsafe(reconnectRequests, undefined)
          : false,
      ),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

  return zero;
});

class SheetZeroExecutor extends BaseZeroClient.ZeroClient<SheetZeroSchema, undefined, unknown>() {
  static readonly layer = Layer.effect(
    SheetZeroExecutor,
    Effect.gen({ self: this }, function* () {
      const zero = yield* makeSheetZero();
      return yield* this.make(zero);
    }),
  ).pipe(Layer.provide(SheetAuthClient.layer));
}

export const isTeamSubmissionAvailable = (channel: unknown, featureFlag: unknown) =>
  Option.isOption(channel) &&
  Option.isSome(channel) &&
  Option.isOption(featureFlag) &&
  Option.isSome(featureFlag);

const isTeamSubmissionEnabled = Effect.fn("SheetZeroClient.isTeamSubmissionEnabled")(function* (
  client: SheetClient,
  workspaceId: string,
  conversationId: string,
) {
  const [channel, featureFlag] = yield* Effect.all(
    [
      client.grouped.workspaceConfig.getTeamSubmissionChannelByConversationId({
        workspaceId,
        conversationId,
      }),
      client.grouped.workspaceConfig.getWorkspaceFeatureFlag({
        workspaceId,
        flagName: teamSubmissionFeatureFlag,
      }),
    ] as const,
    { concurrency: "unbounded" },
  );
  return isTeamSubmissionAvailable(channel, featureFlag);
});

const decodeClientOption = <A>(schema: Schema.Decoder<A, never>, value: unknown) =>
  Option.isOption(value)
    ? Option.isNone(value)
      ? Effect.succeed(Option.none<A>())
      : Schema.decodeUnknownEffect(schema)(value.value).pipe(Effect.map(Option.some))
    : Predicate.isNull(value) || Predicate.isUndefined(value)
      ? Effect.succeed(Option.none<A>())
      : Schema.decodeUnknownEffect(schema)(value).pipe(Effect.map(Option.some));

const getSheetConfiguration = Effect.fn("SheetZeroClient.getSheetConfiguration")(function* (
  client: SheetClient,
  workspaceId: string,
) {
  const rawRow = yield* client.grouped.sheetConfiguration.getSheetConfiguration({ workspaceId });
  return yield* decodeClientOption(ConfigWorkspaceSheetRow, rawRow);
});

const getSheetConfigurationRevisions = Effect.fn("SheetZeroClient.getSheetConfigurationRevisions")(
  function* (client: SheetClient, workspaceId: string) {
    const rawRows = yield* client.grouped.sheetConfiguration.getSheetConfigurationRevisions({
      workspaceId,
    });
    return yield* Schema.decodeUnknownEffect(Schema.Array(ConfigWorkspaceSheetRevisionRow))(
      rawRows,
    );
  },
);

const getWorkspaceConfig = Effect.fn("SheetZeroClient.getWorkspaceConfig")(function* (
  client: SheetClient,
  workspaceId: string,
) {
  const rawRow = yield* client.grouped.workspaceConfig.getWorkspaceConfigByWorkspaceId({
    workspaceId,
  });
  return yield* decodeClientOption(ConfigWorkspaceRow, rawRow);
});

interface SheetZeroClientShape {
  readonly isTeamSubmissionEnabled: (
    workspaceId: string,
    conversationId: string,
  ) => ReturnType<typeof isTeamSubmissionEnabled>;
  readonly getSheetConfiguration: (workspaceId: string) => ReturnType<typeof getSheetConfiguration>;
  readonly getSheetConfigurationRevisions: (
    workspaceId: string,
  ) => ReturnType<typeof getSheetConfigurationRevisions>;
  readonly getWorkspaceConfig: (workspaceId: string) => ReturnType<typeof getWorkspaceConfig>;
}

export class SheetZeroClient extends Context.Service<SheetZeroClient, SheetZeroClientShape>()(
  "sheet-bot/SheetZeroClient",
  {
    make: Effect.gen(function* () {
      const executor = yield* SheetZeroExecutor;
      const client = yield* makeSheetClient(executor);
      return {
        isTeamSubmissionEnabled: (workspaceId, conversationId) =>
          isTeamSubmissionEnabled(client, workspaceId, conversationId),
        getSheetConfiguration: (workspaceId) => getSheetConfiguration(client, workspaceId),
        getSheetConfigurationRevisions: (workspaceId) =>
          getSheetConfigurationRevisions(client, workspaceId),
        getWorkspaceConfig: (workspaceId) => getWorkspaceConfig(client, workspaceId),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(SheetZeroClient, this.make).pipe(
    Layer.provide(SheetZeroExecutor.layer),
  );
}
