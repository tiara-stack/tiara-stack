import { HttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Context, Effect, Layer } from "effect";
import { SheetWorkflowsInternalApi } from "sheet-ingress-api/sheet-workflows-internal";
import { config } from "@/config";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { withIngressHttpHeaders } from "./rpcAuthorizationClient";

const sheetWorkflowsResource = "sheet-workflows";

interface SheetWorkflowsHttpClientShape {
  readonly dispatchWorkflows: HttpApiClient.ForApi<
    typeof SheetWorkflowsInternalApi
  >["dispatchWorkflows"];
}

export class SheetWorkflowsHttpClient extends Context.Service<
  SheetWorkflowsHttpClient,
  SheetWorkflowsHttpClientShape
>()("SheetWorkflowsHttpClient", {
  make: Effect.gen(function* () {
    const baseUrl = yield* config.sheetWorkflowsBaseUrl;
    const httpClient = yield* HttpClient.HttpClient;

    return yield* HttpApiClient.makeWith(SheetWorkflowsInternalApi, {
      httpClient: withIngressHttpHeaders(httpClient, {
        serviceTokenResource: sheetWorkflowsResource,
      }),
      baseUrl,
    });
  }),
}) {
  static layer = Layer.effect(SheetWorkflowsHttpClient, this.make).pipe(
    Layer.provide(SheetApisRpcTokens.layer),
  );
}
