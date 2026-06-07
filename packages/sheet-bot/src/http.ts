import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { DiscordREST } from "dfx";
import type * as Discord from "dfx/types";
import { DiscordApplication, DiscordLayer } from "dfx-discord-utils/discord";
import { DiscordApi } from "dfx-discord-utils/discord/api";
import {
  DiscordMessageRequestSchema,
  makeDiscordBotRestError,
  type DiscordBotRestError,
} from "dfx-discord-utils/discord/schema";
import { discordHttpApiHandlersLayer, handleBotRestError } from "dfx-discord-utils/discord/http";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { createServer } from "http";
import { cachesLayer } from "./discord/cache";
import { discordConfigLayer } from "./discord/config";
import { sheetBotHttpAuthorizationLayer } from "./middlewares/discordHttpAuthorization/live";

const UpdateOriginalInteractionResponseBodyPayloadSchema = Schema.Struct({
  interactionToken: Schema.String,
  payload: DiscordMessageRequestSchema,
});

const UpdateOriginalInteractionResponseWithFilesBodyPayloadSchema = Schema.Struct({
  interactionToken: Schema.String,
  payload: Schema.fromJsonString(DiscordMessageRequestSchema),
  files: Multipart.FilesSchema,
});

const disabledMentions = () => ({ parse: [] });

const withoutMessageMentions = <A extends object>(payload: A): A => ({
  ...payload,
  allowed_mentions: disabledMentions(),
});

const getObjectField = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;

const messageFromError = (message: string, error: unknown): string => {
  const detail = getObjectField(error, "message");
  return typeof detail === "string" ? `${message}: ${detail}` : message;
};

const handleFallbackPayloadError = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
  message: string,
): Effect.Effect<A, DiscordBotRestError, R> =>
  effect.pipe(
    Effect.mapError((error) =>
      makeDiscordBotRestError({
        message: messageFromError(message, error),
        status: 400,
      }),
    ),
  );

const botRestErrorStatuses = {
  DiscordBotBadRequestError: 400,
  DiscordBotUnauthorizedError: 401,
  DiscordBotForbiddenError: 403,
  DiscordBotNotFoundError: 404,
  DiscordBotUnprocessableError: 422,
  DiscordBotRateLimitedError: 429,
  DiscordBotUpstreamError: 502,
} satisfies Record<DiscordBotRestError["_tag"], number>;

const isDiscordBotRestError = (error: unknown): error is DiscordBotRestError => {
  const tag = getObjectField(error, "_tag");
  return typeof tag === "string" && tag in botRestErrorStatuses;
};

const statusFromBotRestError = (error: DiscordBotRestError): number =>
  error._tag === "DiscordBotUpstreamError" && typeof error.status === "number"
    ? error.status
    : botRestErrorStatuses[error._tag];

const botRestErrorResponse = (error: unknown) =>
  isDiscordBotRestError(error)
    ? HttpServerResponse.json(error, { status: statusFromBotRestError(error) })
    : Effect.fail(error);

const discordHandlersLayer = discordHttpApiHandlersLayer.pipe(
  Layer.provide(DiscordApplication.restLayer),
  Layer.provide(DiscordLayer),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide([discordConfigLayer, cachesLayer]),
);

const updateOriginalInteractionResponseFallbackLayer = HttpRouter.add(
  "PATCH",
  "/bot/interactions/original-response",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const application = yield* DiscordApplication;
    const rest = yield* DiscordREST;
    const body = yield* request.text.pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (error) => error,
        }),
      ),
      Effect.flatMap(
        Schema.decodeUnknownEffect(UpdateOriginalInteractionResponseBodyPayloadSchema),
      ),
      (effect) =>
        handleFallbackPayloadError(effect, "Invalid original interaction response request"),
    );

    const message = yield* handleBotRestError(
      rest.updateOriginalWebhookMessage(application.id, body.interactionToken, {
        payload: withoutMessageMentions(
          body.payload,
        ) as Discord.IncomingWebhookUpdateRequestPartial,
      }),
      "Failed to update original interaction response",
    );

    return HttpServerResponse.jsonUnsafe(message);
  }).pipe(Effect.catch(botRestErrorResponse)),
);

const updateOriginalInteractionResponseWithFilesFallbackLayer = HttpRouter.add(
  "PATCH",
  "/bot/interactions/original-response/files",
  Effect.gen(function* () {
    const application = yield* DiscordApplication;
    const rest = yield* DiscordREST;
    const fs = yield* FileSystem.FileSystem;
    const body = yield* handleFallbackPayloadError(
      HttpServerRequest.schemaBodyMultipart(
        UpdateOriginalInteractionResponseWithFilesBodyPayloadSchema,
      ),
      "Invalid original interaction response file request",
    );
    const files = yield* handleBotRestError(
      Effect.forEach(
        body.files,
        (file) =>
          fs.readFile(file.path).pipe(
            Effect.map(
              (content) =>
                new File([content as BlobPart], file.name, {
                  type: file.contentType,
                }),
            ),
          ),
        { concurrency: 2 },
      ),
      "Failed to prepare original interaction response files",
    );

    const message = yield* handleBotRestError(
      rest.withFiles(files)(
        rest.updateOriginalWebhookMessage(application.id, body.interactionToken, {
          payload: withoutMessageMentions(
            body.payload,
          ) as Discord.IncomingWebhookUpdateRequestPartial,
        }),
      ),
      "Failed to update original interaction response with files",
    );

    return HttpServerResponse.jsonUnsafe(message);
  }).pipe(Effect.catch(botRestErrorResponse)),
);

const apiRoutesLayer = Layer.provide(HttpApiBuilder.layer(DiscordApi), [discordHandlersLayer]).pipe(
  Layer.merge(updateOriginalInteractionResponseFallbackLayer),
  Layer.merge(updateOriginalInteractionResponseWithFilesFallbackLayer),
  Layer.provide(sheetBotHttpAuthorizationLayer),
  Layer.merge(HttpRouter.add("GET", "/live", HttpServerResponse.empty({ status: 200 }))),
  Layer.merge(HttpRouter.add("GET", "/ready", HttpServerResponse.empty({ status: 200 }))),
  Layer.provide(HttpRouter.layer),
);

export const httpLayer = HttpRouter.serve(apiRoutesLayer).pipe(
  HttpServer.withLogAddress,
  Layer.provide(DiscordApplication.restLayer),
  Layer.provide(DiscordLayer),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(discordConfigLayer),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);
