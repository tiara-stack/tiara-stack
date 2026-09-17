import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  createOAuthClientCredentialsToken,
  getSheetAuthIdentity,
  type OAuthClientCredentialsTokenError,
  type OAuthSubjectTokenError,
  type OAuthTokenExchangeError,
  type SheetAuthIdentityError,
} from "sheet-auth/client";
import type { EffectivePrincipal as EffectivePrincipalType } from "sheet-auth/identity";
import {
  effectivePrincipalFromLegacyIdentity,
  ownerKeyForEffectivePrincipal,
  type ServicePrincipalGatewayIdentity,
} from "sheet-auth/identity/server";
import {
  makeAuthorizationLoadWorkspaceCapabilitiesZeroObserver,
  makeCheckinMessagesLoadZeroObserver,
  makeCheckinMessagesSaveZeroObserver,
  makeSheetClient,
  mutators,
  schema,
  type AuthorizationLoadWorkspaceCapabilitiesZeroObserver,
  type CheckinMessagesLoadZeroObserver,
  type CheckinMessagesSaveZeroObserver,
  type Schema as SheetZeroSchema,
  type SheetClient,
  workflowObservationUnavailable,
  workflowObservationUnauthorized,
} from "sheet-zero-api";
import {
  ConfigWorkspaceRow,
  ConfigWorkspaceConversationRow,
  ConfigWorkspaceSheetRevisionRow,
  ConfigWorkspaceSheetRow,
  MessageSlotRow,
} from "sheet-zero-api/rows";
import { ZeroClient as BaseZeroClient } from "typhoon-zero/client";
import { ScopedCache } from "typhoon-core/utils";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";
import { makeDiscordUserToken, workflowHttpAudience } from "./sheetWorkflowHttp";
import {
  makeResilientSheetZero,
  SheetZeroAuthorizationFailure,
  type SheetZeroAuthProvider,
  type SheetZeroAuthToken,
} from "./zeroObservation";

const teamSubmissionFeatureFlag = "team-submission-confirmations";

export { shouldReconnectSheetZero, shouldRefreshSheetZeroAuth } from "./zeroObservation";

