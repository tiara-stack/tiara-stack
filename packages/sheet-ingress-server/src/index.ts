// fallow-ignore-file code-duplication
// fallow-ignore-file complexity
import { NodeFileSystem, NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { createServer } from "http";
import { Effect, FileSystem, Layer, Logger, Option } from "effect";
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/unstable/http";
import {
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSwagger,
} from "effect/unstable/httpapi";
import { Api } from "sheet-ingress-api/api";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import {
  DispatchRoomOrderButtonMethods,
  interactionResponseTokenExpirySafetyMarginMs,
  interactionResponseTokenLifetimeMs,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchAuthorizationSnapshot } from "sheet-ingress-api/sheet-workflows-workflows";
import { Unauthorized } from "typhoon-core/error";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { ArgumentError, makeArgumentError } from "typhoon-core/error";
import type { ClientRef } from "sheet-ingress-api/schemas/client";
import { config } from "./config";
import { healthRoutesLayer } from "./health";
import {
  AuthorizationService,
  hasDiscordAccountPermission,
  hasWorkspacePermission,
  hasPermission,
  SheetAuthTokenAuthorizationLive,
} from "./services/authorization";
import { SheetAuthUserResolver } from "./services/authResolver";
import { MessageLookup } from "./services/messageLookup";
import { roomOrderButtonProxyAuthorizers } from "./services/roomOrderButtonAuthorization";
import { SheetWorkflowsForwardingClient } from "./services/sheetWorkflowsForwardingClient";
import { SheetApisForwardingClient } from "./services/sheetApisForwardingClient";
import { SheetApisRpcTokens } from "./services/sheetApisRpcTokens";
import { SheetBotForwardingClient } from "./services/sheetBotForwardingClient";
import { ClientDeliveryForwardingClient } from "./services/clientDeliveryForwardingClient";
import {
  clientArgsFrom,
  forwardSheetBot,
  forwardSheetBotPayload,
  type SheetBotProxyHandler,
} from "./services/sheetBotProxy";
import { sheetApisRpcArgsFromHttpArgs } from "./services/sheetApisProxy";
import { ServiceStatusService } from "./services/serviceStatus";
import { normalizeServicesStatusResponse } from "./services/statusResponse";
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
    readonly workspaceId: Option.Option<string>;
    readonly conversationId: Option.Option<string>;
  },
