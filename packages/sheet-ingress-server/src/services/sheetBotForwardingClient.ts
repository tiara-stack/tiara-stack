import { Context, Effect, Layer } from "effect";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetBotHttpClient } from "./sheetBotHttpClient";

export class SheetBotForwardingClient extends Context.Service<SheetBotForwardingClient>()(
  "SheetBotForwardingClient",
  {
    make: Effect.gen(function* () {
      const httpClient = yield* SheetBotHttpClient;

      return {
        application: httpClient.application,
        bot: httpClient.bot,
        cache: httpClient.cache,
      };
    }),
  },
) {
  static layer = Layer.effect(SheetBotForwardingClient, this.make).pipe(
    Layer.provide(SheetBotHttpClient.layer.pipe(Layer.provide(SheetApisRpcTokens.layer))),
  );
}
