import { previewHttpsServerLayer } from "./preview-https";
import { Effect, Layer, Match, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import {
  PreviewGateway,
  PreviewGatewayError,
  PreviewGatewayTargetSchema,
  type PreviewGatewayApi,
  type PreviewGatewayAdmission,
} from "./preview-gateway";

/** Private operator/owner protocol. Owner proof never travels to a selected runtime. */
export const PreviewGatewayProtocol = Schema.Union([
  Schema.TaggedStruct("RegisterProbe", {
    version: Schema.Literal(1),
    target: PreviewGatewayTargetSchema,
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

const bridge = (admission: PreviewGatewayAdmission, request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    // Authenticate and verify the exact target before accepting the browser upgrade.
    const upstream = yield* admission.guard(admission.connection.socket);
    const browser = yield* admission.guard(request.upgrade.pipe(Effect.mapError(unavailable)));
    const writeUpstream = yield* upstream.writer;
    const writeBrowser = yield* browser.writer;
    const fenced = admission.fenced.pipe(
      Effect.andThen(
        writeBrowser(new Socket.CloseEvent(1008, "Preview unavailable")).pipe(Effect.ignore),
      ),
    );
    yield* Effect.raceFirst(
      Effect.raceFirst(
        browser.runRaw((frame) => admission.guard(writeUpstream(frame))),
        upstream.runRaw((frame) => admission.guard(writeBrowser(frame))),
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

/** Probe-only HTTPS/WSS handlers. Arbitrary application paths remain unavailable. */
export const PreviewGatewayHttpRoutes = (gateway: PreviewGatewayApi) =>
  HttpRouter.add(
    "GET",
    "/_preview/probe",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const host = request.headers.host;
      if (host === undefined || !/^[a-z0-9.-]+$/.test(host))
        return HttpServerResponse.empty({ status: 400, headers: noStore });
      const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
      // WSS always requires exact Origin; normal top-level navigation may omit it.
      if (!permitsProbeOrigin(request, host, upgrade))
        return HttpServerResponse.empty({ status: 403, headers: noStore });
      // Query strings cannot carry credentials, destination overrides, or stale queue IDs.
      if (
        request.url !== "/_preview/probe" ||
        request.headers["sec-websocket-protocol"] !== undefined
      )
        return HttpServerResponse.empty({ status: 400, headers: noStore });
      const admission = yield* gateway.open({ hostname: host, headers: request.headers });
      if (upgrade) return yield* bridge(admission, request);
      const body = yield* admission.guard(admission.connection.http(admission.headers));
      // No upstream Set-Cookie, Location, CORS, or authentication headers are forwarded.
      return HttpServerResponse.text(body, { headers: noStore });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.empty({ status: 503, headers: noStore })),
      ),
    ),
  );

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