>(
  record: T,
) =>
  Option.match(record.workspaceId, {
    onSome: (guildId) =>
      Option.isSome(record.conversationId) ? Option.some(guildId) : Option.none(),
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
type SheetWorkflowsForwardingClientService = typeof SheetWorkflowsForwardingClient.Service;
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
type SheetWorkflowsDispatchEndpointName = Extract<
  keyof SheetWorkflowsForwardingClientService["dispatch"],
  string
>;
type SheetWorkflowsDispatchRequest<EndpointName extends SheetWorkflowsDispatchEndpointName> =
  HttpApiEndpoint.Request<
    HttpApiEndpoint.WithName<
      HttpApiGroup.Endpoints<HttpApiGroup.WithName<SheetIngressGroups, "dispatch">>,
      EndpointName
    >
  >;
type SheetWorkflowsDispatchError<EndpointName extends SheetWorkflowsDispatchEndpointName> =
  HttpApiEndpoint.ErrorsWithName<
    HttpApiGroup.Endpoints<HttpApiGroup.WithName<SheetIngressGroups, "dispatch">>,
    EndpointName
  >;
type SheetWorkflowsDispatchHandler<
  EndpointName extends SheetWorkflowsDispatchEndpointName,
  R,
> = HttpApiEndpoint.HandlerWithName<
  HttpApiGroup.Endpoints<HttpApiGroup.WithName<SheetIngressGroups, "dispatch">>,
  EndpointName,
  SheetWorkflowsDispatchError<EndpointName>,
  SheetWorkflowsForwardingClient | R
>;

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
      return yield* endpointClient.call(groupClient, sheetApisRpcArgsFromHttpArgs(args));
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

const statusGetServices: SheetApisProxyHandler<
  "status",
  "getServices",
  ServiceStatusService
> = () =>
  Effect.gen(function* () {
    const serviceStatusService = yield* ServiceStatusService;
    return yield* serviceStatusService.getServicesStatus();
  }).pipe(Effect.map((response) => normalizeServicesStatusResponse(response))) as ReturnType<
    SheetApisProxyHandler<"status", "getServices", ServiceStatusService>
  >;

const forwardSheetWorkflowsDispatch =
  <EndpointName extends SheetWorkflowsDispatchEndpointName>(
    endpoint: EndpointName,
    authorization?: WorkflowAuthorizationSnapshot,
  ): SheetWorkflowsDispatchHandler<EndpointName, never> =>
  (rawArgs) =>
    Effect.gen(function* () {
      const args = rawArgs as SheetWorkflowsDispatchRequest<EndpointName>;
      const client = yield* SheetWorkflowsForwardingClient;
      const endpointClient = client.dispatch[endpoint];
      const requester = yield* SheetAuthUser;
      const { payload } = clientArgsFrom(args) as {
        readonly payload: {
          readonly client: ClientRef;
          readonly interactionToken?: string | undefined;
          readonly interactionDeadlineEpochMs?: number | undefined;
          readonly messageId?: string | undefined;
        };
      };
      const clientRef = payload.client;
      const hasInteractionToken = payload.interactionToken !== undefined;
      const hasInteractionDeadline = payload.interactionDeadlineEpochMs !== undefined;
      if (hasInteractionToken !== hasInteractionDeadline) {
        return yield* Effect.fail(
          makeArgumentError(
            `Dispatch interaction payload must include both interactionToken and interactionDeadlineEpochMs for ${requester.accountId}/${requester.userId}`,
          ),
        );
      }
      const interactionDeadlineEpochMs = hasInteractionDeadline
        ? Math.min(
            payload.interactionDeadlineEpochMs!,
            Date.now() +
              interactionResponseTokenLifetimeMs -
              interactionResponseTokenExpirySafetyMarginMs,
          )
        : undefined;
      const workflowPayload =
        interactionDeadlineEpochMs === undefined
          ? payload
          : { ...payload, interactionDeadlineEpochMs };
      const basePayload = {
        requester: { accountId: requester.accountId, userId: requester.userId },
        payload: workflowPayload,
        ...(authorization === undefined ? {} : { authorization }),
        ...(interactionDeadlineEpochMs === undefined ? {} : { interactionDeadlineEpochMs }),
      };
      const requireMessageId = () =>
        workflowPayload.messageId === undefined
          ? Effect.fail(
              makeArgumentError("Cannot forward room-order button dispatch without messageId"),
            )
          : Effect.succeed(workflowPayload.messageId);
      const requireRegisteredRoomOrder = Effect.gen(function* () {
        const messages = yield* MessageLookup;
        const messageId = yield* requireMessageId();
        const authorizedRoomOrder = yield* messages.getMessageRoomOrder(messageId, clientRef);
        return yield* Option.match(authorizedRoomOrder, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              makeArgumentError(
                "Cannot get message room order, the message might not be registered",
              ),
            ),
        });
      });
      const dispatchPayloadAugmenters = {
        [DispatchRoomOrderButtonMethods.previous.endpointName]: () =>
          requireRegisteredRoomOrder.pipe(
            Effect.map((authorizedRoomOrder) => ({ ...basePayload, authorizedRoomOrder })),
          ),
        [DispatchRoomOrderButtonMethods.next.endpointName]: () =>
          requireRegisteredRoomOrder.pipe(
            Effect.map((authorizedRoomOrder) => ({ ...basePayload, authorizedRoomOrder })),
          ),
        [DispatchRoomOrderButtonMethods.send.endpointName]: () =>
          requireRegisteredRoomOrder.pipe(
            Effect.map((authorizedRoomOrder) => ({ ...basePayload, authorizedRoomOrder })),
          ),
        [DispatchRoomOrderButtonMethods.pinTentative.endpointName]: () =>
          Effect.gen(function* () {
            const messages = yield* MessageLookup;
            const messageId = yield* requireMessageId();
            const authorizedRoomOrder = yield* messages.getMessageRoomOrder(messageId, clientRef);
            return {
              ...basePayload,
              authorizedRoomOrder: Option.match(authorizedRoomOrder, {
                onSome: (roomOrder) => roomOrder,
                onNone: () => null,
              }),
            };
          }),
      } as const;
      const augmentPayload =
        dispatchPayloadAugmenters[endpoint as keyof typeof dispatchPayloadAugmenters] ??
        (() => Effect.succeed(basePayload));
      const finalPayload = yield* augmentPayload();
      return yield* endpointClient(finalPayload as never);
    }) as ReturnType<SheetWorkflowsDispatchHandler<EndpointName, never>>;