// Keep authentication and reconnect behavior aligned with the other runtime Zero clients.
// fallow-ignore-next-line code-duplication
const makeGetAuth = Effect.fn("SheetZeroClient.makeGetAuth")(function* () {
  const sheetAuthClient = yield* SheetAuthClient;
  const clientId = yield* config.sheetAuthOAuthClientId;
  const clientSecret = yield* config.sheetAuthOAuthClientSecret;
  const resource = yield* config.zeroOAuthAudience;
  const cache = yield* Cache.makeWith(
    Effect.fn("SheetZeroClient.getOAuthToken")(() =>
      createOAuthClientCredentialsToken(sheetAuthClient, {
        clientId,
        clientSecret,
        resource,
        scope: ["service"],
      }).pipe(
        Effect.map((token) => ({
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
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

  return {
    getAuth: Effect.fn("SheetZeroClient.getAuth")(function* () {
      const token = yield* Cache.get(cache, resource);
      return {
        accessToken: Redacted.value(token.accessToken),
        expiresAtEpochSeconds: token.expiresAt,
      } satisfies SheetZeroAuthToken;
    }),
    refreshAuth: Effect.fn("SheetZeroClient.refreshAuth")(function* () {
      const token = yield* Cache.refresh(cache, resource);
      return {
        accessToken: Redacted.value(token.accessToken),
        expiresAtEpochSeconds: token.expiresAt,
      } satisfies SheetZeroAuthToken;
    }),
  };
});

const makeSheetZero = Effect.fn("SheetZeroClient.makeZero")(function* () {
  const { getAuth, refreshAuth } = yield* makeGetAuth();
  const server = yield* config.zeroCacheServer;
  const userID = yield* config.zeroCacheUserId;
  const connection = yield* makeResilientSheetZero({
    cacheURL: server,
    userID,
    schema,
    mutators,
    auth: { get: getAuth, refresh: refreshAuth } satisfies SheetZeroAuthProvider,
  });
  yield* connection.permanentAuthorizationFailure.pipe(
    Stream.runDrain,
    Effect.tapError((error) =>
      Effect.logError("Sheet-bot Zero authorization became permanently invalid").pipe(
        Effect.annotateLogs({ error }),
      ),
    ),
    Effect.forkScoped,
  );
  return connection.zero;
});

type CheckinMessagesLoadReference = Parameters<CheckinMessagesLoadZeroObserver["get"]>[0];
type CheckinMessagesLoadObservation = ReturnType<CheckinMessagesLoadZeroObserver["get"]>;
type CheckinMessagesSaveReference = Parameters<CheckinMessagesSaveZeroObserver["get"]>[0];
type CheckinMessagesSaveObservation = ReturnType<CheckinMessagesSaveZeroObserver["get"]>;
type AuthorizationLoadWorkspaceCapabilitiesReference = Parameters<
  AuthorizationLoadWorkspaceCapabilitiesZeroObserver["get"]
>[0];
type AuthorizationLoadWorkspaceCapabilitiesObservation = ReturnType<
  AuthorizationLoadWorkspaceCapabilitiesZeroObserver["get"]
>;

const SheetZeroObservationPrincipal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), discordUserId: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("service"), serviceId: Schema.NonEmptyString }),
]);
type SheetZeroObservationPrincipal = typeof SheetZeroObservationPrincipal.Type;
type SheetZeroObservationPrincipalInput = string | SheetZeroObservationPrincipal;

const canonicalObservationPrincipal = (principal: SheetZeroObservationPrincipal) =>
  Match.type<SheetZeroObservationPrincipal>().pipe(
    Match.discriminatorsExhaustive("kind")({
      user: ({ discordUserId }) => ({ kind: "user" as const, discordUserId }),
      service: ({ serviceId }) => ({ kind: "service" as const, serviceId }),
    }),
  )(principal);

const ObservationCacheKey = Schema.Struct({
  principal: SheetZeroObservationPrincipal,
  server: Schema.NonEmptyString,
  audience: Schema.NonEmptyString,
});

export const makeSheetZeroObservationCacheKey = (
  principal: SheetZeroObservationPrincipal,
  server: string,
  audience: string,
) =>
  JSON.stringify({
    principal: canonicalObservationPrincipal(principal),
    server,
    audience,
  });

export const makeSheetZeroObservationStorageKey = (
  ownerKey: string,
  server: string,
  audience: string,
) =>
  `sheet-bot:workflow-observation:${encodeURIComponent(JSON.stringify([ownerKey, server, audience]))}`;

interface ObservationAuthState {
  readonly token: SheetZeroAuthToken;
  readonly principal: EffectivePrincipalType;
  readonly userID: string;
  readonly ownerKey: string;
}

interface ObservationAuth extends SheetZeroAuthProvider {
  readonly principal: EffectivePrincipalType;
  readonly userID: string;
  readonly ownerKey: string;
}

const makeIdentityPreservingObservationAuth = (
  issue: () => Effect.Effect<ObservationAuthState, unknown>,
): Effect.Effect<ObservationAuth, unknown> =>
  Effect.gen(function* () {
    const issueWithAuthorizationErrors = () =>
      issue().pipe(Effect.mapError(toObservationAuthError));
    const initial = yield* issueWithAuthorizationErrors();
    let currentToken = initial.token;
    const validateRefresh = (next: ObservationAuthState) =>
      next.userID === initial.userID && next.ownerKey === initial.ownerKey
        ? Effect.succeed(next.token)
        : Effect.fail(
            new SheetZeroAuthorizationFailure({
              message: "Zero observation authentication changed principals",
            }),
          );

    return {
      principal: initial.principal,
      userID: initial.userID,
      ownerKey: initial.ownerKey,
      get: () => Effect.succeed(currentToken),
      refresh: () =>
        Effect.suspend(issueWithAuthorizationErrors).pipe(
          Effect.flatMap(validateRefresh),
          Effect.tap((token) =>
            Effect.sync(() => {
              currentToken = token;
            }),
          ),
        ),
    };
  });

const isSheetAuthAuthorizationError = (
  error: unknown,
): error is
  | OAuthClientCredentialsTokenError
  | OAuthSubjectTokenError
  | OAuthTokenExchangeError
  | SheetAuthIdentityError =>
  Predicate.isTagged("OAuthClientCredentialsTokenError")(error) ||
  Predicate.isTagged("OAuthSubjectTokenError")(error) ||
  Predicate.isTagged("OAuthTokenExchangeError")(error) ||
  Predicate.isTagged("SheetAuthIdentityError")(error);

const authorizationStatusText = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_GRANT",
  "INVALID_REQUEST",
  "INVALID_SCOPE",
  "INVALID_TARGET",
  "INSUFFICIENT_SCOPE",
  "ACCESS_DENIED",
]);
const authorizationCode = new Set([
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "invalid_target",
  "insufficient_scope",
  "access_denied",
]);
const authorizationStatus = new Set([400, 401, 403]);

