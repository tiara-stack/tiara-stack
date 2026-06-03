import { HttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Context, Effect, Layer } from "effect";
import { SheetApisRpcAuthorization } from "sheet-ingress-api/middlewares/sheetApisRpcAuthorization/tag";
import { SheetWorkflowsRpcs } from "sheet-ingress-api/sheet-workflows-rpc";
import { config } from "@/config";
import { makeIngressRpcHeadersClientLayer } from "./rpcAuthorizationClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const sheetWorkflowsTokenPath = "/var/run/secrets/tokens/sheet-workflows-token";

export class SheetWorkflowsRpcClient extends Context.Service<SheetWorkflowsRpcClient>()(
  "SheetWorkflowsRpcClient",
  {
    make: Effect.gen(function* () {
      const baseUrl = yield* config.sheetWorkflowsBaseUrl;
      const httpClient = yield* HttpClient.HttpClient;
      const rpcUrl = `${baseUrl.replace(/\/$/, "")}/rpc`;

      return yield* RpcClient.make(SheetWorkflowsRpcs).pipe(
        Effect.provide(RpcClient.layerProtocolHttp({ url: rpcUrl })),
        Effect.provide(RpcSerialization.layerJson),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    }),
  },
) {
  static layer = Layer.effect(SheetWorkflowsRpcClient, this.make).pipe(
    Layer.provide(
      makeIngressRpcHeadersClientLayer(
        SheetApisRpcAuthorization,
        "SheetWorkflowsRpcClient.SheetApisRpcAuthorizationClient",
        { serviceTokenPath: sheetWorkflowsTokenPath },
      ),
    ),
    Layer.provide(SheetApisRpcTokens.layer),
  );
}
