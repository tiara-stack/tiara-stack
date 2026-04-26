import { NodeFileSystem, NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { createServer } from "http";
import {
  Cache,
  ConfigProvider,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  HashSet,
  Layer,
  Logger,
  Option,
  Redacted,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpBody,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder, HttpApiSwagger } from "effect/unstable/httpapi";
import { Api } from "sheet-ingress-api/api";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "sheet-ingress-api/schemas/middlewares/unauthorized";
import { makeArgumentError } from "typhoon-core/error";
import { config } from "./config";
import {
  AuthorizationService,
  hasDiscordAccountPermission,
  hasGuildPermission,
  hasPermission,
  SheetAuthTokenAuthorizationLive,
} from "./services/authorization";
import { SheetAuthUserResolver } from "./services/authResolver";
import { decodeBearerCredential } from "./services/bearerCredential";
import { scrubbedForwardHeadersFrom } from "./services/headers";
import { MessageLookup } from "./services/messageLookup";
import { SheetApisClient } from "./services/sheetApisClient";

type Upstream = "sheetApis" | "sheetBot";

const hopByHopResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const skippedResponseHeaders = new Set([...hopByHopResponseHeaders, "content-length"]);

const makeTargetUrl = (baseUrl: string, requestUrl: string) => {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const relativePath = requestUrl.replace(/^\/+/, "");
  const url = new URL(relativePath, base);

  return url.toString();
};

const responseHeadersFrom = (headers: Readonly<Record<string, string>>) => {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (!skippedResponseHeaders.has(key.toLowerCase())) {
      result[key] = value;
    }
  }

  return result;
};

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

const getBearerAuthorization = (request: HttpServerRequest.HttpServerRequest) => {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  return authorization.slice("Bearer ".length).trim() === "" ? undefined : authorization;
};

type ServiceTokenAuthorizerService = {
  readonly hasServicePermission: (authorization: string) => Effect.Effect<boolean, unknown>;
};

class ServiceTokenAuthorizer extends Context.Service<
  ServiceTokenAuthorizer,
  ServiceTokenAuthorizerService
>()("ServiceTokenAuthorizer") {
  static layer = Layer.effect(
    ServiceTokenAuthorizer,
    Effect.gen(function* () {
      const sheetAuthUserResolver = yield* SheetAuthUserResolver;
      const servicePermissionCache = yield* Cache.makeWith(
        (authorization: string) =>
          sheetAuthUserResolver
            .resolveToken(
              decodeBearerCredential(Redacted.make(authorization.slice("Bearer ".length).trim())),
            )
            .pipe(
              Effect.map(({ permissions }) => hasPermission(permissions, "service")),
              Effect.tapError((error) =>
                Effect.logWarning("Failed to authorize service token for bot proxy route", error),
              ),
            ),
        {
          capacity: 10_000,
          timeToLive: Exit.match({
            onFailure: () => Duration.seconds(1),
            onSuccess: () => Duration.seconds(30),
          }),
        },
      );

      return {
        hasServicePermission: (authorization: string) =>
          Cache.get(servicePermissionCache, authorization),
      };
    }),
  ).pipe(Layer.provide(SheetAuthUserResolver.layer));
}

const proxyTo =
  (
    upstream: Upstream,
    baseUrl: string,
    options?: { readonly requireServicePermission?: boolean },
  ) =>
  ({ request }: { readonly request: HttpServerRequest.HttpServerRequest }) =>
    Effect.gen(function* () {
      if (options?.requireServicePermission) {
        const authorization = getBearerAuthorization(request);
        if (!authorization) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }

        const serviceTokenAuthorizer = yield* ServiceTokenAuthorizer;
        const hasServicePermission = yield* serviceTokenAuthorizer
          .hasServicePermission(authorization)
          .pipe(Effect.catch(() => Effect.succeed(false)));

        if (!hasServicePermission) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }
      }

      const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
        Effect.mapError((cause) => new Error("Incoming request conversion failed", { cause })),
      );
      const targetUrl = makeTargetUrl(baseUrl, request.url);
      const client = yield* HttpClient.HttpClient;
      const scrubbedRequest = new Request(webRequest, {
        headers: scrubbedForwardHeadersFrom(request),
      });
      const response = yield* client
        .execute(
          HttpClientRequest.fromWeb(scrubbedRequest).pipe(HttpClientRequest.setUrl(targetUrl)),
        )
        .pipe(Effect.timeout(Duration.seconds(30)));

      const contentType = response.headers["content-type"] ?? "application/octet-stream";
      const body = HttpBody.stream(response.stream, contentType);

      return HttpServerResponse.raw(body, {
        status: response.status,
        headers: responseHeadersFrom(response.headers),
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logError(`Ingress proxy failed for ${upstream}`, error).pipe(
          Effect.as(HttpServerResponse.text("Bad Gateway", { status: 502 })),
        ),
      ),
    );

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

