import { NodeFileSystem, NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { createServer } from "http";
import { Effect, Layer, Logger, Option } from "effect";
import { HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import {
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSwagger,
} from "effect/unstable/httpapi";
import { Api } from "sheet-ingress-api/api";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "typhoon-core/error";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { ArgumentError, makeArgumentError } from "typhoon-core/error";
import { config } from "./config";
import {
  AuthorizationService,
  hasDiscordAccountPermission,
  hasGuildPermission,
  hasPermission,
  SheetAuthTokenAuthorizationLive,
} from "./services/authorization";
import { SheetAuthUserResolver } from "./services/authResolver";
import { MessageLookup } from "./services/messageLookup";
import { SheetApisForwardingClient } from "./services/sheetApisForwardingClient";
import { SheetApisRpcTokens } from "./services/sheetApisRpcTokens";
import { SheetBotForwardingClient } from "./services/sheetBotForwardingClient";
import { clientArgsFrom, forwardSheetBot, forwardSheetBotPayload } from "./services/sheetBotProxy";
import { TelemetryLive } from "./telemetry";
import {
  SheetApisAnonymousUserFallbackLive,
  SheetApisServiceUserFallbackLive,
  SheetBotServiceAuthorizationLive,
} from "./middlewares/proxyAuthorization";

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((allowed) => {
    if (allowed === origin) {
      return true;
    }
    if (allowed.includes("*")) {
      const withPlaceholder = allowed.replace(/\*/g, "\x00");
      const escaped = withPlaceholder.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      // eslint-disable-next-line no-control-regex
      const regex = new RegExp(`^${escaped.replace(/\x00/g, "[^./]*")}$`);
      return regex.test(origin);
    }
    return false;
  });
}

const getModernMessageGuildId = <
  T extends {
    readonly guildId: Option.Option<string>;
    readonly messageChannelId: Option.Option<string>;
  },
>(
  record: T,
) =>
  Option.match(record.guildId, {
    onSome: (guildId) =>
      Option.isSome(record.messageChannelId) ? Option.some(guildId) : Option.none(),
    onNone: () => Option.none(),
  });

const missingMessage = (kind: string) =>
  makeArgumentError(`Cannot get ${kind}, the message might not be registered`);

const legacyDenied = (kind: string) =>
  Effect.fail(new Unauthorized({ message: `Legacy ${kind} records are no longer accessible` }));

const authorizationArgumentError = (kind: string) => (cause: unknown) =>
  cause instanceof Unauthorized || cause instanceof ArgumentError
    ? cause
    : makeArgumentError(`Cannot authorize ${kind}`, cause);

const authorizationUnauthorized = (kind: string) => (cause: unknown) =>
  cause instanceof Unauthorized
    ? cause
    : new Unauthorized({ message: `Cannot authorize ${kind}`, cause });

const getRequiredModernGuildId = <T extends Parameters<typeof getModernMessageGuildId>[0]>(
  record: T,
  kind: string,
) =>
  Option.match(getModernMessageGuildId(record), {
    onSome: Effect.succeed,
    onNone: () => legacyDenied(kind),
  });

const corsMiddlewareLayer = Layer.unwrap(
  Effect.gen(function* () {
    const trustedOrigins = [...(yield* config.trustedOrigins)];
    return HttpRouter.middleware(
      HttpMiddleware.cors({
        allowedOrigins: (origin) => isOriginAllowed(origin, trustedOrigins),
        allowedHeaders: ["Content-Type", "Authorization", "b3", "traceparent", "tracestate"],
        allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
        exposedHeaders: ["Content-Length"],
        maxAge: 600,
        credentials: true,
      }),
      { global: true },
    );
  }),
);

type SheetIngressGroups = (typeof Api)["groups"][keyof (typeof Api)["groups"]];
type SheetApisForwardingClientService = typeof SheetApisForwardingClient.Service;
type SheetApisGroupName = Extract<
  keyof SheetApisForwardingClientService,
  HttpApiGroup.Name<SheetIngressGroups>
>;
type SheetApisGroup<GroupName extends SheetApisGroupName> = HttpApiGroup.WithName<
  SheetIngressGroups,
  GroupName
>;
type SheetApisEndpointName<GroupName extends SheetApisGroupName> = Extract<
  HttpApiEndpoint.Name<HttpApiGroup.Endpoints<SheetApisGroup<GroupName>>>,
  keyof SheetApisForwardingClientService[GroupName] & string
>;
type SheetApisEndpoint<GroupName extends SheetApisGroupName> = HttpApiGroup.Endpoints<
  SheetApisGroup<GroupName>
>;
type SheetApisProxyRequest<
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
> = HttpApiEndpoint.Request<HttpApiEndpoint.WithName<SheetApisEndpoint<GroupName>, EndpointName>>;
type SheetApisProxyError<
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
> = HttpApiEndpoint.ErrorsWithName<SheetApisEndpoint<GroupName>, EndpointName>;
type SheetApisProxyHandler<
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
  R,
> = HttpApiEndpoint.HandlerWithName<
  SheetApisEndpoint<GroupName>,
  EndpointName,
  SheetApisProxyError<GroupName, EndpointName>,
  SheetApisForwardingClient | R
>;
type SheetApisEndpointClient = (args: unknown) => Effect.Effect<unknown, unknown, unknown>;

const forwardSheetApis =
  <GroupName extends SheetApisGroupName, EndpointName extends SheetApisEndpointName<GroupName>>(
    group: GroupName,
    endpoint: EndpointName,
  ): SheetApisProxyHandler<GroupName, EndpointName, never> =>
  (rawArgs) =>
    Effect.gen(function* () {
      const args = rawArgs as SheetApisProxyRequest<GroupName, EndpointName>;
      const client = yield* SheetApisForwardingClient;
      const groupClient = client[group] as unknown as Record<string, SheetApisEndpointClient>;
      const endpointClient = groupClient?.[endpoint];
      if (typeof endpointClient !== "function") {
        return yield* Effect.die(
          new Error(`Unknown sheet-apis proxy target: ${group}.${endpoint}`),
        );
      }
      return yield* endpointClient.call(groupClient, clientArgsFrom(args));
    }) as ReturnType<SheetApisProxyHandler<GroupName, EndpointName, never>>;

const authorizedSheetApis =
  <GroupName extends SheetApisGroupName, EndpointName extends SheetApisEndpointName<GroupName>, R>(
    group: GroupName,
    endpoint: EndpointName,
    authorize: (
      args: SheetApisProxyRequest<GroupName, EndpointName>,
    ) => Effect.Effect<void, SheetApisProxyError<GroupName, EndpointName>, R>,
  ): SheetApisProxyHandler<GroupName, EndpointName, R> =>
  (rawArgs) =>
    Effect.gen(function* () {
      const args = rawArgs as SheetApisProxyRequest<GroupName, EndpointName>;
      yield* authorize(args);
      return yield* forwardSheetApis(group, endpoint)(rawArgs as never);
    }) as ReturnType<SheetApisProxyHandler<GroupName, EndpointName, R>>;

const requireService = () =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    yield* authorization.requireService();
  });

