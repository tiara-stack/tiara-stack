import { Effect, Option, Redacted } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

interface IngressRpcHeadersConfig {
  readonly serviceTokenResource: string;
}

export const getIngressRpcHeaders = Effect.fn("RpcAuthorizationClient.getIngressRpcHeaders")(
  function* ({ serviceTokenResource }: IngressRpcHeadersConfig) {
    const tokens = yield* SheetApisRpcTokens;
    const maybeUser = yield* Effect.serviceOption(SheetAuthUser);
    const token = Option.isSome(maybeUser)
      ? yield* tokens.getDelegatedAuthorization({
          resource: serviceTokenResource,
          user: maybeUser.value,
        })
      : Redacted.make(yield* tokens.getServiceToken(serviceTokenResource));
    return Headers.set(Headers.empty, "authorization", `Bearer ${Redacted.value(token)}`);
  },
);

export const withIngressHttpHeaders = (
  httpClient: HttpClient.HttpClient,
  config: IngressRpcHeadersConfig,
) =>
  HttpClient.mapRequestEffect(httpClient, (request) =>
    Effect.gen(function* () {
      const headers = yield* getIngressRpcHeaders(config);
      return Object.entries(headers).reduce(
        (nextRequest, [key, value]) => HttpClientRequest.setHeader(nextRequest, key, value),
        request,
      );
    }),
  ) as unknown as HttpClient.HttpClient;
