import { previewHttpsServerLayer } from "./preview-https";
import { Context, Effect, FileSystem, Layer, Match, Schema, Scope } from "effect";
import {
  HttpRouter,
  HttpIncomingMessage,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import * as Stream from "effect/Stream";
import {
  PreviewGateway,
  PreviewGatewayApplicationTargetSchema,
  PreviewGatewayDependencyGroupSchema,
  PreviewGatewayError,
  PreviewGatewayProbeTargetSchema,
  previewGatewayMaxApplicationRequestBytes,
  previewGatewayMaxApplicationResponseBytes,
  type PreviewGatewayApi,
  type PreviewGatewayAdmission,
} from "./preview-gateway";

/** Private operator/owner protocol. Owner proof never travels to a selected runtime. */
export const PreviewGatewayProtocol = Schema.Union([
  Schema.TaggedStruct("RegisterProbe", {
    version: Schema.Literal(1),
    target: PreviewGatewayProbeTargetSchema,
    ownerIdentity: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("RegisterApplication", {
    version: Schema.Literal(1),
    target: PreviewGatewayApplicationTargetSchema,
    ownerIdentity: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("Grant", {
    version: Schema.Literal(1),
    hostname: Schema.NonEmptyString,
    ownerIdentity: Schema.NonEmptyString,
    userId: Schema.NonEmptyString,
    allowed: Schema.Boolean,
  }),
  Schema.TaggedStruct("Cleanup", {
    version: Schema.Literal(1),
    hostname: Schema.NonEmptyString,
    ownerIdentity: Schema.NonEmptyString,
  }),
]);

/** Invoke only from the controller's private authenticated administration boundary. */
export const dispatchPreviewGatewayProtocol = (gateway: PreviewGatewayApi, input: unknown) =>
  Schema.decodeUnknownEffect(PreviewGatewayProtocol)(input).pipe(
    Effect.mapError(() => new PreviewGatewayError({ reason: "invalid-request" })),
    Effect.flatMap((request) =>
      Match.value(request).pipe(
        Match.tag("RegisterProbe", ({ target, ownerIdentity }) =>
          gateway.register(target, ownerIdentity),
        ),
        Match.tag("RegisterApplication", ({ target, ownerIdentity }) =>
          gateway.register(target, ownerIdentity),
        ),
        Match.tag("Grant", ({ hostname, ownerIdentity, userId, allowed }) =>
          gateway
            .grant(hostname, ownerIdentity, userId, allowed)
            .pipe(Effect.as({ updated: true as const })),
        ),
        Match.tag("Cleanup", ({ hostname, ownerIdentity }) =>
          gateway.cleanup(hostname, ownerIdentity).pipe(Effect.as({ removed: true as const })),
        ),
        Match.exhaustive,
      ),
    ),
  );

const unavailable = () => new PreviewGatewayError({ reason: "unavailable" });
const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

const bridge = (
  admission: PreviewGatewayAdmission,
  request: HttpServerRequest.HttpServerRequest,
  upstreamOperation: Effect.Effect<Socket.Socket, PreviewGatewayError, Scope.Scope>,
  allowHmrRevisionTransition = false,
) =>
  Effect.gen(function* () {
    const guard = allowHmrRevisionTransition ? admission.guardApplicationSocket : admission.guard;
    // Authenticate and verify the exact target before accepting the browser upgrade.
    const upstream = yield* guard(upstreamOperation);
    const browser = yield* guard(request.upgrade.pipe(Effect.mapError(unavailable)));
    const writeUpstream = yield* upstream.writer;
    const writeBrowser = yield* browser.writer;
    const fenced = admission.fenced.pipe(
      Effect.andThen(
        writeBrowser(new Socket.CloseEvent(1008, "Preview unavailable")).pipe(Effect.ignore),
      ),
    );
    yield* Effect.raceFirst(
      Effect.raceFirst(
        browser.runRaw((frame) => guard(writeUpstream(frame))),
        upstream.runRaw((frame) => guard(writeBrowser(frame))),
      ),
      fenced,
    ).pipe(
      Effect.ensuring(
        Effect.all(
          [
            writeBrowser(new Socket.CloseEvent(1008, "Preview unavailable")).pipe(Effect.ignore),
            writeUpstream(new Socket.CloseEvent(1008, "Preview unavailable")).pipe(Effect.ignore),
          ],
          { discard: true },
        ),
      ),
    );
    return HttpServerResponse.empty();
  });

const permitsProbeOrigin = (
  request: HttpServerRequest.HttpServerRequest,
  host: string,
  upgrade: boolean,
) => {
  const origin = request.headers.origin;
  return (
    !(upgrade && origin === undefined) &&
    (origin === undefined || origin === `https://${host}`) &&
    request.headers["sec-fetch-site"] !== "cross-site"
  );
};

const isSafeApplicationDocumentNavigation = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
) =>
  (request.method === "GET" || request.method === "HEAD") &&
  path.split("?")[0] === "/" &&
  request.headers["sec-fetch-mode"]?.toLowerCase() === "navigate" &&
  request.headers["sec-fetch-dest"]?.toLowerCase() === "document" &&
  request.headers.upgrade === undefined;

const permitsApplicationFetchSite = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
) => {
  const site = request.headers["sec-fetch-site"]?.toLowerCase();
  return (
    site === undefined ||
    site === "same-origin" ||
    site === "none" ||
    (isSafeApplicationDocumentNavigation(request, path) &&
      !isApplicationDependencyNamespacePath(path))
  );
};
const permitsApplicationRequest = (
  request: HttpServerRequest.HttpServerRequest,
  host: string,
  upgrade: boolean,
  path: string,
) =>
  isSafeApplicationDocumentNavigation(request, path) ||
  (permitsProbeOrigin(request, host, upgrade) && permitsApplicationFetchSite(request, path));

const maxApplicationRequestBytes = previewGatewayMaxApplicationRequestBytes;
const maxApplicationResponseBytes = previewGatewayMaxApplicationResponseBytes;
const allowedApplicationMethods = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const applicationRequestHeaderNames = [
  "accept",
  "accept-language",
  "content-type",
  "if-modified-since",
  "if-none-match",
] as const;
const safeApplicationRequestHeaders = (input: Readonly<Record<string, string | undefined>>) => {
  const output: Record<string, string> = {};
  for (const name of applicationRequestHeaderNames) {
    const value = input[name];
    if (value !== undefined && value.length <= 4096 && !/[\r\n]/.test(value)) output[name] = value;
  }
  return output;
};
const safeApplicationSocketHeaders = (input: Readonly<Record<string, string | undefined>>) => {
  const output = safeApplicationRequestHeaders(input);
  if (input["sec-websocket-protocol"] === "vite-hmr") output["sec-websocket-protocol"] = "vite-hmr";
  return output;
};
const containsControlCharacter = (value: string) => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
};
const hasUnsafeApplicationPathSyntax = (value: string) =>
  value.startsWith("//") || value.includes("\\") || containsControlCharacter(value);
const isSafeApplicationPath = (path: string, decoded: string) =>
  !hasUnsafeApplicationPathSyntax(path) &&
  !hasUnsafeApplicationPathSyntax(decoded) &&
  !decoded.split("/").includes("..");
const applicationPath = (url: string) => {
  try {
    const parsed = new URL(url, "https://preview.invalid");
    const path =
      parsed.pathname === "/_preview/app/__vite_hmr"
        ? parsed.pathname
        : parsed.pathname.replace(/^\/_preview\/app(?=\/|$)/, "") || "/";
    const decoded = decodeURIComponent(path);
    return isSafeApplicationPath(path, decoded) ? `${path}${parsed.search}` : undefined;
  } catch {
    return undefined;
  }
};
const applicationDependencyPath = (path: string) => {
  try {
    const url = new URL(path, "https://preview.invalid");
    const prefix = "/_preview/dependencies/";
    if (!url.pathname.startsWith(prefix)) return undefined;
    const remainder = url.pathname.slice(prefix.length);
    const separator = remainder.indexOf("/");
    const groupName = separator === -1 ? remainder : remainder.slice(0, separator);
    const group = Schema.decodeUnknownOption(PreviewGatewayDependencyGroupSchema)(groupName);
    if (group._tag === "None") return undefined;
    const rest = separator === -1 ? "/" : remainder.slice(separator);
    return { group: group.value, path: `${rest}${url.search}` };
  } catch {
    return undefined;
  }
};
const isApplicationDependencyNamespacePath = (path: string) => {
  try {
    const pathname = new URL(path, "https://preview.invalid").pathname;
    const decoded = decodeURIComponent(pathname);
    return [pathname, decoded].some(
      (candidate) =>
        candidate === "/_preview/dependencies" || candidate.startsWith("/_preview/dependencies/"),
    );
  } catch {
    return false;
  }
};
const boundedStream = (body: Stream.Stream<Uint8Array, PreviewGatewayError>, maxBytes: number) => {
  let size = 0;
  return body.pipe(
    Stream.mapEffect((chunk) => {
      size += chunk.byteLength;
      return size > maxBytes
        ? Effect.fail(new PreviewGatewayError({ reason: "payload-too-large" }))
        : Effect.succeed(chunk);
    }),
  );
};
const boundedBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const length = Number(request.headers["content-length"]);
    if (Number.isSafeInteger(length) && length > maxApplicationRequestBytes)
      return yield* Effect.fail(new PreviewGatewayError({ reason: "payload-too-large" }));
    const context = yield* Effect.context();
    const limited = Context.add(
      context,
      HttpIncomingMessage.MaxBodySize,
      FileSystem.Size(maxApplicationRequestBytes),
    );
    return boundedStream(
      Stream.provideContext(request.stream.pipe(Stream.mapError(unavailable)), limited),
      maxApplicationRequestBytes,
    );
  });
