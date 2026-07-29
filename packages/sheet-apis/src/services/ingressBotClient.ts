import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Cache, Context, Duration, Effect, Exit, Layer, Predicate, Redacted, Schema } from "effect";
import type { ChannelPermissionOverwrite } from "dfx-discord-utils/discord/schema";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SheetIngressDiscordApi } from "sheet-ingress-api/api";
import { DiscordGuildChannel, DiscordGuildRole } from "sheet-ingress-api/schemas/discord";
import { makeArgumentError } from "typhoon-core/error";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";
import * as Data from "effect/Data";

class SheetApisServicesIngressBotClientError extends Data.TaggedError(
  "SheetApisServicesIngressBotClientError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type CachedGuildResource = {
  readonly resourceId: string;
  readonly value: unknown;
};

const decodeResourceList = <A>(
  label: string,
  schema: Schema.Decoder<A>,
  values: ReadonlyArray<unknown>,
) =>
  Effect.forEach(values, (value) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((error) =>
        makeArgumentError(`Invalid ${label} data returned by the Discord cache`, error),
      ),
    ),
  );

const resourceField = (value: unknown, field: PropertyKey) =>
  Predicate.hasProperty(value, field) ? value[field] : undefined;

const loadGuildResources = <A, E, R>(
  workspaceId: string,
  resourceName: string,
  label: string,
  schema: Schema.Decoder<A>,
  load: Effect.Effect<ReadonlyArray<CachedGuildResource>, E, R>,
  mapEntry: (entry: CachedGuildResource) => unknown,
) =>
  load.pipe(
    Effect.mapError((error) =>
      makeArgumentError(`Failed to load ${resourceName} for workspace ${workspaceId}`, error),
    ),
    Effect.flatMap((entries) => decodeResourceList(label, schema, entries.map(mapEntry))),
  );

export const makeGuildResourceOperations = <
  ChannelsError,
  RolesError,
  ReplaceSuccess,
  ReplaceError,
>(client: {
  readonly cache: {
    readonly getChannelsForParent: (request: {
      readonly params: { readonly parentId: string };
    }) => Effect.Effect<ReadonlyArray<CachedGuildResource>, ChannelsError>;
    readonly getRolesForParent: (request: {
      readonly params: { readonly parentId: string };
    }) => Effect.Effect<ReadonlyArray<CachedGuildResource>, RolesError>;
  };
  readonly bot: {
    readonly replaceChannelPermissionOverwrites: (request: {
      readonly params: { readonly channelId: string };
      readonly payload: {
        readonly permissionOverwrites: ReadonlyArray<typeof ChannelPermissionOverwrite.Type>;
      };
    }) => Effect.Effect<ReplaceSuccess, ReplaceError>;
  };
}) => ({
  getGuildChannels: Effect.fn("IngressBotClient.getGuildChannels")(function* (workspaceId: string) {
    return yield* loadGuildResources(
      workspaceId,
      "channels",
      "guild channel",
      DiscordGuildChannel,
      client.cache.getChannelsForParent({ params: { parentId: workspaceId } }),
      ({ resourceId, value }) => ({
        id: resourceId,
        name: resourceField(value, "name"),
        type: resourceField(value, "type"),
        parentId: resourceField(value, "parent_id") ?? null,
        position: resourceField(value, "position"),
      }),
    );
  }),
  getGuildRoles: Effect.fn("IngressBotClient.getGuildRoles")(function* (workspaceId: string) {
    return yield* loadGuildResources(
      workspaceId,
      "roles",
      "guild role",
      DiscordGuildRole,
      client.cache.getRolesForParent({ params: { parentId: workspaceId } }),
      ({ resourceId, value }) => ({
        id: resourceId,
        name: resourceField(value, "name"),
        position: resourceField(value, "position"),
        color: resourceField(value, "color"),
        managed: resourceField(value, "managed"),
      }),
    );
  }),
  replaceChannelPermissionOverwrites: Effect.fn(
    "IngressBotClient.replaceChannelPermissionOverwrites",
  )(function* (
    channelId: string,
    permissionOverwrites: ReadonlyArray<typeof ChannelPermissionOverwrite.Type>,
  ) {
    return yield* client.bot.replaceChannelPermissionOverwrites({
      params: { channelId },
      payload: { permissionOverwrites },
    });
  }),
});