const isPermanentSheetAuthRejection = (
  error:
    | OAuthClientCredentialsTokenError
    | OAuthSubjectTokenError
    | OAuthTokenExchangeError
    | SheetAuthIdentityError,
) => {
  const statusText = error.statusText.trim().toUpperCase();
  const code = error.code?.trim().toLowerCase();
  return (
    (error.status !== undefined && authorizationStatus.has(error.status)) ||
    authorizationStatusText.has(statusText) ||
    (code !== undefined && authorizationCode.has(code))
  );
};

const observationAuthFailure = (
  error:
    | OAuthClientCredentialsTokenError
    | OAuthSubjectTokenError
    | OAuthTokenExchangeError
    | SheetAuthIdentityError,
) => {
  const details = [error.status, error.statusText, error.code, error.message]
    .filter(
      (value): value is string | number => Predicate.isString(value) || Predicate.isNumber(value),
    )
    .join(": ");
  return new SheetZeroAuthorizationFailure({
    message: `Zero observation authorization was rejected${details.length === 0 ? "" : `: ${details}`}`,
  });
};

const toObservationAuthError = (error: unknown) => {
  if (Predicate.isTagged("SheetZeroAuthorizationFailure")(error)) return error;
  if (!isSheetAuthAuthorizationError(error)) return error;
  return isPermanentSheetAuthRejection(error) ? observationAuthFailure(error) : error;
};

const makeUserObservationAuth = (options: {
  readonly sheetAuthClient: typeof SheetAuthClient.Service;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly subjectTokenKubernetesTokenPath: string;
  readonly audience: string;
  readonly discordUserId: string;
}): Effect.Effect<ObservationAuth, unknown> => {
  const issue = () =>
    Effect.gen(function* () {
      const actorToken = yield* createOAuthClientCredentialsToken(options.sheetAuthClient, {
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        resource: workflowHttpAudience,
        scope: ["service", "token.exchange", "workflow.observe"],
      });
      const userToken = yield* makeDiscordUserToken({
        accessToken: actorToken.accessToken,
        audience: options.audience,
        discordUserId: options.discordUserId,
        kubernetesServiceAccountTokenPath: options.subjectTokenKubernetesTokenPath,
        sheetAuthClient: options.sheetAuthClient,
        scope: ["workflow.observe"],
      });
      const identity = yield* getSheetAuthIdentity(options.sheetAuthClient, {
        Authorization: `Bearer ${Redacted.value(userToken.accessToken)}`,
      });
      if (
        identity.permissions.includes("service") ||
        identity.accountId !== options.discordUserId ||
        !identity.scopes.includes("workflow.observe")
      ) {
        return yield* Effect.fail(
          new SheetZeroAuthorizationFailure({
            message: "Zero observation authentication does not match the user principal",
          }),
        );
      }

      const principal = yield* Effect.try({
        try: () => effectivePrincipalFromLegacyIdentity(identity),
        catch: () =>
          new SheetZeroAuthorizationFailure({
            message: "Zero observation user identity is invalid",
          }),
      });
      if (
        principal.kind !== "user" ||
        principal.discordAccount?.accountId !== options.discordUserId
      ) {
        return yield* Effect.fail(
          new SheetZeroAuthorizationFailure({
            message: "Zero observation authentication does not match the user principal",
          }),
        );
      }

      return {
        token: {
          accessToken: Redacted.value(userToken.accessToken),
          expiresAtEpochSeconds: userToken.expiresAt,
        },
        principal,
        userID: options.discordUserId,
        ownerKey: ownerKeyForEffectivePrincipal(principal),
      } satisfies ObservationAuthState;
    });

  return makeIdentityPreservingObservationAuth(issue);
};