const safeApplicationResponseHeaders = (input: Readonly<Record<string, string>>) => {
  const output: Record<string, string> = { ...noStore };
  const normalized = new Map(
    Object.entries(input).map(([name, value]) => [name.toLowerCase(), value]),
  );
  for (const name of ["content-type", "etag", "last-modified"] as const) {
    const value = normalized.get(name);
    if (value !== undefined && value.length <= 4096 && !/[\r\n]/.test(value)) output[name] = value;
  }
  return output;
};
const applicationRequestBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.method === "GET" || request.method === "HEAD"
    ? Effect.succeed(undefined)
    : boundedBody(request);
const applicationResponse = (
  request: HttpServerRequest.HttpServerRequest,
  response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Stream.Stream<Uint8Array, PreviewGatewayError>;
  },
) => {
  if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599)
    return HttpServerResponse.empty({ status: 502, headers: noStore });
  const declaredLength = Number(
    Object.entries(response.headers).find(([name]) => name.toLowerCase() === "content-length")?.[1],
  );
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxApplicationResponseBytes)
    return HttpServerResponse.empty({ status: 502, headers: noStore });
  const headers = safeApplicationResponseHeaders(response.headers);
  if (request.method === "HEAD" || [204, 205, 304].includes(response.status))
    return HttpServerResponse.empty({ status: response.status, headers });
  return HttpServerResponse.stream(boundedStream(response.body, maxApplicationResponseBytes), {
    status: response.status,
    headers,
  });
};
const forwardApplicationHttp = (
  admission: PreviewGatewayAdmission,
  request: HttpServerRequest.HttpServerRequest,
  path: string,
) =>
  Effect.gen(function* () {
    const body = yield* applicationRequestBody(request);
    const response = yield* admission.applicationRequest({
      method: request.method,
      path,
      headers: safeApplicationRequestHeaders(request.headers),
      ...(body === undefined ? {} : { body }),
    });
    return applicationResponse(request, response);
  });
