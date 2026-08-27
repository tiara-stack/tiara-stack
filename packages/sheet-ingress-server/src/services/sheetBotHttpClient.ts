import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Context, Data, Effect, Layer } from "effect";
import { DiscordApi } from "dfx-discord-utils/discord/api";
import type { DiscordMessageRequestSchema } from "dfx-discord-utils/discord/schema";
import { Unauthorized } from "typhoon-core/error";
import { config } from "@/config";
import { getIngressRpcHeaders } from "./rpcAuthorizationClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const sheetBotResource = "sheet-bot";

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
              return yield* client.bot.updateOriginalInteractionResponse({
                params: { interactionToken },
                payload,
              });
            }),
        },
      };
    }),
  },
) {
  static layer = Layer.effect(SheetBotHttpClient, this.make);
}
