import { Context, Effect, FileSystem, Layer, Match, Predicate, Schema, Stream } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { PreviewAuthError, type PreviewAuthBinding, type PreviewAuthApi } from "./preview-auth";

const previewCookie = "__Host-preview-session";
const stateCookie = "__Host-preview-oauth-state";
const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const cookies = (header: string | undefined) =>
  Object.fromEntries(
    (header ?? "").split(";").map((part) => {
      const index = part.indexOf("=");
      return index < 1 ? ["", ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
const unavailable = () => new PreviewAuthError({ reason: "unavailable" });
const maximumProxyRequestBodyBytes = 1024 * 1024;
const isAllowedPreviewHost = (
  host: string | undefined,
  origin: string | undefined,
): host is string => {
  if (!Predicate.isString(host)) return false;
  return Predicate.and(
    (value: string) => /^[a-z0-9.-]+$/.test(value),
    (value: string) => origin === undefined || origin === `https://${value}`,
  )(host);
};
const previewCredential = (cookieHeader: string | undefined) => {
  return decodeCookieValue(cookies(cookieHeader)[previewCookie]);
};
const decodeCookieValue = (value: string | undefined) => {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};
const safeApplicationHeaders = (headers: Readonly<Record<string, string>>) => {
  const safe: Record<string, string> = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  for (const key of ["content-type", "etag"]) {
    const value = headers[key];
    if (value && !/[\r\n]/.test(value)) safe[key] = value;
  }
  return safe;
};
const applicationResponse = (
  response: { readonly status: number; readonly body: string },
  headers: Readonly<Record<string, string>>,
) =>
  [204, 205, 304].includes(response.status)
    ? HttpServerResponse.empty({ status: response.status, headers })
    : HttpServerResponse.text(response.body, { status: response.status, headers });
const applicationErrorStatus = (error: unknown) =>
  Predicate.isTagged("PreviewAuthError")(error) && Predicate.hasProperty(error, "reason")
    ? Match.value(error.reason).pipe(
        Match.when("denied", () => 403),
        Match.when("stale-session", () => 403),
        Match.when("unauthorized", () => 401),
        Match.when("invalid-request", () => 400),
        Match.when("payload-too-large", () => 413),
        Match.orElse(() => 503),
      )
    : 503;
const readBoundedRequestBody = (request: HttpServerRequest.HttpServerRequest, maxBytes: number) =>
  Effect.gen(function* () {
    if (Predicate.hasProperty(request.source, "body") && request.source.body === null) return "";
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes)
      return yield* Effect.fail(new PreviewAuthError({ reason: "payload-too-large" }));
    const decoder = new TextDecoder();
    const body = yield* request.stream.pipe(
      Stream.runFoldEffect(
        () => ({ text: "", size: 0 }),
        (accumulator, chunk) => {
          const size = accumulator.size + chunk.byteLength;
          if (size > maxBytes)
            return Effect.fail(new PreviewAuthError({ reason: "payload-too-large" }));
          return Effect.succeed({
            text: accumulator.text + decoder.decode(chunk, { stream: true }),
            size,
          });
        },
      ),
      Effect.mapError((error) =>
        Predicate.isTagged("PreviewAuthError")(error) ? error : unavailable(),
      ),
    );
    return body.text + decoder.decode();
  });

/** Request identity is resolved from the verified gateway host and durable route, never browser fields. */
export const PreviewAuthHttpRoutes = (
  auth: PreviewAuthApi,
  resolve: (
    hostname: string,
  ) => Effect.Effect<
    { readonly binding: PreviewAuthBinding; readonly returnUrl: string },
    PreviewAuthError
  >,
  callbackPath: HttpRouter.PathInput,
) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/_preview/auth/start",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const host = request.headers.host;
        if (!isAllowedPreviewHost(host, undefined))
          return HttpServerResponse.empty({ status: 400, headers: noStore });
        const { binding, returnUrl } = yield* resolve(host);
        const result = yield* auth.start({ binding, origin: `https://${host}`, returnUrl });
        return yield* HttpServerResponse.setCookie(
          HttpServerResponse.empty({
            status: 302,
            headers: { ...noStore, location: result.authorizationUrl },
          }),
          stateCookie,
          result.stateCookie,
          { path: "/", maxAge: "5 minutes", secure: true, httpOnly: true, sameSite: "lax" },
        );
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.empty({ status: 503, headers: noStore })),
        ),
      ),
    ),
    HttpRouter.add(
      "GET",
      callbackPath,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const host = request.headers.host;
        if (!isAllowedPreviewHost(host, undefined))
          return HttpServerResponse.empty({ status: 400, headers: noStore });
        const url = new URL(request.url, `https://${host}`);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const stateCookieValue = decodeCookieValue(cookies(request.headers.cookie)[stateCookie]);
        if (!code || !state || stateCookieValue === undefined)
          return HttpServerResponse.empty({ status: 400, headers: noStore });
        const { binding } = yield* resolve(host);
        const result = yield* auth.callback({
          binding,
          stateCookie: stateCookieValue,
          state,
          code,
          origin: `https://${host}`,
        });
        const response = HttpServerResponse.empty({
          status: 302,
          headers: { ...noStore, location: result.returnUrl },
        });
        const withCredential = yield* HttpServerResponse.setCookie(
          response,
          previewCookie,
          result.credential,
          { path: "/", maxAge: "15 minutes", secure: true, httpOnly: true, sameSite: "lax" },
        );
        return yield* HttpServerResponse.expireCookie(withCredential, stateCookie, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
        });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.empty({ status: 403, headers: noStore })),
        ),
      ),
    ),
    HttpRouter.add(
      "OPTIONS",
      "/_preview/app/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const host = request.headers.host;
        const origin = request.headers.origin;
        if (!isAllowedPreviewHost(host, origin) || origin === undefined)
          return HttpServerResponse.empty({ status: 403, headers: noStore });
        return HttpServerResponse.empty({
          status: 204,
          headers: {
            ...noStore,
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, accept, if-none-match",
            vary: "Origin",
          },
        });
      }),
    ),
    HttpRouter.add("GET", "/_preview/app/*", appRequest(auth, resolve)),
    HttpRouter.add("POST", "/_preview/app/*", appRequest(auth, resolve)),
    HttpRouter.add("PUT", "/_preview/app/*", appRequest(auth, resolve)),
    HttpRouter.add("PATCH", "/_preview/app/*", appRequest(auth, resolve)),
    HttpRouter.add("DELETE", "/_preview/app/*", appRequest(auth, resolve)),
  );