const forwardApplicationDependencyHttp = (
  admission: PreviewGatewayAdmission,
  request: HttpServerRequest.HttpServerRequest,
  dependency: NonNullable<ReturnType<typeof applicationDependencyPath>>,
) =>
  Effect.gen(function* () {
    const body = yield* applicationRequestBody(request);
    const response = yield* admission.applicationDependencyRequest(dependency.group, {
      method: request.method,
      path: dependency.path,
      headers: safeApplicationRequestHeaders(request.headers),
      ...(body === undefined ? {} : { body }),
    });
    return applicationResponse(request, response);
  });

const previewProbeRequestFor = (
  gateway: PreviewGatewayApi,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const host = request.headers.host;
    if (request.method !== "GET" || host === undefined || !/^[a-z0-9.-]+$/.test(host))
      return HttpServerResponse.empty({ status: 400, headers: noStore });
    const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
    if (!permitsProbeOrigin(request, host, upgrade))
      return HttpServerResponse.empty({ status: 403, headers: noStore });
    if (
      request.url !== "/_preview/probe" ||
      request.headers["sec-websocket-protocol"] !== undefined
    )
      return HttpServerResponse.empty({ status: 400, headers: noStore });
    const admission = yield* gateway.open({ hostname: host, headers: request.headers });
    if (upgrade) return yield* bridge(admission, request, admission.connection.socket);
    const body = yield* admission.guard(admission.connection.http(admission.headers));
    return HttpServerResponse.text(body, { headers: noStore });
  }).pipe(
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503, headers: noStore }))),
  );

