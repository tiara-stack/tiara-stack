import { NodeFileSystem } from "@effect/platform-node";
import { DiscordMessageRequestSchema } from "dfx-discord-utils/discord/schema";
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
  Schema,
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

type MessagePayload = Schema.Schema.Type<typeof DiscordMessageRequestSchema>;
type DiscordMessage = {
  readonly id: string;
  readonly channel_id: string;
};
type MessageFilePayload = {
  readonly name: string;
  readonly contentType: string;
  readonly content: Uint8Array;
};

type DiscordClient = {
  readonly bot: {
    readonly sendMessage: (args: {
      readonly params: { readonly channelId: string };
      readonly payload: MessagePayload;
    }) => Effect.Effect<DiscordMessage, unknown>;
    readonly updateMessage: (args: {
      readonly params: { readonly channelId: string; readonly messageId: string };
      readonly payload: MessagePayload;
    }) => Effect.Effect<DiscordMessage, unknown>;
    readonly updateOriginalInteractionResponse: (args: {
      readonly params: { readonly interactionToken: string };
      readonly payload: MessagePayload;
    }) => Effect.Effect<DiscordMessage, unknown>;
    readonly createPin: (args: {
      readonly params: { readonly channelId: string; readonly messageId: string };
    }) => Effect.Effect<unknown, unknown>;
    readonly deleteMessage: (args: {
      readonly params: { readonly channelId: string; readonly messageId: string };
    }) => Effect.Effect<unknown, unknown>;
    readonly addGuildMemberRole: (args: {
      readonly params: {
        readonly guildId: string;
        readonly userId: string;
        readonly roleId: string;
      };
    }) => Effect.Effect<unknown, unknown>;
    readonly removeGuildMemberRole: (args: {
      readonly params: {
        readonly guildId: string;
        readonly userId: string;
        readonly roleId: string;
      };
    }) => Effect.Effect<unknown, unknown>;
  };
  readonly ingressBot: {
    readonly updateOriginalInteractionResponse: (args: {
      readonly payload: {
        readonly interactionToken: string;
        readonly payload: MessagePayload;
      };
    }) => Effect.Effect<DiscordMessage, unknown>;
    readonly updateOriginalInteractionResponseWithFiles: (args: {
      readonly payload: FormData;
    }) => Effect.Effect<DiscordMessage, unknown>;
  };
  readonly cache: {
    readonly getGuild: (args: {
      readonly params: { readonly resourceId: string };
    }) => Effect.Effect<
      {
        readonly value: {
          readonly id: string;
          readonly name: string;
        };
      },
      unknown
    >;
    readonly getChannelsForParent: (args: {
      readonly params: { readonly parentId: string };
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly parentId: string;
        readonly resourceId: string;
        readonly value: {
          readonly id: string;
          readonly type: number;
          readonly guild_id?: string;
          readonly name?: string;
          readonly position?: number;
        };
      }>,
      unknown
    >;
    readonly getMembersForParent: (args: {
      readonly params: { readonly parentId: string };
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly parentId: string;
        readonly resourceId: string;
        readonly value: {
          readonly user: { readonly id: string };
          readonly roles: ReadonlyArray<string>;
        };
      }>,
      unknown
    >;
  };
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
      Effect.withSpan("IngressBotClient.refreshK8sToken", { attributes: { baseUrl } }),
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

        const entry = {
          token: session?.token,
          timeToLive,
        };
        yield* Effect.annotateCurrentSpan({
          serviceUserId,
          tokenAvailable: entry.token !== undefined,
          timeToLiveMillis: Duration.toMillis(entry.timeToLive),
        });
        return entry;
      }),
      {
        capacity: 1,
        timeToLive: Exit.match({
          onFailure: () => Duration.minutes(1),
          onSuccess: ({ timeToLive }) => timeToLive,
        }),
      },
    );

    const httpClient = HttpClient.mapRequestEffect(baseHttpClient, (request) =>
      Effect.gen(function* () {
        const { token } = yield* Cache.get(tokenCache, DISCORD_SERVICE_USER_ID_SENTINEL);

        yield* Effect.annotateCurrentSpan({ tokenAvailable: token !== undefined });
        return token ? HttpClientRequest.bearerToken(request, Redacted.value(token)) : request;
      }).pipe(Effect.withSpan("IngressBotClient.mapAuthRequest")),
    ) as unknown as HttpClient.HttpClient;

    const client = (yield* HttpApiClient.makeWith(SheetIngressDiscordApi as never, {
      baseUrl,
      httpClient,
    }).pipe(
      Effect.withSpan("IngressBotClient.makeWith", { attributes: { baseUrl } }),
    )) as DiscordClient;

    return {
      sendMessage: Effect.fn("IngressBotClient.sendMessage")(function* (
        channelId: string,
        payload: MessagePayload,
      ) {
        yield* Effect.annotateCurrentSpan({ channelId });
        return yield* client.bot.sendMessage({
          params: { channelId },
          payload,
        });
      }),
      updateMessage: Effect.fn("IngressBotClient.updateMessage")(function* (
        channelId: string,
        messageId: string,
        payload: MessagePayload,
      ) {
        yield* Effect.annotateCurrentSpan({ channelId, messageId });
        return yield* client.bot.updateMessage({
          params: { channelId, messageId },
          payload,
        });
      }),
      updateOriginalInteractionResponse: Effect.fn(
        "IngressBotClient.updateOriginalInteractionResponse",
      )(function* (interactionToken: string, payload: MessagePayload) {
        yield* Effect.annotateCurrentSpan({ hasInteractionToken: interactionToken.length > 0 });
        return yield* client.ingressBot.updateOriginalInteractionResponse({
          payload: { interactionToken, payload },
        });
      }),
      updateOriginalInteractionResponseWithFiles: Effect.fn(
        "IngressBotClient.updateOriginalInteractionResponseWithFiles",
      )(function* (
        interactionToken: string,
        payload: MessagePayload,
        files: ReadonlyArray<MessageFilePayload>,
      ) {
        yield* Effect.annotateCurrentSpan({
          hasInteractionToken: interactionToken.length > 0,
          fileCount: files.length,
        });
        const formData = new FormData();
        formData.append("interactionToken", interactionToken);
        formData.append("payload", JSON.stringify(payload));
        for (const file of files) {
          formData.append(
            "files",
            new File([file.content as BlobPart], file.name, {
              type: file.contentType,
            }),
          );
        }
        return yield* client.ingressBot.updateOriginalInteractionResponseWithFiles({
          payload: formData,
        });
      }),
      createPin: Effect.fn("IngressBotClient.createPin")(function* (
        channelId: string,
        messageId: string,
      ) {
        yield* Effect.annotateCurrentSpan({ channelId, messageId });
        return yield* client.bot.createPin({
          params: { channelId, messageId },
        });
      }),
      deleteMessage: Effect.fn("IngressBotClient.deleteMessage")(function* (
        channelId: string,
        messageId: string,
      ) {
        yield* Effect.annotateCurrentSpan({ channelId, messageId });
        return yield* client.bot.deleteMessage({
          params: { channelId, messageId },
        });
      }),
      addGuildMemberRole: Effect.fn("IngressBotClient.addGuildMemberRole")(function* (
        guildId: string,
        userId: string,
        roleId: string,
      ) {
        yield* Effect.annotateCurrentSpan({ guildId, userId, roleId });
        return yield* client.bot.addGuildMemberRole({
          params: { guildId, userId, roleId },
        });
      }),
      removeGuildMemberRole: Effect.fn("IngressBotClient.removeGuildMemberRole")(function* (
        guildId: string,
        userId: string,
        roleId: string,
      ) {
        yield* Effect.annotateCurrentSpan({ guildId, userId, roleId });
        return yield* client.bot.removeGuildMemberRole({
          params: { guildId, userId, roleId },
        });
      }),
      getGuild: Effect.fn("IngressBotClient.getGuild")(function* (guildId: string) {
        yield* Effect.annotateCurrentSpan({ resourceId: guildId });
        const response = yield* client.cache.getGuild({
          params: { resourceId: guildId },
        });
        return response.value;
      }),
      getMembersForParent: Effect.fn("IngressBotClient.getMembersForParent")(function* (
        guildId: string,
      ) {
        yield* Effect.annotateCurrentSpan({ parentId: guildId });
        return yield* client.cache.getMembersForParent({
          params: { parentId: guildId },
        });
      }),
      getChannelsForParent: Effect.fn("IngressBotClient.getChannelsForParent")(function* (
        guildId: string,
      ) {
        yield* Effect.annotateCurrentSpan({ parentId: guildId });
        return yield* client.cache.getChannelsForParent({
          params: { parentId: guildId },
        });
      }),
    };
  }),
}) {
  static layer = Layer.effect(IngressBotClient, this.make).pipe(
    Layer.provide([SheetAuthClient.layer, NodeFileSystem.layer]),
  );
}