type TokenCacheEntry = {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly timeToLive: Duration.Duration;
  readonly failed: boolean;
};

export class IngressBotClient extends Context.Service<IngressBotClient>()("IngressBotClient", {
  make: Effect.gen(function* () {
    const baseUrl = yield* config.sheetIngressBaseUrl;
    const sheetAuthClient = yield* SheetAuthClient;
    const baseHttpClient = yield* HttpClient.HttpClient;
    const oauthClientId = yield* config.sheetAuthOAuthClientId;
    const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;

    const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
      Effect.fn("IngressBotClient.lookupServiceToken")(() =>
        createOAuthClientCredentialsToken(sheetAuthClient, {
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          scope: ["service"],
          resource: "sheet-ingress",
        }).pipe(
          Effect.tap(() => Effect.logDebug("Using OAuth service token for ingress bot client")),
          Effect.map((oauthToken) => ({
            token: oauthToken.accessToken,
            timeToLive: Duration.max(
              Duration.seconds(oauthToken.expiresAt - Math.floor(Date.now() / 1000) - 60),
              Duration.seconds(15),
            ),
            failed: false,
          })),
          Effect.matchEffect({
            onSuccess: (entry) => Effect.succeed(entry),
            onFailure: (error) =>
              Effect.logError(
                "Failed to create OAuth service token for ingress bot client",
                error,
              ).pipe(
                Effect.as({
                  token: undefined,
                  timeToLive: Duration.minutes(1),
                  failed: true,
                }),
              ),
          }),
        ),
      ),
      {
        capacity: 1,
        timeToLive: Exit.match({
          onFailure: () => Duration.minutes(1),
          onSuccess: ({ timeToLive }) => timeToLive,
        }),
      },
    );

    const httpClient = HttpClient.mapRequestEffect(
      baseHttpClient,
      Effect.fnUntraced(function* (request) {
        const { failed, token } = yield* Cache.get(tokenCache, DISCORD_SERVICE_USER_ID_SENTINEL);

        if (failed || !token) {
          return yield* new SheetApisServicesIngressBotClientError({
            message: "Failed to create OAuth service token",
          });
        }

        return HttpClientRequest.bearerToken(request, Redacted.value(token));
      }),
    ) as unknown as HttpClient.HttpClient;

    const client = yield* HttpApiClient.makeWith(SheetIngressDiscordApi, {
      baseUrl,
      httpClient,
    });

    const guildResourceOperations = makeGuildResourceOperations(client);

    return {
      listClients: Effect.fn("IngressBotClient.listClients")(function* () {
        return yield* client.clientDelivery.listClients({});
      }),
      sendMessage: Effect.fn("IngressBotClient.sendMessage")(function* (
        channelId: string,
        payload: Parameters<typeof client.bot.sendMessage>[0]["payload"],
      ) {
        return yield* client.bot.sendMessage({
          params: { channelId },
          payload,
        });
      }),
      updateMessage: Effect.fn("IngressBotClient.updateMessage")(function* (
        channelId: string,
        messageId: string,
        payload: Parameters<typeof client.bot.updateMessage>[0]["payload"],
      ) {
        return yield* client.bot.updateMessage({
          params: { channelId, messageId },
          payload,
        });
      }),
      updateOriginalInteractionResponse: Effect.fn(
        "IngressBotClient.updateOriginalInteractionResponse",
      )(function* (
        interactionToken: string,
        payload: Parameters<
          typeof client.ingressBot.updateOriginalInteractionResponse
        >[0]["payload"]["payload"],
      ) {
        return yield* client.ingressBot.updateOriginalInteractionResponse({
          payload: { interactionToken, payload },
        });
      }),
      createPin: Effect.fn("IngressBotClient.createPin")(function* (
        channelId: string,
        messageId: string,
      ) {
        return yield* client.bot.createPin({
          params: { channelId, messageId },
        });
      }),
      addGuildMemberRole: Effect.fn("IngressBotClient.addGuildMemberRole")(function* (
        guildId: string,
        userId: string,
        roleId: string,
      ) {
        return yield* client.bot.addGuildMemberRole({
          params: { guildId, userId, roleId },
        });
      }),
      ...guildResourceOperations,
    };
  }),
}) {
  static layer = Layer.effect(IngressBotClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}