const getRequiredModernGuildId = <T extends Parameters<typeof getModernMessageGuildId>[0]>(
  record: T,
  kind: string,
) =>
  Option.match(getModernMessageGuildId(record), {
    onSome: Effect.succeed,
    onNone: () => legacyDenied(kind),
  });

const clientArgsFrom = (args: Record<string, unknown>) => {
  const { request: _request, ...clientArgs } = args;
  return Object.keys(clientArgs).length === 0 ? undefined : clientArgs;
};

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

const proxySheetApis =
  (
    group: string,
    endpoint: string,
    authorize?: (args: any) => Effect.Effect<void, unknown, any>,
    options?: {
      readonly forwardDiscordAccessToken?: boolean;
      readonly unauthenticated?: "anonymous";
    },
  ): any =>
  (args: any) =>
    Effect.gen(function* () {
      if (authorize) {
        yield* authorize(args);
      }

      const client = yield* SheetApisClient;
      const groupClient = (client as any)[group];
      const endpointClient = groupClient?.[endpoint];
      if (typeof endpointClient !== "function") {
        return yield* Effect.die(
          new Error(`Unknown sheet-apis proxy target: ${group}.${endpoint}`),
        );
      }
      const proxied = options?.forwardDiscordAccessToken
        ? client.withDiscordAccessToken(endpointClient.call(groupClient, clientArgsFrom(args)))
        : endpointClient.call(groupClient, clientArgsFrom(args));
      const maybeUser = yield* Effect.serviceOption(SheetAuthUser);
      if (Option.isSome(maybeUser)) {
        return yield* proxied;
      }
      if (options?.unauthenticated === "anonymous") {
        return yield* proxied.pipe(
          Effect.provideService(SheetAuthUser, {
            accountId: "anonymous",
            userId: "anonymous",
            permissions: HashSet.empty(),
            token: Redacted.make("anonymous-token-unavailable"),
          }),
        );
      }
      return yield* client.withServiceUser(proxied);
    });

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

const requireMessageSlotRead = (messageId: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageSlotData(messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage("message slot data"));
    }
    const guildId = yield* getRequiredModernGuildId(record.value, "message slot");
    yield* requireGuild("member", guildId);
  });

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
  });

const requireRoomOrderMonitor = (messageId: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageRoomOrder(messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage("message room order"));
    }
    const guildId = yield* getRequiredModernGuildId(record.value, "message room order");
    yield* requireGuild("monitor", guildId);
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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

