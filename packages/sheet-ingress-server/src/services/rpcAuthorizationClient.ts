import { Array, Effect, HashSet, pipe, Redacted } from "effect";
import { Headers } from "effect/unstable/http";
import { RpcMiddleware } from "effect/unstable/rpc";
import { SheetAuthUser } from "sheet-ingress-api/schemas/middlewares/sheetAuthUser";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

interface IngressRpcHeadersConfig {
  readonly serviceTokenPath: string;
}

export const getIngressRpcHeaders = Effect.fn("RpcAuthorizationClient.getIngressRpcHeaders")(
  function* ({ serviceTokenPath }: IngressRpcHeadersConfig) {
    const tokens = yield* SheetApisRpcTokens;
    const token = yield* tokens.getServiceToken(serviceTokenPath);
    let headers = Headers.set(Headers.empty, "x-sheet-ingress-auth", `Bearer ${token}`);
    const maybeUser = yield* Effect.serviceOption(SheetAuthUser);

    if (maybeUser._tag === "None") {
      return headers;
    }

    const user = maybeUser.value;
    headers = pipe(
      headers,
      Headers.set("x-sheet-auth-user-id", user.userId),
      Headers.set("x-sheet-auth-account-id", user.accountId),
      Headers.set("x-sheet-auth-permissions", Array.fromIterable(user.permissions).join(",")),
    );

    if (!HashSet.has(user.permissions, "service") && user.accountId !== "anonymous") {
      headers = Headers.set(
        headers,
        "x-sheet-auth-session-token",
        `Bearer ${Redacted.value(user.token)}`,
      );
    }

    return headers;
  },
);

const makeRpcHeadersClientLayer = <Id extends RpcMiddleware.AnyService, R>(
  tag: Id,
  name: string,
  getHeaders: () => Effect.Effect<Headers.Headers, unknown, R>,
) =>
  RpcMiddleware.layerClient(
    tag,
    Effect.fn(name)(function* ({ request, next }) {
      const headers = yield* getHeaders();
      return yield* next({
        ...request,
        headers: Headers.merge(request.headers, headers),
      });
    }),
  );

export const makeIngressRpcHeadersClientLayer = <Id extends RpcMiddleware.AnyService>(
  tag: Id,
  name: string,
  config: IngressRpcHeadersConfig,
) => makeRpcHeadersClientLayer(tag, name, () => getIngressRpcHeaders(config));
