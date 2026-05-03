import { NodeFileSystem } from "@effect/platform-node";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import {
  Cache,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  pipe,
  Redacted,
  Ref,
  Schedule,
} from "effect";
import { createKubernetesOAuthSession } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/plugins/kubernetes-oauth";
import { SheetIngressDiscordApi } from "sheet-ingress-api/api";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

const sheetAuthTokenPath = "/var/run/secrets/tokens/sheet-auth-token";

type TokenCacheEntry = {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly timeToLive: Duration.Duration;
};

export class IngressBotClient extends Context.Service<IngressBotClient>()("IngressBotClient", {
  make: Effect.gen(function* () {
    const baseUrl = yield* config.sheetIngressBaseUrl;
    const fs = yield* FileSystem.FileSystem;
    const sheetAuthClient = yield* SheetAuthClient;
    const baseHttpClient = yield* HttpClient.HttpClient;
    const k8sTokenRef = yield* Ref.make("");

    const refreshK8sToken = pipe(
      fs.readFileString(sheetAuthTokenPath, "utf-8"),
      Effect.map((token) => token.trim()),
      Effect.flatMap((token) => Ref.set(k8sTokenRef, token)),
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }),
      Effect.catch((error) =>
        Effect.logWarning("Failed to read sheet-auth Kubernetes token", error),
      ),
    );

    yield* refreshK8sToken;
    yield* refreshK8sToken.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped);

    const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
      Effect.fn("IngressBotClient.lookupServiceToken")(function* (serviceUserId) {
        const k8sToken = yield* Ref.get(k8sTokenRef);
        const session = yield* createKubernetesOAuthSession(
          sheetAuthClient,
          serviceUserId,
          k8sToken,
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to create service-user auth session", error).pipe(
              Effect.as(undefined),
            ),
          ),
        );
        const now = yield* DateTime.now;
        const timeToLive = session?.session?.expiresAt
          ? Duration.max(
              pipe(
                DateTime.distance(now, session.session.expiresAt),
                Duration.subtract(Duration.seconds(60)),
              ),
              Duration.seconds(15),
            )
          : Duration.minutes(1);

        return {
          token: session?.token,
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
        const { token } = yield* Cache.get(tokenCache, DISCORD_SERVICE_USER_ID_SENTINEL);

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
        payload: Parameters<typeof client.bot.updateOriginalInteractionResponse>[0]["payload"],
      ) {
        return yield* client.bot.updateOriginalInteractionResponse({
          params: { interactionToken },
          payload,
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
    Layer.provide([SheetAuthClient.layer, NodeFileSystem.layer]),
  );
}