const makeApiLayer = ({ sheetBotBaseUrl }: { readonly sheetBotBaseUrl: string }) => {
  const sheetBotProxy = proxyTo("sheetBot", sheetBotBaseUrl, { requireServicePermission: true });

  const ProxyLayers = Layer.mergeAll(
    HttpApiBuilder.group(Api, "calc", (handlers) =>
      handlers
        .handle("calcBot", proxySheetApis("calc", "calcBot", requireService))
        .handle(
          "calcSheet",
          proxySheetApis("calc", "calcSheet", undefined, { unauthenticated: "anonymous" }),
        ),
    ),
    HttpApiBuilder.group(Api, "checkin", (handlers) =>
      handlers.handle(
        "generate",
        proxySheetApis("checkin", "generate", ({ payload }) =>
          requireGuild("monitor", payload.guildId),
        ),
      ),
    ),
    HttpApiBuilder.group(Api, "discord", (handlers) =>
      handlers
        .handle(
          "getCurrentUser",
          proxySheetApis("discord", "getCurrentUser", requireNonService, {
            forwardDiscordAccessToken: true,
          }),
        )
        .handle(
          "getCurrentUserGuilds",
          proxySheetApis("discord", "getCurrentUserGuilds", requireNonService, {
            forwardDiscordAccessToken: true,
          }),
        ),
    ),
    HttpApiBuilder.group(Api, "guildConfig", (handlers) =>
      handlers
        .handle(
          "getAutoCheckinGuilds",
          proxySheetApis("guildConfig", "getAutoCheckinGuilds", requireService),
        )
        .handle(
          "getGuildConfig",
          proxySheetApis("guildConfig", "getGuildConfig", ({ query }) =>
            requireGuild("manage", query.guildId),
          ),
        )
        .handle(
          "upsertGuildConfig",
          proxySheetApis("guildConfig", "upsertGuildConfig", ({ payload }) =>
            requireGuild("manage", payload.guildId),
          ),
        )
        .handle(
          "getGuildMonitorRoles",
          proxySheetApis("guildConfig", "getGuildMonitorRoles", ({ query }) =>
            requireGuild("member", query.guildId),
          ),
        )
        .handle(
          "getGuildChannels",
          proxySheetApis("guildConfig", "getGuildChannels", ({ query }) =>
            requireGuild("member", query.guildId),
          ),
        )
        .handle(
          "addGuildMonitorRole",
          proxySheetApis("guildConfig", "addGuildMonitorRole", ({ payload }) =>
            requireGuild("manage", payload.guildId),
          ),
        )
        .handle(
          "removeGuildMonitorRole",
          proxySheetApis("guildConfig", "removeGuildMonitorRole", ({ payload }) =>
            requireGuild("manage", payload.guildId),
          ),
        )
        .handle(
          "upsertGuildChannelConfig",
          proxySheetApis("guildConfig", "upsertGuildChannelConfig", ({ payload }) =>
            requireGuild("manage", payload.guildId),
          ),
        )
        .handle(
          "getGuildChannelById",
          proxySheetApis("guildConfig", "getGuildChannelById", ({ query }) =>
            requireGuild("member", query.guildId),
          ),
        )
        .handle(
          "getGuildChannelByName",
          proxySheetApis("guildConfig", "getGuildChannelByName", ({ query }) =>
            requireGuild("member", query.guildId),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "health", (handlers) =>
      handlers
        .handle(
          "live",
          proxySheetApis("health", "live", undefined, { unauthenticated: "anonymous" }),
        )
        .handle(
          "ready",
          proxySheetApis("health", "ready", undefined, { unauthenticated: "anonymous" }),
        ),
    ),
    HttpApiBuilder.group(Api, "messageCheckin", (handlers) =>
      handlers
        .handle(
          "getMessageCheckinData",
          proxySheetApis("messageCheckin", "getMessageCheckinData", ({ query }) =>
            requireMessageCheckinRead(query.messageId),
          ),
        )
        .handle(
          "upsertMessageCheckinData",
          proxySheetApis("messageCheckin", "upsertMessageCheckinData", ({ payload }) =>
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
          proxySheetApis("messageCheckin", "addMessageCheckinMembers", ({ payload }) =>
            requireMessageCheckinMonitor(payload.messageId),
          ),
        )
        .handle(
          "setMessageCheckinMemberCheckinAt",
          proxySheetApis("messageCheckin", "setMessageCheckinMemberCheckinAt", ({ payload }) =>
            requireMessageCheckinParticipantMutation(payload.messageId, payload.memberId),
          ),
        )
        .handle(
          "removeMessageCheckinMember",
          proxySheetApis("messageCheckin", "removeMessageCheckinMember", ({ payload }) =>
            requireMessageCheckinParticipantMutation(payload.messageId, payload.memberId),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "messageRoomOrder", (handlers) =>
      handlers
        .handle(
          "getMessageRoomOrder",
          proxySheetApis("messageRoomOrder", "getMessageRoomOrder", ({ query }) =>
            requireRoomOrderMonitor(query.messageId),
          ),
        )
        .handle(
          "upsertMessageRoomOrder",
          proxySheetApis("messageRoomOrder", "upsertMessageRoomOrder", ({ payload }) =>
            requireRoomOrderUpsert(
              payload.messageId,
              typeof payload.data.guildId === "string" ? payload.data.guildId : undefined,
            ),
          ),
        )
        .handle(
          "persistMessageRoomOrder",
          proxySheetApis("messageRoomOrder", "persistMessageRoomOrder", ({ payload }) =>
            requireRoomOrderUpsert(
              payload.messageId,
              typeof payload.data.guildId === "string" ? payload.data.guildId : undefined,
            ),
          ),
        )
        .handle(
          "decrementMessageRoomOrderRank",
          proxySheetApis("messageRoomOrder", "decrementMessageRoomOrderRank", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "incrementMessageRoomOrderRank",
          proxySheetApis("messageRoomOrder", "incrementMessageRoomOrderRank", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "getMessageRoomOrderEntry",
          proxySheetApis("messageRoomOrder", "getMessageRoomOrderEntry", ({ query }) =>
            requireRoomOrderMonitor(query.messageId),
          ),
        )
        .handle(
          "getMessageRoomOrderRange",
          proxySheetApis("messageRoomOrder", "getMessageRoomOrderRange", ({ query }) =>
            requireRoomOrderMonitor(query.messageId),
          ),
        )
        .handle(
          "upsertMessageRoomOrderEntry",
          proxySheetApis("messageRoomOrder", "upsertMessageRoomOrderEntry", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "removeMessageRoomOrderEntry",
          proxySheetApis("messageRoomOrder", "removeMessageRoomOrderEntry", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "messageSlot", (handlers) =>
      handlers
        .handle(
          "getMessageSlotData",
          proxySheetApis("messageSlot", "getMessageSlotData", ({ query }) =>
            requireMessageSlotRead(query.messageId),
          ),
        )
        .handle(
          "upsertMessageSlotData",
          proxySheetApis("messageSlot", "upsertMessageSlotData", ({ payload }) =>
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
          proxySheetApis("monitor", "getMonitorMaps", ({ query }) =>
            requireGuild("monitor", query.guildId),
          ),
        )
        .handle(
          "getByIds",
          proxySheetApis("monitor", "getByIds", ({ query }) =>
            requireGuild("monitor", query.guildId),
          ),
        )
        .handle(
          "getByNames",
          proxySheetApis("monitor", "getByNames", ({ query }) =>
            requireGuild("monitor", query.guildId),
          ),
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
          proxySheetApis("player", "getPlayerMaps", ({ query }) =>
            requireGuild("monitor", query.guildId),
          ),
        )
        .handle(
          "getByIds",
          proxySheetApis("player", "getByIds", ({ query }) =>
            query.ids.length === 1
              ? requireSelfOrMonitor(query.guildId, query.ids[0])
              : requireGuild("monitor", query.guildId),
          ),
        )
        .handle(
          "getByNames",
          proxySheetApis("player", "getByNames", ({ query }) =>
            requireGuild("monitor", query.guildId),
          ),
        )
        .handle(
          "getTeamsByIds",
          proxySheetApis("player", "getTeamsByIds", ({ query }) =>
            query.ids.length === 1
              ? requireSelfOrMonitor(query.guildId, query.ids[0])
              : requireGuild("monitor", query.guildId),
          ),
        )
        .handle(
          "getTeamsByNames",
          proxySheetApis("player", "getTeamsByNames", ({ query }) =>
            requireGuild("monitor", query.guildId),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "roomOrder", (handlers) =>
      handlers.handle(
        "generate",
        proxySheetApis("roomOrder", "generate", ({ payload }) =>
          requireGuild("monitor", payload.guildId),
        ),
      ),
    ),
    HttpApiBuilder.group(Api, "schedule", (handlers) =>
      handlers
        .handle(
          "getAllPopulatedSchedules",
          proxySheetApis("schedule", "getAllPopulatedSchedules", ({ query }) =>
            requireGuild("member", query.guildId),
          ),
        )
        .handle(
          "getDayPopulatedSchedules",
          proxySheetApis("schedule", "getDayPopulatedSchedules", ({ query }) =>
            requireGuild("member", query.guildId),
          ),
        )
        .handle(
          "getChannelPopulatedSchedules",
          proxySheetApis("schedule", "getChannelPopulatedSchedules", ({ query }) =>
            requireGuild("member", query.guildId),
          ),
        )
        .handle(
          "getDayPlayerSchedule",
          proxySheetApis("schedule", "getDayPlayerSchedule", ({ query }) =>
            requireDayPlayerSchedule(query.guildId, query.accountId),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "screenshot", (handlers) =>
      handlers.handle(
        "getScreenshot",
        proxySheetApis("screenshot", "getScreenshot", ({ query }) =>
          requireGuild("monitor", query.guildId),
        ),
      ),
    ),
    HttpApiBuilder.group(Api, "sheet", (handlers) =>
      handlers
        .handle("getPlayers", proxySheetApis("sheet", "getPlayers", requireService))
        .handle("getMonitors", proxySheetApis("sheet", "getMonitors", requireService))
        .handle("getTeams", proxySheetApis("sheet", "getTeams", requireService))
        .handle("getAllSchedules", proxySheetApis("sheet", "getAllSchedules", requireService))
        .handle("getDaySchedules", proxySheetApis("sheet", "getDaySchedules", requireService))
        .handle(
          "getChannelSchedules",
          proxySheetApis("sheet", "getChannelSchedules", requireService),
        )
        .handle("getRangesConfig", proxySheetApis("sheet", "getRangesConfig", requireService))
        .handle("getTeamConfig", proxySheetApis("sheet", "getTeamConfig", requireService))
        .handle("getEventConfig", proxySheetApis("sheet", "getEventConfig", requireService))
        .handle("getScheduleConfig", proxySheetApis("sheet", "getScheduleConfig", requireService))
        .handle("getRunnerConfig", proxySheetApis("sheet", "getRunnerConfig", requireService)),
    ),
    HttpApiBuilder.group(Api, "application", (handlers) =>
      handlers.handleRaw("getApplication", sheetBotProxy),
    ),
    HttpApiBuilder.group(Api, "cache", (handlers) =>
      handlers
        .handleRaw("getGuild", sheetBotProxy)
        .handleRaw("getGuildSize", sheetBotProxy)
        .handleRaw("getChannel", sheetBotProxy)
        .handleRaw("getRole", sheetBotProxy)
        .handleRaw("getMember", sheetBotProxy)
        .handleRaw("getChannelsForParent", sheetBotProxy)
        .handleRaw("getRolesForParent", sheetBotProxy)
        .handleRaw("getMembersForParent", sheetBotProxy)
        .handleRaw("getChannelsForResource", sheetBotProxy)
        .handleRaw("getRolesForResource", sheetBotProxy)
        .handleRaw("getMembersForResource", sheetBotProxy)
        .handleRaw("getChannelsSize", sheetBotProxy)
        .handleRaw("getRolesSize", sheetBotProxy)
        .handleRaw("getMembersSize", sheetBotProxy)
        .handleRaw("getChannelsSizeForParent", sheetBotProxy)
        .handleRaw("getRolesSizeForParent", sheetBotProxy)
        .handleRaw("getMembersSizeForParent", sheetBotProxy)
        .handleRaw("getChannelsSizeForResource", sheetBotProxy)
        .handleRaw("getRolesSizeForResource", sheetBotProxy)
        .handleRaw("getMembersSizeForResource", sheetBotProxy),
    ),
  );

  return HttpApiBuilder.layer(Api).pipe(
    Layer.provide(ProxyLayers),
    Layer.merge(HttpApiSwagger.layer(Api)),
    Layer.merge(HttpRouter.add("GET", "/health", HttpServerResponse.empty({ status: 200 }))),
    Layer.provide(corsMiddlewareLayer),
    Layer.provide([
      SheetAuthTokenAuthorizationLive,
      AuthorizationService.layer,
      MessageLookup.layer,
      SheetApisClient.layer,
    ]),
  );
};

const configProviderLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(".env").pipe(
      Effect.map((content) =>
        ConfigProvider.layerAdd(ConfigProvider.fromDotEnvContents(content)).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
        ),
      ),
      Effect.catch((error) =>
        Effect.logWarning(
          "Could not read .env file, falling back to environment variables",
          error,
        ).pipe(Effect.as(ConfigProvider.layer(ConfigProvider.fromEnv()))),
      ),
    );
  }),
).pipe(Layer.provide(NodeFileSystem.layer));

const HttpLive = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* config.port;
    const sheetBotBaseUrl = yield* config.sheetBotBaseUrl;
    const ApiLayer = makeApiLayer({ sheetBotBaseUrl });

    return HttpRouter.serve(ApiLayer).pipe(
      HttpServer.withLogAddress,
      Layer.provide(ServiceTokenAuthorizer.layer),
      Layer.provide(NodeHttpServer.layer(createServer, { port })),
    );
  }),
);

const MainLive = HttpLive.pipe(
  Layer.provide(Logger.layer([Logger.consoleLogFmt])),
  Layer.provide(NodeHttpClient.layerFetch),
  Layer.provide(configProviderLayer),
) as Layer.Layer<never, never, never>;

Layer.launch(MainLive).pipe(NodeRuntime.runMain);