const makeServiceObservationAuth = (options: {
  readonly sheetAuthClient: typeof SheetAuthClient.Service;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly audience: string;
  readonly serviceId: string;
}): Effect.Effect<ObservationAuth, unknown> => {
  const gatewayIdentity: ServicePrincipalGatewayIdentity = {
    serviceId: options.serviceId,
    oauthClientId: options.clientId,
  };
  const issue = () =>
    Effect.gen(function* () {
      const serviceToken = yield* createOAuthClientCredentialsToken(options.sheetAuthClient, {
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        resource: options.audience,
        scope: ["service", "workflow.observe"],
      });
      const identity = yield* getSheetAuthIdentity(options.sheetAuthClient, {
        Authorization: `Bearer ${Redacted.value(serviceToken.accessToken)}`,
      });
      if (
        !identity.permissions.includes("service") ||
        identity.clientId !== options.clientId ||
        !identity.scopes.includes("workflow.observe")
      ) {
        return yield* Effect.fail(
          new SheetZeroAuthorizationFailure({
            message: "Zero observation authentication does not match the service principal",
          }),
        );
      }

      const principal = yield* Effect.try({
        try: () => effectivePrincipalFromLegacyIdentity(identity, gatewayIdentity),
        catch: () =>
          new SheetZeroAuthorizationFailure({
            message: "Zero observation service identity is invalid",
          }),
      });
      if (principal.kind !== "service" || principal.serviceId !== options.serviceId) {
        return yield* Effect.fail(
          new SheetZeroAuthorizationFailure({
            message: "Zero observation authentication does not match the service principal",
          }),
        );
      }

      return {
        token: {
          accessToken: Redacted.value(serviceToken.accessToken),
          expiresAtEpochSeconds: serviceToken.expiresAt,
        },
        principal,
        userID: principal.serviceId,
        ownerKey: ownerKeyForEffectivePrincipal(principal),
      } satisfies ObservationAuthState;
    });

  return makeIdentityPreservingObservationAuth(issue);
};

interface ObservationConnection {
  readonly checkinMessagesLoadObserver: CheckinMessagesLoadZeroObserver;
  readonly checkinMessagesSaveObserver: CheckinMessagesSaveZeroObserver;
  readonly authorizationLoadWorkspaceCapabilitiesObserver: AuthorizationLoadWorkspaceCapabilitiesZeroObserver;
  readonly permanentAuthorizationFailure: Stream.Stream<never, unknown>;
}

type ObservationConnectionCache = ScopedCache.ScopedCache<
  string,
  ObservationConnection,
  unknown,
  never
>;

const makeObservationConnectionCache = (options: {
  readonly sheetAuthClient: typeof SheetAuthClient.Service;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly subjectTokenKubernetesTokenPath: string;
  readonly gatewayServiceId: string;
}) =>
  ScopedCache.make<string, ObservationConnection, unknown, never>({
    lookup: (key) =>
      Effect.gen(function* () {
        const lookupKey = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(ObservationCacheKey)(JSON.parse(key)),
          catch: () => new Error("Invalid Zero observation cache key"),
        });
        const auth = yield* Match.value(lookupKey.principal).pipe(
          Match.when({ kind: "user" }, ({ discordUserId }) =>
            makeUserObservationAuth({
              sheetAuthClient: options.sheetAuthClient,
              clientId: options.clientId,
              clientSecret: options.clientSecret,
              subjectTokenKubernetesTokenPath: options.subjectTokenKubernetesTokenPath,
              audience: lookupKey.audience,
              discordUserId,
            }),
          ),
          Match.when({ kind: "service" }, ({ serviceId }) =>
            serviceId !== options.gatewayServiceId
              ? Effect.fail(
                  new SheetZeroAuthorizationFailure({
                    message: "Zero observation service principal is not supported by this client",
                  }),
                )
              : makeServiceObservationAuth({
                  sheetAuthClient: options.sheetAuthClient,
                  clientId: options.clientId,
                  clientSecret: options.clientSecret,
                  audience: lookupKey.audience,
                  serviceId,
                }),
          ),
          Match.exhaustive,
        );
        const resilient = yield* makeResilientSheetZero({
          cacheURL: lookupKey.server,
          userID: auth.userID,
          storageKey: makeSheetZeroObservationStorageKey(
            auth.ownerKey,
            lookupKey.server,
            lookupKey.audience,
          ),
          schema,
          context: { ownerKey: auth.ownerKey },
          auth,
        });
        const executor = yield* BaseZeroClient.ZeroClient<
          SheetZeroSchema,
          undefined,
          { readonly ownerKey: string }
        >().make(resilient.zero);
        const observers = yield* Effect.all({
          checkinMessagesLoadObserver: makeCheckinMessagesLoadZeroObserver(executor),
          checkinMessagesSaveObserver: makeCheckinMessagesSaveZeroObserver(executor),
          authorizationLoadWorkspaceCapabilitiesObserver:
            makeAuthorizationLoadWorkspaceCapabilitiesZeroObserver(executor),
        });
        return {
          ...observers,
          permanentAuthorizationFailure: resilient.permanentAuthorizationFailure,
        };
      }),
  });

