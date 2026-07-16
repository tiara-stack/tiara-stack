import { HttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Context, Effect, Layer } from "effect";
import { SheetApisInternalApi } from "sheet-ingress-api/internal";
import { config } from "@/config";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { withIngressHttpHeaders } from "./rpcAuthorizationClient";

const sheetApisResource = "sheet-apis";

export class SheetApisHttpClient extends Context.Service<SheetApisHttpClient>()(
  "SheetApisHttpClient",
  {
    make: Effect.gen(function* () {
      const baseUrl = yield* config.sheetApisBaseUrl;
      const httpClient = yield* HttpClient.HttpClient;

      return yield* HttpApiClient.makeWith(SheetApisInternalApi, {
        httpClient: withIngressHttpHeaders(httpClient, { serviceTokenResource: sheetApisResource }),
        baseUrl,
      });
    }),
  },
) {
  static layer = Layer.effect(SheetApisHttpClient, this.make).pipe(
    Layer.provide(SheetApisRpcTokens.layer),
  );
}