const authorizedSheetWorkflowsDispatch =
  <EndpointName extends SheetWorkflowsDispatchEndpointName, R>(
    endpoint: EndpointName,
    authorize: (
      args: SheetWorkflowsDispatchRequest<EndpointName>,
    ) => Effect.Effect<
      WorkflowAuthorizationSnapshot | void,
      SheetWorkflowsDispatchError<EndpointName>,
      R
    >,
  ): SheetWorkflowsDispatchHandler<EndpointName, R> =>
  (rawArgs) =>
    Effect.gen(function* () {
      const args = rawArgs as SheetWorkflowsDispatchRequest<EndpointName>;
      const authorization = yield* authorize(args);
      return yield* forwardSheetWorkflowsDispatch(
        endpoint,
        authorization ?? undefined,
      )(rawArgs as never);
    }) as ReturnType<SheetWorkflowsDispatchHandler<EndpointName, R>>;

type WorkflowAuthorizationSnapshot = DispatchAuthorizationSnapshot;

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
      yield* authorization.requireWorkspaceMember(guildId);
    } else if (scope === "monitor") {
      yield* authorization.requireMonitorWorkspace(guildId);
    } else {
      yield* authorization.requireManageWorkspace(guildId);
    }
  });

const requireGuildSnapshot = (scope: WorkflowAuthorizationSnapshot["scope"], guildId: string) =>
  requireGuild(scope, guildId).pipe(Effect.as({ workspaceId: guildId, scope }));

const buildFileUploadFormData = (
  payload: {
    readonly payload: unknown;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly name: string;
      readonly contentType: string;
    }>;
  },
  fs: FileSystem.FileSystem,
  interactionToken?: string,
) =>
  Effect.gen(function* () {
    const formData = new FormData();
    if (interactionToken !== undefined) {
      formData.append("interactionToken", interactionToken);
    }
    formData.append("payload", JSON.stringify(payload.payload));

    yield* Effect.forEach(
      payload.files,
      (file) =>
        Effect.gen(function* () {
          const content = yield* fs.readFile(file.path);
          formData.append(
            "files",
            new File([content as BlobPart], file.name, { type: file.contentType }),
          );
        }),
      { concurrency: 1 },
    );

    return formData;
  });

const requireSelfOrMonitor = (guildId: string, accountId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    yield* authorization.requireDiscordAccountIdOrMonitorGuild(guildId, accountId);
  });

