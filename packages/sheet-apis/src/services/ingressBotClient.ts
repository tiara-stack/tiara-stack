import { NodeFileSystem } from "@effect/platform-node";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Cache, Context, Duration, Effect, Exit, Option, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { SheetIngressDiscordApi } from "sheet-ingress-api/api";
import { config } from "@/config";

type TokenCacheEntry = {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly timeToLive: Duration.Duration;
};

const sheetApiServiceAuthCacheKey = "sheet-apis-ingress-bot-service";

const toTokenCacheTTL = (expiresIn: number | undefined) =>
  expiresIn !== undefined && !Number.isNaN(expiresIn) && expiresIn > 0
    ? Duration.max(Duration.seconds(Math.max(Math.floor(expiresIn) - 60, 15)), Duration.seconds(15))
    : Duration.minutes(1);

export class IngressBotClient extends Context.Service<IngressBotClient>()("IngressBotClient", {
  make: Effect.gen(function* () {
    const baseUrl = yield* config.sheetIngressBaseUrl;
    const baseHttpClient = yield* HttpClient.HttpClient;
    const sheetAuthIssuer = yield* config.sheetAuthIssuer;
    const serviceClientId = yield* config.sheetServiceOAuthClientId;
    const serviceClientSecret = yield* config.sheetServiceOAuthClientSecret;

    if (Option.isNone(serviceClientId) || Option.isNone(serviceClientSecret)) {
      return yield* Effect.fail(
        new Error("OAuth service client credentials are not configured for sheet-apis"),
      );
    }

    const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
      Effect.fn("IngressBotClient.lookupServiceToken")(function* (_serviceUserId) {
        const issued = yield* createOAuthClientCredentialsToken(
          sheetAuthIssuer,
          serviceClientId.value,
          serviceClientSecret.value,
          "service",
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to create sheet-apis service auth token", error).pipe(
              Effect.as(undefined),
            ),
          ),
        );
        const timeToLive = toTokenCacheTTL(issued?.expiresIn);

        return {
          token: issued?.token,
          timeToLive,
        };
      }),
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
        const { token } = yield* Cache.get(tokenCache, sheetApiServiceAuthCacheKey);

        return token ? HttpClientRequest.bearerToken(request, Redacted.value(token)) : request;
      }),
    ) as unknown as HttpClient.HttpClient;

    const client = yield* HttpApiClient.makeWith(SheetIngressDiscordApi, {
      baseUrl,
      httpClient,
    });

    return {
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
    };
  }),
}) {
  static layer = Layer.effect(IngressBotClient, this.make).pipe(
    Layer.provide(NodeFileSystem.layer),
  );
}