const requireNonService = () =>
  Effect.gen(function* () {
    const user = yield* SheetAuthUser;
    if (hasPermission(user.permissions, "service")) {
      return yield* Effect.fail(
        new Unauthorized({ message: "Service users cannot call Discord user endpoints" }),
      );
    }
  });

const requireGuild = (scope: "member" | "monitor" | "manage", guildId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    if (scope === "member") {
      yield* authorization.requireGuildMember(guildId);
    } else if (scope === "monitor") {
      yield* authorization.requireMonitorGuild(guildId);
    } else {
      yield* authorization.requireManageGuild(guildId);
    }
  });

const requireSelfOrMonitor = (guildId: string, accountId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    yield* authorization.requireDiscordAccountIdOrMonitorGuild(guildId, accountId);
  });

const asSheetApisProxyAuthorization = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
  R,
>(
  effect: Effect.Effect<void, unknown, R>,
) => effect as Effect.Effect<void, SheetApisProxyError<GroupName, EndpointName>, R>;

const serviceOnly = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
>(
  group: GroupName,
  endpoint: EndpointName,
) =>
  authorizedSheetApis(group, endpoint, () =>
    asSheetApisProxyAuthorization<GroupName, EndpointName, AuthorizationService | SheetAuthUser>(
      requireService(),
    ),
  );

