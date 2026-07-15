import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Context, Data, Effect, Layer, Predicate } from "effect";
import { DiscordApi } from "dfx-discord-utils/discord/api";
import {
  DiscordMessageSchema,
  type DiscordMessageRequestSchema,
  type DiscordBotRestError,
  makeDiscordBotRestError,
} from "dfx-discord-utils/discord/schema";
import { Unauthorized } from "typhoon-core/error";
import { config } from "@/config";
import { getIngressRpcHeaders } from "./rpcAuthorizationClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const sheetBotResource = "sheet-bot";

const isResponseError = Predicate.or(
  Predicate.isTagged("StatusCodeError"),
  Predicate.or(Predicate.isTagged("DecodeError"), Predicate.isTagged("EmptyBodyError")),
);

const mapDiscordBotHttpError = <Error>(
  error: Error,
): Exclude<Error, HttpClientError.HttpClientError> | DiscordBotRestError =>
  HttpClientError.isHttpClientError(error)
    ? makeDiscordBotRestError({
        message: "Sheet bot HTTP request failed",
        status: isResponseError(error.reason) ? error.reason.response.status : undefined,
      })
    : (error as Exclude<Error, HttpClientError.HttpClientError>);

// NOTE: This is a single-target HTTP client that uses SHEET_BOT_BASE_URL.
// It intentionally targets the primary bot instance. For multi-client routing,
// use ClientDeliveryForwardingClient with ClientRegistry instead.
// This client is used for: authorization cache reads, bot proxy, and application-owner lookup.

class MissingInteractionTokenError extends Data.TaggedError("MissingInteractionTokenError")<{
  readonly message: string;
}> {}

export class SheetBotHttpClient extends Context.Service<SheetBotHttpClient>()(
  "SheetBotHttpClient",
  {
    make: Effect.gen(function* () {
      const baseUrl = yield* config.sheetBotBaseUrl;
      const baseHttpClient = yield* HttpClient.HttpClient;
      const tokens = yield* SheetApisRpcTokens;
      const httpClient = HttpClient.mapRequestEffect(baseHttpClient, (request) =>
        getIngressRpcHeaders({ serviceTokenResource: sheetBotResource }).pipe(
          Effect.provideService(SheetApisRpcTokens, tokens),
          Effect.map((headers) => HttpClientRequest.setHeaders(request, headers)),
          Effect.mapError(
            (error) =>
              new Unauthorized({
                message: "Failed to create ingress forwarding OAuth token",
                cause: error,
              }),
          ),
        ),
      );

      const client = yield* HttpApiClient.makeWith(DiscordApi, {
        baseUrl,
        httpClient,
      });
      return {
        ...client,
        bot: {
          ...client.bot,
          updateOriginalInteractionResponseByPayload: ({
            interactionToken,
            payload,
          }: {
            readonly interactionToken: string;
            readonly payload: typeof DiscordMessageRequestSchema.Type;
          }) =>
            Effect.gen(function* () {
              if (interactionToken.trim().length === 0) {
                return yield* new MissingInteractionTokenError({
                  message: "Missing interaction token",
                });
              }
              const url = new URL(
                "bot/interactions/original-response",
                baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
              );

              return yield* HttpClientRequest.patch(url.toString()).pipe(
                HttpClientRequest.bodyJson({ interactionToken, payload }),
                Effect.flatMap(httpClient.execute),
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(HttpClientResponse.schemaBodyJson(DiscordMessageSchema)),
                Effect.mapError(mapDiscordBotHttpError),
              );
            }),
          updateOriginalInteractionResponseWithFilesByPayload: ({
            payload,
          }: {
            readonly payload: FormData;
          }) => {
            const interactionToken = payload.get("interactionToken");
            if (typeof interactionToken !== "string" || interactionToken.trim().length === 0) {
              return Effect.fail(
                new MissingInteractionTokenError({ message: "Missing interaction token" }),
              );
            }
            const url = new URL(
              "bot/interactions/original-response/files",
              baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
            );

            return HttpClientRequest.patch(url.toString()).pipe(
              HttpClientRequest.bodyFormData(payload),
              httpClient.execute,
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(HttpClientResponse.schemaBodyJson(DiscordMessageSchema)),
              Effect.mapError(mapDiscordBotHttpError),
            );
          },
          updateOriginalInteractionResponseWithFiles: ({
            params,
            payload,
          }: {
            readonly params: { readonly interactionToken: string };
            readonly payload: FormData;
          }) =>
            Effect.gen(function* () {
              if (params.interactionToken.trim().length === 0) {
                return yield* new MissingInteractionTokenError({
                  message: "Missing interaction token",
                });
              }
              const url = new URL(
                `bot/interactions/${encodeURIComponent(
                  params.interactionToken,
                )}/original-response/files`,
                baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
              );

              return yield* HttpClientRequest.patch(url.toString()).pipe(
                HttpClientRequest.bodyFormData(payload),
                httpClient.execute,
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(HttpClientResponse.schemaBodyJson(DiscordMessageSchema)),
                Effect.mapError(mapDiscordBotHttpError),
              );
            }),
        },
      };
    }),
  },
) {
  static layer = Layer.effect(SheetBotHttpClient, this.make);
}