const RequestHeadersSchema = Schema.Record(Schema.String, Schema.optional(Schema.String));
const isAllowedApplicationOrigin = (request: HttpServerRequest.HttpServerRequest) => {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!isAllowedPreviewHost(host, origin)) return false;
  if (origin !== undefined) return true;
  const fetchSite = request.headers["sec-fetch-site"];
  return (
    request.method === "GET" &&
    (fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none")
  );
};
const readApplicationBody = (
  request: HttpServerRequest.HttpServerRequest,
  maxBodySize: number,
  routeContext: Context.Context<never>,
) =>
  request.method === "GET"
    ? Effect.succeed(undefined)
    : readBoundedRequestBody(request, maxBodySize).pipe(Effect.provideContext(routeContext));
const prepareApplicationRequest = (
  request: HttpServerRequest.HttpServerRequest,
  resolve: (
    hostname: string,
  ) => Effect.Effect<
    { readonly binding: PreviewAuthBinding; readonly returnUrl: string },
    PreviewAuthError
  >,
  maxBodySize: number,
  routeContext: Context.Context<never>,
  host: string,
) =>
  Effect.gen(function* () {
    const origin = request.headers.origin;
    if (!isAllowedApplicationOrigin(request))
      return yield* Effect.fail(new PreviewAuthError({ reason: "denied" }));
    const credential = previewCredential(request.headers.cookie);
    if (!credential) return yield* Effect.fail(new PreviewAuthError({ reason: "unauthorized" }));
    const { binding } = yield* resolve(host);
    const url = new URL(request.url, `https://${host}`);
    const body = yield* readApplicationBody(request, maxBodySize, routeContext);
    const headers = yield* Schema.decodeUnknownEffect(RequestHeadersSchema)(request.headers).pipe(
      Effect.mapError(() => unavailable()),
    );
    return {
      binding,
      credential,
      origin: origin ?? `https://${host}`,
      method: request.method,
      path: `${url.pathname.replace(/^\/_preview\/app(?=\/|$)/, "") || "/"}${url.search}`,
      headers,
      ...(body === undefined ? {} : { body }),
    } satisfies Parameters<PreviewAuthApi["request"]>[0];
  });

function appRequest(
  auth: PreviewAuthApi,
  resolve: Parameters<typeof prepareApplicationRequest>[1],
) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const context = yield* Effect.context();
    const inheritedLimit = Context.get(context, HttpIncomingMessage.MaxBodySize);
    const maxBodySize =
      inheritedLimit === undefined || Number(inheritedLimit) > maximumProxyRequestBodyBytes
        ? FileSystem.Size(maximumProxyRequestBodyBytes)
        : inheritedLimit;
    const routeContext = Context.add(context, HttpIncomingMessage.MaxBodySize, maxBodySize);
    const input = yield* prepareApplicationRequest(
      request,
      resolve,
      Number(maxBodySize),
      routeContext,
      request.headers.host ?? "",
    );
    const response = yield* auth.request(input);
    const safeHeaders = {
      ...safeApplicationHeaders(response.headers),
      "access-control-allow-origin": `https://${request.headers.host}`,
      "access-control-allow-credentials": "true",
      vary: "Origin",
    };
    return applicationResponse(response, safeHeaders);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.empty({
          status: applicationErrorStatus(error),
          headers: noStore,
        }),
      ),
    ),
  );
}