const guildQuery = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
>(
  group: GroupName,
  endpoint: EndpointName,
  scope: "member" | "monitor" | "manage",
  selectGuildId: (
    query: SheetApisProxyRequest<GroupName, EndpointName> extends { readonly query: infer Query }
      ? Query
      : never,
  ) => string,
) =>
  authorizedSheetApis(group, endpoint, (args) =>
    asSheetApisProxyAuthorization<GroupName, EndpointName, AuthorizationService | SheetAuthUser>(
      requireGuild(
        scope,
        selectGuildId(
          (
            args as {
              readonly query: SheetApisProxyRequest<GroupName, EndpointName> extends {
                readonly query: infer Query;
              }
                ? Query
                : never;
            }
          ).query,
        ),
      ),
    ),
  );

const guildPayload = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
>(
  group: GroupName,
  endpoint: EndpointName,
  scope: "member" | "monitor" | "manage",
  selectGuildId: (
    payload: SheetApisProxyRequest<GroupName, EndpointName> extends {
      readonly payload: infer Payload;
    }
      ? Payload
      : never,
  ) => string,
) =>
  authorizedSheetApis(group, endpoint, (args) =>
    asSheetApisProxyAuthorization<GroupName, EndpointName, AuthorizationService | SheetAuthUser>(
      requireGuild(
        scope,
        selectGuildId(
          (
            args as {
              readonly payload: SheetApisProxyRequest<GroupName, EndpointName> extends {
                readonly payload: infer Payload;
              }
                ? Payload
                : never;
            }
          ).payload,
        ),
      ),
    ),
  );

const singlePlayerOrMonitor = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
>(
  group: GroupName,
  endpoint: EndpointName,
  select: (
    query: SheetApisProxyRequest<GroupName, EndpointName> extends { readonly query: infer Query }
      ? Query
      : never,
  ) => {
    readonly guildId: string;
    readonly ids: ReadonlyArray<string>;
  },
) =>
  authorizedSheetApis(group, endpoint, (args) => {
    const { guildId, ids } = select(
      (
        args as {
          readonly query: SheetApisProxyRequest<GroupName, EndpointName> extends {
            readonly query: infer Query;
          }
            ? Query
            : never;
        }
      ).query,
    );
    return asSheetApisProxyAuthorization<
      GroupName,
      EndpointName,
      AuthorizationService | SheetAuthUser
    >(ids.length === 1 ? requireSelfOrMonitor(guildId, ids[0]) : requireGuild("monitor", guildId));
  });

const requireMessageSlotRead = (messageId: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageSlotData(messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage("message slot data"));
    }
    const guildId = yield* getRequiredModernGuildId(record.value, "message slot");
    yield* requireGuild("member", guildId);
  }).pipe(Effect.mapError(authorizationArgumentError("message slot")));

const requireMessageSlotUpsert = (messageId: string, guildId?: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const existing = yield* messages.getMessageSlotData(messageId);
    const resolvedGuildId = Option.isSome(existing)
      ? yield* getRequiredModernGuildId(existing.value, "message slot")
      : typeof guildId === "string"
        ? guildId
        : yield* legacyDenied("message slot");
    yield* requireGuild("monitor", resolvedGuildId);
  }).pipe(Effect.mapError(authorizationUnauthorized("message slot")));

const requireRoomOrderMonitor = (messageId: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageRoomOrder(messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage("message room order"));
    }
    const guildId = yield* getRequiredModernGuildId(record.value, "message room order");
    yield* requireGuild("monitor", guildId);
  }).pipe(Effect.mapError(authorizationArgumentError("message room order")));

const requireRoomOrderButton = (payload: {
  readonly action: string;
  readonly guildId: string;
  readonly messageId: string;
}) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageRoomOrder(payload.messageId);
    if (Option.isSome(record)) {
      const guildId = yield* getRequiredModernGuildId(record.value, "message room order");
      yield* requireGuild("monitor", guildId);
      return;
    }
    if (payload.action !== "pinTentative") {
      return yield* Effect.fail(missingMessage("message room order"));
    }
    yield* requireGuild("monitor", payload.guildId);
  }).pipe(Effect.mapError(authorizationArgumentError("message room order")));