const forwardApplicationRequest = (
  admission: PreviewGatewayAdmission,
  request: HttpServerRequest.HttpServerRequest,
  path: string,
  upgrade: boolean,
) => {
  const dependency = applicationDependencyPath(path);
  if (dependency === undefined && isApplicationDependencyNamespacePath(path))
    return Effect.succeed(HttpServerResponse.empty({ status: 503, headers: noStore }));
  if (dependency !== undefined) {
    if (upgrade) {
      const socket = admission.applicationDependencySocket(dependency.group, {
        path: dependency.path,
        headers: safeApplicationSocketHeaders(request.headers),
      });
      return bridge(admission, request, socket);
    }
    return forwardApplicationDependencyHttp(admission, request, dependency);
  }
  if (upgrade) {
    const socket = admission.applicationSocket({
      path,
      headers: safeApplicationSocketHeaders(request.headers),
      principal: admission.principal,
    });
    return bridge(admission, request, socket, path.split("?")[0] === "/_preview/app/__vite_hmr");
  }
  return forwardApplicationHttp(admission, request, path);
};

const applicationRequestFor = (
  gateway: PreviewGatewayApi,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    if (new URL(request.url, "https://preview.invalid").pathname === "/_preview/probe")
      return yield* previewProbeRequestFor(gateway, request);
    const path = applicationPath(request.url);
    if (path === undefined) return HttpServerResponse.empty({ status: 400, headers: noStore });
    const host = request.headers.host;
    const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
    if (
      host === undefined ||
      !/^[a-z0-9.-]+$/.test(host) ||
      !permitsApplicationRequest(request, host, upgrade, path)
    )
      return HttpServerResponse.empty({ status: 403, headers: noStore });
    if (!allowedApplicationMethods.has(request.method))
      return HttpServerResponse.empty({ status: 405, headers: noStore });
    const admission = yield* gateway.open({ hostname: host, headers: request.headers, path });
    if (admission.readiness.application !== "ready")
      return HttpServerResponse.empty({ status: 503, headers: noStore });
    return yield* forwardApplicationRequest(admission, request, path, upgrade);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.empty({
          status:
            error instanceof PreviewGatewayError && error.reason === "payload-too-large"
              ? 413
              : 503,
          headers: noStore,
        }),
      ),
    ),
  );
const applicationRequest = (gateway: PreviewGatewayApi) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* applicationRequestFor(gateway, request);
  }).pipe(
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503, headers: noStore }))),
  );

/** Session-host root and explicit application alias share one authenticated route target. */
export const PreviewGatewayHttpRoutes = (gateway: PreviewGatewayApi) =>
  HttpRouter.add("*", "*", applicationRequest(gateway));

/** Only a TLS listener is exposed. DNS/certificate provisioning is operator-owned. */
export const PreviewGatewayHttpsLive = (options: {
  readonly host: string;
  readonly port: number;
  readonly certificate: string;
  readonly privateKey: string;
}) =>
  HttpRouter.serve(
    Layer.unwrap(
      Effect.gen(function* () {
        const gateway = yield* PreviewGateway;
        return PreviewGatewayHttpRoutes(gateway).pipe(Layer.provideMerge(HttpRouter.layer));
      }),
    ),
  ).pipe(HttpServer.withLogAddress, Layer.provide(previewHttpsServerLayer(options)));