const observationPrincipalFromInput = (input: SheetZeroObservationPrincipalInput) =>
  Schema.decodeUnknownOption(SheetZeroObservationPrincipal)(
    Match.value(input).pipe(
      Match.when(Predicate.isString, (discordUserId) => ({ kind: "user", discordUserId })),
      Match.orElse((principal) => principal),
    ),
  );

const observationError = (error: unknown) =>
  Predicate.isTagged("SheetZeroAuthorizationFailure")(error)
    ? workflowObservationUnauthorized()
    : workflowObservationUnavailable();

const observeWorkflow = <Value>(
  observationConnections: ObservationConnectionCache,
  server: string,
  audience: string,
  principalInput: SheetZeroObservationPrincipalInput,
  get: (connection: ObservationConnection) => Stream.Stream<Value, unknown>,
) =>
  Option.match(observationPrincipalFromInput(principalInput), {
    onNone: () => Stream.fail(workflowObservationUnavailable()),
    onSome: (principal) =>
      Stream.scoped(
        Stream.unwrap(
          observationConnections
            .get(makeSheetZeroObservationCacheKey(principal, server, audience))
            .pipe(
              Effect.map((connection) =>
                Stream.merge(
                  get(connection).pipe(Stream.mapError(observationError)),
                  connection.permanentAuthorizationFailure.pipe(
                    Stream.mapError(() => workflowObservationUnauthorized()),
                  ),
                  { haltStrategy: "left" },
                ),
              ),
              Effect.mapError(observationError),
            ),
        ),
      ),
  });

const observeCheckinMessagesLoad = (
  observationConnections: ObservationConnectionCache,
  server: string,
  audience: string,
  principalInput: SheetZeroObservationPrincipalInput,
  reference: CheckinMessagesLoadReference,
): CheckinMessagesLoadObservation =>
  observeWorkflow(observationConnections, server, audience, principalInput, (connection) =>
    connection.checkinMessagesLoadObserver.get(reference),
  );

const observeCheckinMessagesSave = (
  observationConnections: ObservationConnectionCache,
  server: string,
  audience: string,
  principalInput: SheetZeroObservationPrincipalInput,
  reference: CheckinMessagesSaveReference,
): CheckinMessagesSaveObservation =>
  observeWorkflow(observationConnections, server, audience, principalInput, (connection) =>
    connection.checkinMessagesSaveObserver.get(reference),
  );

const observeAuthorizationLoadWorkspaceCapabilities = (
  observationConnections: ObservationConnectionCache,
  server: string,
  audience: string,
  principalInput: SheetZeroObservationPrincipalInput,
  reference: AuthorizationLoadWorkspaceCapabilitiesReference,
): AuthorizationLoadWorkspaceCapabilitiesObservation =>
  observeWorkflow(observationConnections, server, audience, principalInput, (connection) =>
    connection.authorizationLoadWorkspaceCapabilitiesObserver.get(reference),
  );

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

const getWorkspaceConversations = Effect.fn("SheetZeroClient.getWorkspaceConversations")(function* (
  client: SheetClient,
  workspaceId: string,
) {
  const rawRows = yield* client.grouped.workspaceConfig.getWorkspaceConversations({ workspaceId });
  return yield* Schema.decodeUnknownEffect(Schema.Array(ConfigWorkspaceConversationRow))(rawRows);
});

const getSlotButtonByConversation = Effect.fn("SheetZeroClient.getSlotButtonByConversation")(
  function* (client: SheetClient, clientId: string, workspaceId: string, conversationId: string) {
    const rawRow = yield* client.grouped.messageSlot.getMessageSlotDataByConversation({
      clientPlatform: "discord",
      clientId,
      workspaceId,
      conversationId,
    });
    return yield* decodeClientOption(MessageSlotRow, rawRow);
  },
);

