// fallow-ignore-file code-duplication
import { HttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Context, Effect, Layer } from "effect";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetApisRpcs } from "sheet-ingress-api/sheet-apis-rpc";
import { config } from "@/config";
import { makeIngressRpcHeadersClientLayer } from "./rpcAuthorizationClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const sheetApisResource = "sheet-apis";

export class SheetApisRpcClient extends Context.Service<SheetApisRpcClient>()(
  "SheetApisRpcClient",
  {
    make: Effect.gen(function* () {
      const baseUrl = yield* config.sheetApisBaseUrl;
      const httpClient = yield* HttpClient.HttpClient;
      const rpcUrl = `${baseUrl.replace(/\/$/, "")}/rpc`;

      return yield* RpcClient.make(SheetApisRpcs).pipe(
        Effect.provide(RpcClient.layerProtocolHttp({ url: rpcUrl })),
        Effect.provide(RpcSerialization.layerJson),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    }),
  },
) {
  static layer = Layer.effect(SheetApisRpcClient, this.make).pipe(
    Layer.provide(
      makeIngressRpcHeadersClientLayer(
        SheetApisRpcAuthorization,
        "SheetApisRpcClient.SheetApisRpcAuthorizationClient",
        { serviceTokenResource: sheetApisResource },
      ),
    ),
    Layer.provide(SheetApisRpcTokens.layer),
  );
}
