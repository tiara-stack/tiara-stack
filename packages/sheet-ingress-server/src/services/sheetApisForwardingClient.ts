import { Context, Effect, Layer } from "effect";
import { SheetApisHttpClient } from "./sheetApisHttpClient";

export class SheetApisForwardingClient extends Context.Service<SheetApisForwardingClient>()(
  "SheetApisForwardingClient",
  {
    make: Effect.gen(function* () {
      return yield* SheetApisHttpClient;
    }),
  },
) {
  static layer = Layer.effect(SheetApisForwardingClient, this.make).pipe(
    Layer.provide(SheetApisHttpClient.layer),
  );
}