const requireRoomOrderUpsert = (messageId: string, guildId?: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const existing = yield* messages.getMessageRoomOrder(messageId);
    const resolvedGuildId = Option.isSome(existing)
      ? yield* getRequiredModernGuildId(existing.value, "message room order")
      : typeof guildId === "string"
        ? guildId
        : yield* legacyDenied("message room order");
    yield* requireGuild("monitor", resolvedGuildId);
  }).pipe(Effect.mapError(authorizationUnauthorized("message room order")));

const requireMessageCheckinRead = (messageId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    const messages = yield* MessageLookup;
    const user = yield* SheetAuthUser;
    const record = yield* messages.getMessageCheckinData(messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage("message checkin data"));
    }
    const guildId = yield* getRequiredModernGuildId(record.value, "message check-in");
    const accessLevel = yield* authorization.getCurrentGuildMonitorAccessLevel(guildId);
    if (accessLevel === "monitor") {
      return;
    }
    if (accessLevel !== "member") {
      return yield* Effect.fail(
        new Unauthorized({ message: "User is not a member of this guild" }),
      );
    }
    const members = yield* messages.getMessageCheckinMembers(messageId);
    if (!members.some((member) => member.memberId === user.accountId)) {
      return yield* Effect.fail(
        new Unauthorized({
          message: "User is not a recorded participant on this check-in message",
        }),
      );
    }
  }).pipe(Effect.mapError(authorizationArgumentError("message check-in")));

const getAuthorizedMessageCheckinMembers = (messageId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    const messages = yield* MessageLookup;
    const user = yield* SheetAuthUser;
    const record = yield* messages.getMessageCheckinData(messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage("message checkin data"));
    }
    const guildId = yield* getRequiredModernGuildId(record.value, "message check-in");
    const accessLevel = yield* authorization.getCurrentGuildMonitorAccessLevel(guildId);
    if (accessLevel === "monitor") {
      return yield* messages.getMessageCheckinMembers(messageId);
    }
    if (accessLevel !== "member") {
      return yield* Effect.fail(
        new Unauthorized({ message: "User is not a member of this guild" }),
      );
    }
    const members = yield* messages.getMessageCheckinMembers(messageId);
    if (!members.some((member) => member.memberId === user.accountId)) {
      return yield* Effect.fail(
        new Unauthorized({
          message: "User is not a recorded participant on this check-in message",
        }),
      );
    }
    return members;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof Unauthorized
        ? cause
        : makeArgumentError("Cannot get message checkin members", cause),
    ),
  );

const requireMessageCheckinMonitor = (messageId: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageCheckinData(messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage("message checkin data"));
    }
    const guildId = yield* getRequiredModernGuildId(record.value, "message check-in");
    yield* requireGuild("monitor", guildId);
  }).pipe(Effect.mapError(authorizationArgumentError("message check-in")));

const requireMessageCheckinParticipantMutation = (messageId: string, memberId: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const user = yield* SheetAuthUser;
    const record = yield* messages.getMessageCheckinData(messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage("message checkin data"));
    }
    if (
      hasPermission(user.permissions, "service") ||
      hasPermission(user.permissions, "app_owner")
    ) {
      return;
    }
    const guildId = yield* getRequiredModernGuildId(record.value, "message check-in");
    const authorization = yield* AuthorizationService;
    if (!hasDiscordAccountPermission(user.permissions, memberId)) {
      return yield* Effect.fail(
        new Unauthorized({ message: "User does not have access to this user" }),
      );
    }
    yield* authorization.requireGuildMember(guildId);
    const members = yield* messages.getMessageCheckinMembers(messageId);
    if (!members.some((member) => member.memberId === memberId)) {
      return yield* Effect.fail(
        new Unauthorized({
          message: "User is not a recorded participant on this check-in message",
        }),
      );
    }
  }).pipe(Effect.mapError(authorizationArgumentError("message check-in participant")));

const requireMessageCheckinUpsert = (messageId: string, guildId?: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const existing = yield* messages.getMessageCheckinData(messageId);
    const resolvedGuildId = Option.isSome(existing)
      ? yield* getRequiredModernGuildId(existing.value, "message check-in")
      : typeof guildId === "string"
        ? guildId
        : yield* legacyDenied("message check-in");
    yield* requireGuild("monitor", resolvedGuildId);
  }).pipe(Effect.mapError(authorizationUnauthorized("message check-in")));

