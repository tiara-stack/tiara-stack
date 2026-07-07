import { Context, Effect, Layer } from "effect";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetBotHttpClient } from "./sheetBotHttpClient";

type SheetBotHttpClientShape = typeof SheetBotHttpClient.Service;

interface SheetBotForwardingClientShape {
  readonly application: SheetBotHttpClientShape["application"];
  readonly bot: SheetBotHttpClientShape["bot"];
  readonly cache: SheetBotHttpClientShape["cache"];
}

export class SheetBotForwardingClient extends Context.Service<
  SheetBotForwardingClient,
  SheetBotForwardingClientShape
>()("SheetBotForwardingClient", {
  make: Effect.gen(function* () {
    const httpClient = yield* SheetBotHttpClient;

    return {
      application: httpClient.application,
      bot: httpClient.bot,
      cache: httpClient.cache,
    };
  }),
}) {
  static layer = Layer.effect(SheetBotForwardingClient, this.make).pipe(
    Layer.provide(SheetBotHttpClient.layer.pipe(Layer.provide(SheetApisRpcTokens.layer))),
  );
}
