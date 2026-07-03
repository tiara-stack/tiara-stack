import { Context, Layer } from "effect";
import { SheetApisHttpClient } from "./sheetApisHttpClient";

export class SheetApisForwardingClient extends Context.Service<SheetApisForwardingClient>()(
  "SheetApisForwardingClient",
  {
    make: SheetApisHttpClient,
  },
) {
  static layer = Layer.effect(SheetApisForwardingClient, this.make).pipe(
    Layer.provide(SheetApisHttpClient.layer),
  );
}