const requireDayPlayerSchedule = (guildId: string, accountId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    const resolvedUser = yield* authorization.resolveCurrentGuildUser(guildId);
    if (
      resolvedUser.accountId !== accountId &&
      !hasPermission(resolvedUser.permissions, "service") &&
      !hasPermission(resolvedUser.permissions, "app_owner") &&
      !hasGuildPermission(resolvedUser.permissions, "monitor_guild", guildId)
    ) {
      return yield* Effect.fail(
        new Unauthorized({ message: "User does not have access to this user" }),
      );
    }
  });

const makeApiLayer = () => {
  const ProxyLayers = Layer.mergeAll(
    HttpApiBuilder.group(Api, "calc", (handlers) =>
      handlers
        .handle("calcBot", serviceOnly("calc", "calcBot"))
        .handle("calcSheet", forwardSheetApis("calc", "calcSheet")),
    ),
    HttpApiBuilder.group(Api, "checkin", (handlers) =>
      handlers
        .handle(
          "generate",
          guildPayload("checkin", "generate", "monitor", (payload) => payload.guildId),
        )
        .handle(
          "dispatch",
          guildPayload("checkin", "dispatch", "monitor", (payload) => payload.guildId),
        )
        .handle(
          "handleButton",
          authorizedSheetApis("checkin", "handleButton", ({ payload }) =>
            Effect.gen(function* () {
              const user = yield* SheetAuthUser;
              yield* requireMessageCheckinParticipantMutation(payload.messageId, user.accountId);
            }),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "discord", (handlers) =>
      handlers
        .handle(
          "getCurrentUser",
          authorizedSheetApis("discord", "getCurrentUser", requireNonService),
        )
        .handle(
          "getCurrentUserGuilds",
          authorizedSheetApis("discord", "getCurrentUserGuilds", requireNonService),
        ),
    ),
    HttpApiBuilder.group(Api, "guildConfig", (handlers) =>
      handlers
        .handle("getAutoCheckinGuilds", serviceOnly("guildConfig", "getAutoCheckinGuilds"))
        .handle(
          "getGuildConfig",
          guildQuery("guildConfig", "getGuildConfig", "manage", (query) => query.guildId),
        )
        .handle(
          "upsertGuildConfig",
          guildPayload("guildConfig", "upsertGuildConfig", "manage", (payload) => payload.guildId),
        )
        .handle(
          "getGuildMonitorRoles",
          guildQuery("guildConfig", "getGuildMonitorRoles", "member", (query) => query.guildId),
        )
        .handle(
          "getGuildChannels",
          guildQuery("guildConfig", "getGuildChannels", "member", (query) => query.guildId),
        )
        .handle(
          "addGuildMonitorRole",
          guildPayload(
            "guildConfig",
            "addGuildMonitorRole",
            "manage",
            (payload) => payload.guildId,
          ),
        )
        .handle(
          "removeGuildMonitorRole",
          guildPayload(
            "guildConfig",
            "removeGuildMonitorRole",
            "manage",
            (payload) => payload.guildId,
          ),
        )
        .handle(
          "upsertGuildChannelConfig",
          guildPayload(
            "guildConfig",
            "upsertGuildChannelConfig",
            "manage",
            (payload) => payload.guildId,
          ),
        )
        .handle(
          "getGuildChannelById",
          guildQuery("guildConfig", "getGuildChannelById", "member", (query) => query.guildId),
        )
        .handle(
          "getGuildChannelByName",
          guildQuery("guildConfig", "getGuildChannelByName", "member", (query) => query.guildId),
        ),
    ),
    HttpApiBuilder.group(Api, "messageCheckin", (handlers) =>
      handlers
        .handle(
          "getMessageCheckinData",
          authorizedSheetApis("messageCheckin", "getMessageCheckinData", ({ query }) =>
            requireMessageCheckinRead(query.messageId),
          ),
        )
        .handle(
          "upsertMessageCheckinData",
          authorizedSheetApis("messageCheckin", "upsertMessageCheckinData", ({ payload }) =>
            requireMessageCheckinUpsert(
              payload.messageId,
              typeof payload.data.guildId === "string" ? payload.data.guildId : undefined,
            ),
          ),
        )
        .handle("getMessageCheckinMembers", ({ query }) =>
          getAuthorizedMessageCheckinMembers(query.messageId),
        )
        .handle(
          "addMessageCheckinMembers",
          authorizedSheetApis("messageCheckin", "addMessageCheckinMembers", ({ payload }) =>
            requireMessageCheckinMonitor(payload.messageId),
          ),
        )
        .handle(
          "persistMessageCheckin",
          authorizedSheetApis("messageCheckin", "persistMessageCheckin", ({ payload }) =>
            requireMessageCheckinUpsert(
              payload.messageId,
              typeof payload.data.guildId === "string" ? payload.data.guildId : undefined,
            ),
          ),
        )
        .handle(
          "setMessageCheckinMemberCheckinAt",
          authorizedSheetApis("messageCheckin", "setMessageCheckinMemberCheckinAt", ({ payload }) =>
            requireMessageCheckinParticipantMutation(payload.messageId, payload.memberId),
          ),
        )
        .handle(
          "removeMessageCheckinMember",
          authorizedSheetApis("messageCheckin", "removeMessageCheckinMember", ({ payload }) =>
            requireMessageCheckinParticipantMutation(payload.messageId, payload.memberId),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "messageRoomOrder", (handlers) =>
      handlers
        .handle(
          "getMessageRoomOrder",
          authorizedSheetApis("messageRoomOrder", "getMessageRoomOrder", ({ query }) =>
            requireRoomOrderMonitor(query.messageId),
          ),
        )
        .handle(
          "upsertMessageRoomOrder",
          authorizedSheetApis("messageRoomOrder", "upsertMessageRoomOrder", ({ payload }) =>
            requireRoomOrderUpsert(
              payload.messageId,
              typeof payload.data.guildId === "string" ? payload.data.guildId : undefined,
            ),
          ),
        )
        .handle(
          "persistMessageRoomOrder",
          authorizedSheetApis("messageRoomOrder", "persistMessageRoomOrder", ({ payload }) =>
            requireRoomOrderUpsert(
              payload.messageId,
              typeof payload.data.guildId === "string" ? payload.data.guildId : undefined,
            ),
          ),
        )
        .handle(
          "decrementMessageRoomOrderRank",
          authorizedSheetApis("messageRoomOrder", "decrementMessageRoomOrderRank", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "incrementMessageRoomOrderRank",
          authorizedSheetApis("messageRoomOrder", "incrementMessageRoomOrderRank", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "getMessageRoomOrderEntry",
          authorizedSheetApis("messageRoomOrder", "getMessageRoomOrderEntry", ({ query }) =>
            requireRoomOrderMonitor(query.messageId),
          ),
        )
        .handle(
          "getMessageRoomOrderRange",
          authorizedSheetApis("messageRoomOrder", "getMessageRoomOrderRange", ({ query }) =>
            requireRoomOrderMonitor(query.messageId),
          ),
        )
        .handle(
          "upsertMessageRoomOrderEntry",
          authorizedSheetApis("messageRoomOrder", "upsertMessageRoomOrderEntry", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "removeMessageRoomOrderEntry",
          authorizedSheetApis("messageRoomOrder", "removeMessageRoomOrderEntry", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "messageSlot", (handlers) =>
      handlers
        .handle(
          "getMessageSlotData",
          authorizedSheetApis("messageSlot", "getMessageSlotData", ({ query }) =>
            requireMessageSlotRead(query.messageId),
          ),
        )
        .handle(
          "upsertMessageSlotData",
          authorizedSheetApis("messageSlot", "upsertMessageSlotData", ({ payload }) =>
            requireMessageSlotUpsert(
              payload.messageId,
              typeof payload.data.guildId === "string" ? payload.data.guildId : undefined,
            ),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "monitor", (handlers) =>
      handlers
        .handle(
          "getMonitorMaps",
          guildQuery("monitor", "getMonitorMaps", "monitor", (query) => query.guildId),
        )
        .handle(
          "getByIds",
          guildQuery("monitor", "getByIds", "monitor", (query) => query.guildId),
        )
        .handle(
          "getByNames",
          guildQuery("monitor", "getByNames", "monitor", (query) => query.guildId),
        ),
    ),
    HttpApiBuilder.group(Api, "permissions", (handlers) =>
      handlers.handle(
        "getCurrentUserPermissions",
        Effect.fnUntraced(function* ({ query }) {
          const authorization = yield* AuthorizationService;
          const resolvedUser =
            typeof query.guildId === "string"
              ? yield* authorization.resolveCurrentGuildUser(query.guildId)
              : yield* SheetAuthUser;

          return {
            permissions: resolvedUser.permissions,
          };
        }),
      ),
    ),
    HttpApiBuilder.group(Api, "player", (handlers) =>
      handlers
        .handle(
          "getPlayerMaps",
          guildQuery("player", "getPlayerMaps", "monitor", (query) => query.guildId),
        )
        .handle(
          "getByIds",
          singlePlayerOrMonitor("player", "getByIds", (query) => ({
            guildId: query.guildId,
            ids: query.ids,
          })),
        )
        .handle(
          "getByNames",
          guildQuery("player", "getByNames", "monitor", (query) => query.guildId),
        )
        .handle(
          "getTeamsByIds",
          singlePlayerOrMonitor("player", "getTeamsByIds", (query) => ({
            guildId: query.guildId,
            ids: query.ids,
          })),
        )
        .handle(
          "getTeamsByNames",
          guildQuery("player", "getTeamsByNames", "monitor", (query) => query.guildId),
        ),
    ),
    HttpApiBuilder.group(Api, "roomOrder", (handlers) =>
      handlers
        .handle(
          "generate",
          guildPayload("roomOrder", "generate", "monitor", (payload) => payload.guildId),
        )
        .handle(
          "dispatch",
          guildPayload("roomOrder", "dispatch", "monitor", (payload) => payload.guildId),
        )
        .handle(
          "handleButton",
          authorizedSheetApis("roomOrder", "handleButton", ({ payload }) =>
            requireRoomOrderButton(payload),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "schedule", (handlers) =>
      handlers
        .handle(
          "getAllPopulatedSchedules",
          guildQuery("schedule", "getAllPopulatedSchedules", "member", (query) => query.guildId),
        )
        .handle(
          "getDayPopulatedSchedules",
          guildQuery("schedule", "getDayPopulatedSchedules", "member", (query) => query.guildId),
        )
        .handle(
          "getChannelPopulatedSchedules",
          guildQuery(
            "schedule",
            "getChannelPopulatedSchedules",
            "member",
            (query) => query.guildId,
          ),
        )
        .handle(
          "getDayPlayerSchedule",
          authorizedSheetApis("schedule", "getDayPlayerSchedule", ({ query }) =>
            requireDayPlayerSchedule(query.guildId, query.accountId),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "screenshot", (handlers) =>
      handlers.handle(
        "getScreenshot",
        guildQuery("screenshot", "getScreenshot", "monitor", (query) => query.guildId),
      ),
    ),
    HttpApiBuilder.group(Api, "sheet", (handlers) =>
      handlers
        .handle("getPlayers", serviceOnly("sheet", "getPlayers"))
        .handle("getMonitors", serviceOnly("sheet", "getMonitors"))
        .handle("getTeams", serviceOnly("sheet", "getTeams"))
        .handle("getAllSchedules", serviceOnly("sheet", "getAllSchedules"))
        .handle("getDaySchedules", serviceOnly("sheet", "getDaySchedules"))
        .handle("getChannelSchedules", serviceOnly("sheet", "getChannelSchedules"))
        .handle("getRangesConfig", serviceOnly("sheet", "getRangesConfig"))
        .handle("getTeamConfig", serviceOnly("sheet", "getTeamConfig"))
        .handle("getEventConfig", serviceOnly("sheet", "getEventConfig"))
        .handle("getScheduleConfig", serviceOnly("sheet", "getScheduleConfig"))
        .handle("getRunnerConfig", serviceOnly("sheet", "getRunnerConfig")),
    ),
    HttpApiBuilder.group(Api, "application", (handlers) =>
      handlers.handle("getApplication", forwardSheetBot("application", "getApplication")),
    ),
    HttpApiBuilder.group(Api, "bot", (handlers) =>
      handlers
        .handle(
          "createInteractionResponse",
          forwardSheetBotPayload("bot", "createInteractionResponse"),
        )
        .handle("sendMessage", forwardSheetBot("bot", "sendMessage"))
        .handle("updateMessage", forwardSheetBot("bot", "updateMessage"))
        .handle(
          "updateOriginalInteractionResponse",
          forwardSheetBot("bot", "updateOriginalInteractionResponse"),
        )
        .handle("createPin", forwardSheetBot("bot", "createPin"))
        .handle("addGuildMemberRole", forwardSheetBot("bot", "addGuildMemberRole")),
    ),
    HttpApiBuilder.group(Api, "cache", (handlers) =>
      handlers
        .handle("getGuild", forwardSheetBot("cache", "getGuild"))
        .handle("getGuildSize", forwardSheetBot("cache", "getGuildSize"))
        .handle("getChannel", forwardSheetBot("cache", "getChannel"))
        .handle("getRole", forwardSheetBot("cache", "getRole"))
        .handle("getMember", forwardSheetBot("cache", "getMember"))
        .handle("getChannelsForParent", forwardSheetBot("cache", "getChannelsForParent"))
        .handle("getRolesForParent", forwardSheetBot("cache", "getRolesForParent"))
        .handle("getMembersForParent", forwardSheetBot("cache", "getMembersForParent"))
        .handle("getChannelsForResource", forwardSheetBot("cache", "getChannelsForResource"))
        .handle("getRolesForResource", forwardSheetBot("cache", "getRolesForResource"))
        .handle("getMembersForResource", forwardSheetBot("cache", "getMembersForResource"))
        .handle("getChannelsSize", forwardSheetBot("cache", "getChannelsSize"))
        .handle("getRolesSize", forwardSheetBot("cache", "getRolesSize"))
        .handle("getMembersSize", forwardSheetBot("cache", "getMembersSize"))
        .handle("getChannelsSizeForParent", forwardSheetBot("cache", "getChannelsSizeForParent"))
        .handle("getRolesSizeForParent", forwardSheetBot("cache", "getRolesSizeForParent"))
        .handle("getMembersSizeForParent", forwardSheetBot("cache", "getMembersSizeForParent"))
        .handle(
          "getChannelsSizeForResource",
          forwardSheetBot("cache", "getChannelsSizeForResource"),
        )
        .handle("getRolesSizeForResource", forwardSheetBot("cache", "getRolesSizeForResource"))
        .handle("getMembersSizeForResource", forwardSheetBot("cache", "getMembersSizeForResource")),
    ),
  );

  const RequestServicesLive = Layer.mergeAll(
    AuthorizationService.layer,
    MessageLookup.layer,
    SheetApisForwardingClient.layer,
    SheetApisRpcTokens.layer,
    SheetBotForwardingClient.layer,
  );

  return HttpApiBuilder.layer(Api).pipe(
    Layer.provide(ProxyLayers),
    Layer.provide(
      SheetBotServiceAuthorizationLive.pipe(Layer.provide(SheetAuthUserResolver.layer)),
    ),
    Layer.provide(SheetApisServiceUserFallbackLive.pipe(Layer.provide(SheetApisRpcTokens.layer))),
    Layer.provide(SheetApisAnonymousUserFallbackLive),
    Layer.provide(SheetAuthTokenAuthorizationLive),
    Layer.merge(HttpApiSwagger.layer(Api)),
    Layer.merge(HttpRouter.add("GET", "/health", HttpServerResponse.empty({ status: 200 }))),
    HttpRouter.provideRequest(RequestServicesLive),
    Layer.provide(corsMiddlewareLayer),
  );
};

const configProviderLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

const HttpLive = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* config.port;
    const ApiLayer = makeApiLayer();

    return HttpRouter.serve(ApiLayer).pipe(
      HttpServer.withLogAddress,
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
    );
  }),
);

const MainLive = HttpLive.pipe(
  Layer.provide(TelemetryLive),
  Layer.provide(Logger.layer([Logger.consoleLogFmt])),
  Layer.provide(NodeHttpClient.layerFetch),
  Layer.provide(configProviderLayer),
);

Layer.launch(MainLive).pipe(NodeRuntime.runMain);