interface SheetZeroClientShape {
  readonly observeCheckinMessagesLoad: (
    principal: SheetZeroObservationPrincipalInput,
    reference: CheckinMessagesLoadReference,
  ) => CheckinMessagesLoadObservation;
  readonly observeCheckinMessagesSave: (
    principal: SheetZeroObservationPrincipalInput,
    reference: CheckinMessagesSaveReference,
  ) => CheckinMessagesSaveObservation;
  readonly observeAuthorizationLoadWorkspaceCapabilities: (
    principal: SheetZeroObservationPrincipalInput,
    reference: AuthorizationLoadWorkspaceCapabilitiesReference,
  ) => AuthorizationLoadWorkspaceCapabilitiesObservation;
  readonly observeServiceCheckinMessagesLoad: (
    reference: CheckinMessagesLoadReference,
  ) => CheckinMessagesLoadObservation;
  readonly isTeamSubmissionEnabled: (
    workspaceId: string,
    conversationId: string,
  ) => ReturnType<typeof isTeamSubmissionEnabled>;
  readonly getSheetConfiguration: (workspaceId: string) => ReturnType<typeof getSheetConfiguration>;
  readonly getSheetConfigurationRevisions: (
    workspaceId: string,
  ) => ReturnType<typeof getSheetConfigurationRevisions>;
  readonly getWorkspaceConfig: (workspaceId: string) => ReturnType<typeof getWorkspaceConfig>;
  readonly getWorkspaceConversations: (
    workspaceId: string,
  ) => ReturnType<typeof getWorkspaceConversations>;
  readonly getSlotButtonByConversation: (
    workspaceId: string,
    conversationId: string,
  ) => ReturnType<typeof getSlotButtonByConversation>;
}

export class SheetZeroClient extends Context.Service<SheetZeroClient, SheetZeroClientShape>()(
  "sheet-bot/SheetZeroClient",
  {
    make: Effect.gen(function* () {
      const sheetAuthClient = yield* SheetAuthClient;
      const executor = yield* SheetZeroExecutor;
      const client = yield* makeSheetClient(executor);
      const clientId = yield* config.sheetBotClientId;
      const observationConfig = yield* Effect.all({
        server: config.zeroCacheServer,
        audience: config.zeroOAuthAudience,
        authClientId: config.sheetAuthOAuthClientId,
        authClientSecret: config.sheetAuthOAuthClientSecret,
        subjectTokenKubernetesTokenPath: config.sheetAuthSubjectTokenKubernetesTokenPath,
        gatewayServiceId: config.sheetBotGatewayServiceId,
      });
      const observationConnections = yield* makeObservationConnectionCache({
        sheetAuthClient,
        clientId: observationConfig.authClientId,
        clientSecret: observationConfig.authClientSecret,
        subjectTokenKubernetesTokenPath: observationConfig.subjectTokenKubernetesTokenPath,
        gatewayServiceId: observationConfig.gatewayServiceId,
      });
      return {
        observeCheckinMessagesLoad: (principal, reference) =>
          observeCheckinMessagesLoad(
            observationConnections,
            observationConfig.server,
            observationConfig.audience,
            principal,
            reference,
          ),
        observeCheckinMessagesSave: (principal, reference) =>
          observeCheckinMessagesSave(
            observationConnections,
            observationConfig.server,
            observationConfig.audience,
            principal,
            reference,
          ),
        observeAuthorizationLoadWorkspaceCapabilities: (principal, reference) =>
          observeAuthorizationLoadWorkspaceCapabilities(
            observationConnections,
            observationConfig.server,
            observationConfig.audience,
            principal,
            reference,
          ),
        observeServiceCheckinMessagesLoad: (reference) =>
          observeCheckinMessagesLoad(
            observationConnections,
            observationConfig.server,
            observationConfig.audience,
            { kind: "service", serviceId: observationConfig.gatewayServiceId },
            reference,
          ),
        isTeamSubmissionEnabled: (workspaceId, conversationId) =>
          isTeamSubmissionEnabled(client, workspaceId, conversationId),
        getSheetConfiguration: (workspaceId) => getSheetConfiguration(client, workspaceId),
        getSheetConfigurationRevisions: (workspaceId) =>
          getSheetConfigurationRevisions(client, workspaceId),
        getWorkspaceConfig: (workspaceId) => getWorkspaceConfig(client, workspaceId),
        getWorkspaceConversations: (workspaceId) => getWorkspaceConversations(client, workspaceId),
        getSlotButtonByConversation: (workspaceId, conversationId) =>
          getSlotButtonByConversation(client, clientId, workspaceId, conversationId),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(SheetZeroClient, this.make).pipe(
    Layer.provide(SheetZeroExecutor.layer),
    Layer.provide(SheetAuthClient.layer),
  );
}
