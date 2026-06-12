import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Cache, Context, Duration, Effect, Exit, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SheetIngressDiscordApi } from "sheet-ingress-api/api";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

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
          return yield* Effect.fail(new Error("Failed to create OAuth service token"));
        }

        return HttpClientRequest.bearerToken(request, Redacted.value(token));
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
    Layer.provide(SheetAuthClient.layer),
  );
}
