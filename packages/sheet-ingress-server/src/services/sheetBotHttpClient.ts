import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Context, Data, Effect, Layer } from "effect";
import { DiscordApi } from "dfx-discord-utils/discord/api";
import { DiscordMessageSchema } from "dfx-discord-utils/discord/schema";
import { config } from "@/config";
import { getIngressRpcHeaders } from "./rpcAuthorizationClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const sheetBotTokenPath = "/var/run/secrets/tokens/sheet-bot-token";

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
        getIngressRpcHeaders({ serviceTokenPath: sheetBotTokenPath }).pipe(
          Effect.provideService(SheetApisRpcTokens, tokens),
          Effect.map((headers) => HttpClientRequest.setHeaders(request, headers)),
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
          updateOriginalInteractionResponseWithFiles: ({
            params,
            payload,
          }: {
            readonly params: { readonly interactionToken: string };
            readonly payload: FormData;
          }) =>
            Effect.gen(function* () {
              if (params.interactionToken.trim().length === 0) {
                return yield* Effect.fail(
                  new MissingInteractionTokenError({ message: "Missing interaction token" }),
                );
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
              );
            }),
        },
      };
    }),
  },
) {
  static layer = Layer.effect(SheetBotHttpClient, this.make);
}