const requireSelfOrMonitorSnapshot = (guildId: string, accountId: string) =>
  Effect.gen(function* () {
    const user = yield* SheetAuthUser;
    yield* requireSelfOrMonitor(guildId, accountId);
    return user.accountId === accountId
      ? undefined
      : { workspaceId: guildId, scope: "monitor" as const };
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
    const accessLevel = yield* authorization.getCurrentWorkspaceMonitorAccessLevel(guildId);
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
    const accessLevel = yield* authorization.getCurrentWorkspaceMonitorAccessLevel(guildId);
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
    yield* authorization.requireWorkspaceMember(guildId);
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
    const resolvedUser = yield* authorization.resolveCurrentWorkspaceUser(guildId);
    if (
      resolvedUser.accountId !== accountId &&
      !hasPermission(resolvedUser.permissions, "service") &&
      !hasPermission(resolvedUser.permissions, "app_owner") &&
      !hasWorkspacePermission(resolvedUser.permissions, "monitor_workspace", guildId)
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
      handlers.handle(
        "generate",
        guildPayload("checkin", "generate", "monitor", (payload) => payload.workspaceId),
      ),
    ),
    HttpApiBuilder.group(Api, "dispatch", (handlers) =>
      handlers
        .handle(
          "checkin",
          authorizedSheetWorkflowsDispatch("checkin", ({ payload }) =>
            requireGuild("monitor", payload.workspaceId),
          ),
        )
        .handle(
          "autoCheckinTest",
          authorizedSheetWorkflowsDispatch("autoCheckinTest", ({ payload }) =>
            requireGuild("monitor", payload.workspaceId),
          ),
        )
        .handle(
          "checkinButton",
          authorizedSheetWorkflowsDispatch("checkinButton", ({ payload }) =>
            Effect.gen(function* () {
              const user = yield* SheetAuthUser;
              yield* requireMessageCheckinParticipantMutation(payload.messageId, user.accountId);
            }),
          ),
        )
        .handle(
          "roomOrder",
          authorizedSheetWorkflowsDispatch("roomOrder", ({ payload }) =>
            requireGuild("monitor", payload.workspaceId),
          ),
        )
        .handle(
          "kickout",
          authorizedSheetWorkflowsDispatch("kickout", ({ payload }) =>
            requireGuild("monitor", payload.workspaceId),
          ),
        )
        .handle(
          "slotButton",
          authorizedSheetWorkflowsDispatch("slotButton", ({ payload }) =>
            requireGuild("monitor", payload.workspaceId),
          ),
        )
        .handle(
          "slotList",
          authorizedSheetWorkflowsDispatch("slotList", ({ payload }) =>
            payload.messageType === "persistent"
              ? requireGuild("monitor", payload.workspaceId)
              : Effect.void,
          ),
        )
        .handle(
          "slotOpenButton",
          authorizedSheetWorkflowsDispatch("slotOpenButton", ({ payload }) =>
            requireMessageSlotRead(payload.messageId),
          ),
        )
        .handle(
          "serviceStatus",
          authorizedSheetWorkflowsDispatch("serviceStatus", requireNonService),
        )
        .handle(
          "preferenceDmStatus",
          authorizedSheetWorkflowsDispatch("preferenceDmStatus", requireNonService),
        )
        .handle(
          "preferenceDmEnable",
          authorizedSheetWorkflowsDispatch("preferenceDmEnable", requireNonService),
        )
        .handle(
          "preferenceDmDisable",
          authorizedSheetWorkflowsDispatch("preferenceDmDisable", requireNonService),
        )
        .handle(
          "preferenceDmSetClient",
          authorizedSheetWorkflowsDispatch("preferenceDmSetClient", requireNonService),
        )
        .handle(
          "workspaceWelcome",
          authorizedSheetWorkflowsDispatch("workspaceWelcome", requireService),
        )
        .handle(
          "updateAnnouncement",
          authorizedSheetWorkflowsDispatch("updateAnnouncement", requireService),
        )
        .handle(
          "serviceAddWorkspaceFeatureFlag",
          authorizedSheetWorkflowsDispatch("serviceAddWorkspaceFeatureFlag", requireService),
        )
        .handle(
          "serviceRemoveWorkspaceFeatureFlag",
          authorizedSheetWorkflowsDispatch("serviceRemoveWorkspaceFeatureFlag", requireService),
        )
        .handle(
          "conversationListConfig",
          authorizedSheetWorkflowsDispatch("conversationListConfig", ({ payload }) =>
            requireGuildSnapshot("manage", payload.workspaceId),
          ),
        )
        .handle(
          "conversationSet",
          authorizedSheetWorkflowsDispatch("conversationSet", ({ payload }) =>
            requireGuildSnapshot("manage", payload.workspaceId),
          ),
        )
        .handle(
          "conversationUnset",
          authorizedSheetWorkflowsDispatch("conversationUnset", ({ payload }) =>
            requireGuildSnapshot("manage", payload.workspaceId),
          ),
        )
        .handle(
          "workspaceListConfig",
          authorizedSheetWorkflowsDispatch("workspaceListConfig", ({ payload }) =>
            requireGuildSnapshot("manage", payload.workspaceId),
          ),
        )
        .handle(
          "workspaceAddMonitorRole",
          authorizedSheetWorkflowsDispatch("workspaceAddMonitorRole", ({ payload }) =>
            requireGuildSnapshot("manage", payload.workspaceId),
          ),
        )
        .handle(
          "workspaceRemoveMonitorRole",
          authorizedSheetWorkflowsDispatch("workspaceRemoveMonitorRole", ({ payload }) =>
            requireGuildSnapshot("manage", payload.workspaceId),
          ),
        )
        .handle(
          "workspaceSetSheet",
          authorizedSheetWorkflowsDispatch("workspaceSetSheet", ({ payload }) =>
            requireGuildSnapshot("manage", payload.workspaceId),
          ),
        )
        .handle(
          "workspaceSetAutoCheckin",
          authorizedSheetWorkflowsDispatch("workspaceSetAutoCheckin", ({ payload }) =>
            requireGuildSnapshot("manage", payload.workspaceId),
          ),
        )
        .handle(
          "teamList",
          authorizedSheetWorkflowsDispatch("teamList", ({ payload }) =>
            requireSelfOrMonitorSnapshot(payload.workspaceId, payload.targetUserId),
          ),
        )
        .handle(
          "scheduleList",
          authorizedSheetWorkflowsDispatch("scheduleList", ({ payload }) =>
            requireSelfOrMonitorSnapshot(payload.workspaceId, payload.targetUserId),
          ),
        )
        .handle(
          "screenshot",
          authorizedSheetWorkflowsDispatch("screenshot", ({ payload }) =>
            requireGuildSnapshot("monitor", payload.workspaceId),
          ),
        )
        .handle(
          DispatchRoomOrderButtonMethods.previous.endpointName,
          authorizedSheetWorkflowsDispatch(
            DispatchRoomOrderButtonMethods.previous.endpointName,
            ({ payload }) =>
              roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.previous.endpointName](
                { messageId: payload.messageId },
                payload.client,
              ),
          ),
        )
        .handle(
          DispatchRoomOrderButtonMethods.next.endpointName,
          authorizedSheetWorkflowsDispatch(
            DispatchRoomOrderButtonMethods.next.endpointName,
            ({ payload }) =>
              roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.next.endpointName](
                { messageId: payload.messageId },
                payload.client,
              ),
          ),
        )
        .handle(
          DispatchRoomOrderButtonMethods.send.endpointName,
          authorizedSheetWorkflowsDispatch(
            DispatchRoomOrderButtonMethods.send.endpointName,
            ({ payload }) =>
              roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.send.endpointName](
                { messageId: payload.messageId },
                payload.client,
              ),
          ),
        )
        .handle(
          DispatchRoomOrderButtonMethods.pinTentative.endpointName,
          authorizedSheetWorkflowsDispatch(
            DispatchRoomOrderButtonMethods.pinTentative.endpointName,
            ({ payload }) =>
              roomOrderButtonProxyAuthorizers[
                DispatchRoomOrderButtonMethods.pinTentative.endpointName
              ]({ workspaceId: payload.workspaceId, messageId: payload.messageId }, payload.client),
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
    HttpApiBuilder.group(Api, "userConfig", (handlers) =>
      handlers
        .handle(
          "getCurrentUserPlatformConfig",
          authorizedSheetApis("userConfig", "getCurrentUserPlatformConfig", requireNonService),
        )
        .handle(
          "upsertCurrentUserPlatformConfig",
          authorizedSheetApis("userConfig", "upsertCurrentUserPlatformConfig", requireNonService),
        )
        .handle(
          "listSupportedNotificationClients",
          authorizedSheetApis("userConfig", "listSupportedNotificationClients", requireNonService),
        )
        .handle(
          "getCheckinDmRecipients",
          authorizedSheetApis("userConfig", "getCheckinDmRecipients", requireService),
        )
        .handle(
          "getUserPlatformConfig",
          authorizedSheetApis("userConfig", "getUserPlatformConfig", requireService),
        )
        .handle(
          "upsertUserPlatformConfig",
          authorizedSheetApis("userConfig", "upsertUserPlatformConfig", requireService),
        ),
    ),
    HttpApiBuilder.group(Api, "status", (handlers) =>
      handlers.handle("getServices", statusGetServices),
    ),
    HttpApiBuilder.group(Api, "workspaceConfig", (handlers) =>
      handlers
        .handle(
          "getAutoCheckinWorkspaces",
          serviceOnly("workspaceConfig", "getAutoCheckinWorkspaces"),
        )
        .handle(
          "getWorkspaceConfig",
          guildQuery(
            "workspaceConfig",
            "getWorkspaceConfig",
            "manage",
            (query) => query.workspaceId,
          ),
        )
        .handle(
          "upsertWorkspaceConfig",
          guildPayload(
            "workspaceConfig",
            "upsertWorkspaceConfig",
            "manage",
            (payload) => payload.workspaceId,
          ),
        )
        .handle(
          "getWorkspaceMonitorRoles",
          guildQuery(
            "workspaceConfig",
            "getWorkspaceMonitorRoles",
            "member",
            (query) => query.workspaceId,
          ),
        )
        .handle(
          "getWorkspaceFeatureFlags",
          serviceOnly("workspaceConfig", "getWorkspaceFeatureFlags"),
        )
        .handle(
          "getWorkspacesForFeatureFlag",
          serviceOnly("workspaceConfig", "getWorkspacesForFeatureFlag"),
        )
        .handle(
          "getWorkspaceUpdateAnnouncementDelivery",
          serviceOnly("workspaceConfig", "getWorkspaceUpdateAnnouncementDelivery"),
        )
        .handle(
          "getWorkspaceConversations",
          guildQuery(
            "workspaceConfig",
            "getWorkspaceConversations",
            "member",
            (query) => query.workspaceId,
          ),
        )
        .handle(
          "addWorkspaceMonitorRole",
          guildPayload(
            "workspaceConfig",
            "addWorkspaceMonitorRole",
            "manage",
            (payload) => payload.workspaceId,
          ),
        )
        .handle(
          "removeWorkspaceMonitorRole",
          guildPayload(
            "workspaceConfig",
            "removeWorkspaceMonitorRole",
            "manage",
            (payload) => payload.workspaceId,
          ),
        )
        .handle(
          "addWorkspaceFeatureFlag",
          serviceOnly("workspaceConfig", "addWorkspaceFeatureFlag"),
        )
        .handle(
          "removeWorkspaceFeatureFlag",
          serviceOnly("workspaceConfig", "removeWorkspaceFeatureFlag"),
        )
        .handle(
          "recordWorkspaceUpdateAnnouncementDelivery",
          serviceOnly("workspaceConfig", "recordWorkspaceUpdateAnnouncementDelivery"),
        )
        .handle(
          "claimWorkspaceUpdateAnnouncementDelivery",
          serviceOnly("workspaceConfig", "claimWorkspaceUpdateAnnouncementDelivery"),
        )
        .handle(
          "releaseWorkspaceUpdateAnnouncementDeliveryClaim",
          serviceOnly("workspaceConfig", "releaseWorkspaceUpdateAnnouncementDeliveryClaim"),
        )
        .handle(
          "upsertWorkspaceConversationConfig",
          guildPayload(
            "workspaceConfig",
            "upsertWorkspaceConversationConfig",
            "manage",
            (payload) => payload.workspaceId,
          ),
        )
        .handle(
          "getWorkspaceConversationById",
          guildQuery(
            "workspaceConfig",
            "getWorkspaceConversationById",
            "member",
            (query) => query.workspaceId,
          ),
        )
        .handle(
          "getWorkspaceConversationByName",
          guildQuery(
            "workspaceConfig",
            "getWorkspaceConversationByName",
            "member",
            (query) => query.workspaceId,
          ),
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
              typeof payload.data.workspaceId === "string" ? payload.data.workspaceId : undefined,
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
              typeof payload.data.workspaceId === "string" ? payload.data.workspaceId : undefined,
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
          "setMessageCheckinMemberCheckinAtIfUnset",
          authorizedSheetApis(
            "messageCheckin",
            "setMessageCheckinMemberCheckinAtIfUnset",
            ({ payload }) =>
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
              typeof payload.data.workspaceId === "string" ? payload.data.workspaceId : undefined,
            ),
          ),
        )
        .handle(
          "persistMessageRoomOrder",
          authorizedSheetApis("messageRoomOrder", "persistMessageRoomOrder", ({ payload }) =>
            requireRoomOrderUpsert(
              payload.messageId,
              typeof payload.data.workspaceId === "string" ? payload.data.workspaceId : undefined,
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
        )
        .handle(
          "claimMessageRoomOrderSend",
          authorizedSheetApis("messageRoomOrder", "claimMessageRoomOrderSend", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "completeMessageRoomOrderSend",
          authorizedSheetApis("messageRoomOrder", "completeMessageRoomOrderSend", ({ payload }) =>
            requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "releaseMessageRoomOrderSendClaim",
          authorizedSheetApis(
            "messageRoomOrder",
            "releaseMessageRoomOrderSendClaim",
            ({ payload }) => requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "claimMessageRoomOrderTentativeUpdate",
          authorizedSheetApis(
            "messageRoomOrder",
            "claimMessageRoomOrderTentativeUpdate",
            ({ payload }) => requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "releaseMessageRoomOrderTentativeUpdateClaim",
          authorizedSheetApis(
            "messageRoomOrder",
            "releaseMessageRoomOrderTentativeUpdateClaim",
            ({ payload }) => requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "claimMessageRoomOrderTentativePin",
          authorizedSheetApis(
            "messageRoomOrder",
            "claimMessageRoomOrderTentativePin",
            ({ payload }) => requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "completeMessageRoomOrderTentativePin",
          authorizedSheetApis(
            "messageRoomOrder",
            "completeMessageRoomOrderTentativePin",
            ({ payload }) => requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "releaseMessageRoomOrderTentativePinClaim",
          authorizedSheetApis(
            "messageRoomOrder",
            "releaseMessageRoomOrderTentativePinClaim",
            ({ payload }) => requireRoomOrderMonitor(payload.messageId),
          ),
        )
        .handle(
          "markMessageRoomOrderTentative",
          authorizedSheetApis("messageRoomOrder", "markMessageRoomOrderTentative", ({ payload }) =>
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
              typeof payload.data.workspaceId === "string" ? payload.data.workspaceId : undefined,
            ),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "monitor", (handlers) =>
      handlers
        .handle(
          "getMonitorMaps",
          guildQuery("monitor", "getMonitorMaps", "monitor", (query) => query.workspaceId),
        )
        .handle(
          "getByIds",
          guildQuery("monitor", "getByIds", "monitor", (query) => query.workspaceId),
        )
        .handle(
          "getByNames",
          guildQuery("monitor", "getByNames", "monitor", (query) => query.workspaceId),
        ),
    ),
    HttpApiBuilder.group(Api, "permissions", (handlers) =>
      handlers.handle(
        "getCurrentUserPermissions",
        Effect.fnUntraced(function* ({ query }) {
          const authorization = yield* AuthorizationService;
          const resolvedUser =
            typeof query.workspaceId === "string"
              ? yield* authorization.resolveCurrentWorkspaceUser(query.workspaceId)
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
          guildQuery("player", "getPlayerMaps", "monitor", (query) => query.workspaceId),
        )
        .handle(
          "getByIds",
          singlePlayerOrMonitor("player", "getByIds", (query) => ({
            guildId: query.workspaceId,
            ids: query.ids,
          })),
        )
        .handle(
          "getByNames",
          guildQuery("player", "getByNames", "monitor", (query) => query.workspaceId),
        )
        .handle(
          "getTeamsByIds",
          singlePlayerOrMonitor("player", "getTeamsByIds", (query) => ({
            guildId: query.workspaceId,
            ids: query.ids,
          })),
        )
        .handle(
          "getTeamsByNames",
          guildQuery("player", "getTeamsByNames", "monitor", (query) => query.workspaceId),
        ),
    ),
    HttpApiBuilder.group(Api, "roomOrder", (handlers) =>
      handlers.handle(
        "generate",
        guildPayload("roomOrder", "generate", "monitor", (payload) => payload.workspaceId),
      ),
    ),
    HttpApiBuilder.group(Api, "schedule", (handlers) =>
      handlers
        .handle(
          "getAllPopulatedSchedules",
          guildQuery(
            "schedule",
            "getAllPopulatedSchedules",
            "member",
            (query) => query.workspaceId,
          ),
        )
        .handle(
          "getDayPopulatedSchedules",
          guildQuery(
            "schedule",
            "getDayPopulatedSchedules",
            "member",
            (query) => query.workspaceId,
          ),
        )
        .handle(
          "getConversationPopulatedSchedules",
          guildQuery(
            "schedule",
            "getConversationPopulatedSchedules",
            "member",
            (query) => query.workspaceId,
          ),
        )
        .handle(
          "getDayPlayerSchedule",
          authorizedSheetApis("schedule", "getDayPlayerSchedule", ({ query }) =>
            requireDayPlayerSchedule(query.workspaceId, query.accountId),
          ),
        ),
    ),
    HttpApiBuilder.group(Api, "screenshot", (handlers) =>
      handlers.handle(
        "getScreenshot",
        guildQuery("screenshot", "getScreenshot", "monitor", (query) => query.workspaceId),
      ),
    ),
    HttpApiBuilder.group(Api, "sheet", (handlers) =>
      handlers
        .handle("getPlayers", serviceOnly("sheet", "getPlayers"))
        .handle("getMonitors", serviceOnly("sheet", "getMonitors"))
        .handle("getTeams", serviceOnly("sheet", "getTeams"))
        .handle("getAllSchedules", serviceOnly("sheet", "getAllSchedules"))
        .handle("getDaySchedules", serviceOnly("sheet", "getDaySchedules"))
        .handle("getConversationSchedules", serviceOnly("sheet", "getConversationSchedules"))
        .handle("getRangesConfig", serviceOnly("sheet", "getRangesConfig"))
        .handle("getTeamConfig", serviceOnly("sheet", "getTeamConfig"))
        .handle(
          "getEventConfig",
          guildQuery("sheet", "getEventConfig", "member", (query) => query.workspaceId),
        )
        .handle("getScheduleConfig", serviceOnly("sheet", "getScheduleConfig"))
        .handle("getRunnerConfig", serviceOnly("sheet", "getRunnerConfig")),
    ),
    HttpApiBuilder.group(Api, "application", (handlers) =>
      handlers.handle("getApplication", forwardSheetBot("application", "getApplication")),
    ),
    HttpApiBuilder.group(Api, "clientDelivery", (handlers) =>
      handlers
        .handle("sendMessage", ({ payload }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.sendMessage(payload.conversation, payload.message);
          }),
        )
        .handle("sendDirectMessage", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireService();
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.sendDirectMessage(payload.recipient, payload.message);
          }),
        )
        .handle("updateMessage", ({ payload }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.updateMessage(payload.messageRef, payload.message);
          }),
        )
        .handle("updateInteraction", ({ payload }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.updateInteraction(payload.interaction, payload.message);
          }),
        )
        .handle("pinMessage", ({ payload }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.pinMessage(payload.messageRef);
          }),
        )
        .handle("deleteMessage", ({ payload }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.deleteMessage(payload.messageRef);
          }),
        )
        .handle("listClients", () =>
          Effect.gen(function* () {
            yield* requireService();
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.listClients();
          }),
        )
        .handle("getWorkspace", ({ params }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.getWorkspace({
              client: { platform: params.platform, clientId: params.clientId },
              workspaceId: params.workspaceId,
            });
          }),
        )
        .handle("getConversations", ({ params }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.getConversations({
              client: { platform: params.platform, clientId: params.clientId },
              workspaceId: params.workspaceId,
            });
          }),
        )
        .handle("getMembers", ({ params }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.getMembers({
              client: { platform: params.platform, clientId: params.clientId },
              workspaceId: params.workspaceId,
            });
          }),
        )
        .handle("addMemberRole", ({ payload }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.addMemberRole(payload.workspace, payload.userId, payload.roleId);
          }),
        )
        .handle("removeMemberRole", ({ payload }) =>
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.removeMemberRole(
              payload.workspace,
              payload.userId,
              payload.roleId,
            );
          }),
        ),
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
          ({ params: { interactionToken }, payload }) =>
            Effect.gen(function* () {
              const client = yield* SheetBotForwardingClient;
              return yield* client.bot.updateOriginalInteractionResponseByPayload({
                interactionToken,
                payload,
              });
            }) as ReturnType<SheetBotProxyHandler<"bot", "updateOriginalInteractionResponse">>,
        )
        .handle(
          "updateOriginalInteractionResponseWithFiles",
          ({ params: { interactionToken }, payload }) =>
            Effect.gen(function* () {
              const client = yield* SheetBotForwardingClient;
              const fs = yield* FileSystem.FileSystem;
              const formData = yield* buildFileUploadFormData(payload, fs, interactionToken);
              return yield* client.bot.updateOriginalInteractionResponseWithFilesByPayload({
                payload: formData,
              });
            }) as ReturnType<
              SheetBotProxyHandler<"bot", "updateOriginalInteractionResponseWithFiles">
            >,
        )
        .handle("createPin", forwardSheetBot("bot", "createPin"))
        .handle("deleteMessage", forwardSheetBot("bot", "deleteMessage"))
        .handle("addGuildMemberRole", forwardSheetBot("bot", "addGuildMemberRole"))
        .handle("removeGuildMemberRole", forwardSheetBot("bot", "removeGuildMemberRole")),
    ),
    HttpApiBuilder.group(Api, "ingressBot", (handlers) =>
      handlers
        .handle(
          "updateOriginalInteractionResponse",
          ({ payload }) =>
            Effect.gen(function* () {
              const client = yield* SheetBotForwardingClient;
              return yield* client.bot.updateOriginalInteractionResponseByPayload(payload);
            }) as ReturnType<SheetBotProxyHandler<"bot", "updateOriginalInteractionResponse">>,
        )
        .handle(
          "updateOriginalInteractionResponseWithFiles",
          ({ payload }) =>
            Effect.gen(function* () {
              const client = yield* SheetBotForwardingClient;
              const fs = yield* FileSystem.FileSystem;
              const formData = yield* buildFileUploadFormData(
                payload,
                fs,
                payload.interactionToken,
              );
              return yield* client.bot.updateOriginalInteractionResponseWithFilesByPayload({
                payload: formData,
              });
            }) as ReturnType<
              SheetBotProxyHandler<"bot", "updateOriginalInteractionResponseWithFiles">
            >,
        ),
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
    SheetWorkflowsForwardingClient.layer,
    SheetBotForwardingClient.layer,
    ClientDeliveryForwardingClient.layer,
    ServiceStatusService.layer,
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
    Layer.merge(healthRoutesLayer),
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
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(configProviderLayer),
);

NodeRuntime.runMain(Effect.orDie(Layer.launch(MainLive)) as Effect.Effect<never, never, never>);
