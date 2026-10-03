import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { getBearerToken } from "sheet-auth/oauth-resource-authorization";
import type { VerifiedOAuthResourceToken } from "sheet-auth/oauth-resource-authorization";
import {
  PreviewSessionController,
  PreviewWorkloadAdmissionSchema,
  PreviewSessionSchema,
  PreviewSessionError,
  type PreviewWorkloadAdmission,
  type PreviewSession,
  type PreviewSessionControllerApi,
} from "./preview-sessions";
import { connectedPreviewRoles } from "./types";

const AuthorityRequest = Schema.Struct({
  binding: Schema.Struct({
    sessionId: Schema.NonEmptyString,
    generation: Schema.Number,
    role: Schema.Literals(connectedPreviewRoles),
  }),
  clientId: Schema.NonEmptyString,
});
const ClientRequiresBindingRequest = Schema.Struct({ oauthClientId: Schema.NonEmptyString });
const CredentialAuthorizeRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  generation: Schema.Number,
  role: Schema.Literals(connectedPreviewRoles),
});
const CredentialRegisterRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  generation: Schema.Number,
  role: Schema.Literals(connectedPreviewRoles),
  reservationId: Schema.NonEmptyString,
  credentialName: Schema.NonEmptyString,
  serviceAccount: Schema.NonEmptyString,
  oauthClientId: Schema.NonEmptyString,
  credentialFile: Schema.NonEmptyString,
});
const CredentialIssueRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  generation: Schema.Number,
  role: Schema.Literals(connectedPreviewRoles),
});
const CredentialIssueReleaseRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  generation: Schema.Number,
  role: Schema.Literals(connectedPreviewRoles),
  reservationId: Schema.NonEmptyString,
});
const CredentialRemoveRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  generation: Schema.Number,
  role: Schema.Literals(connectedPreviewRoles),
  oauthClientId: Schema.NonEmptyString,
  serviceAccount: Schema.NonEmptyString,
});
const AdmitWorkloadRequest = Schema.Struct({
  groupId: Schema.NonEmptyString,
  invocationId: Schema.NonEmptyString,
  continuationId: Schema.NullOr(Schema.NonEmptyString),
  endpoint: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
});

export interface PreviewWorkloadAuthenticatedIdentity {
  readonly sessionId: string;
  readonly generation: number;
  readonly role: (typeof connectedPreviewRoles)[number];
  readonly oauthClientId: string;
}

export interface PreviewWorkloadResourceAuthorizer {
  readonly requireAuthorizedHeaders: (
    headers: Headers.Headers,
  ) => Effect.Effect<VerifiedOAuthResourceToken, unknown>;
}

/** Maps a verified, live-session OAuth token to the only workload admission identity accepted by the RPC. */
export const authenticatePreviewWorkload =
  (authorizer: PreviewWorkloadResourceAuthorizer) =>
  (
    headers: Headers.Headers,
  ): Effect.Effect<PreviewWorkloadAuthenticatedIdentity, PreviewSessionError> =>
    Effect.gen(function* () {
      const token = yield* authorizer
        .requireAuthorizedHeaders(headers)
        .pipe(
          Effect.mapError(() => new PreviewSessionError({ reason: "workload-token-unauthorized" })),
        );
      if (!token.previewSession || !token.clientId) {
        return yield* Effect.fail(
          new PreviewSessionError({ reason: "preview-workload-binding-required" }),
        );
      }
      const role = connectedPreviewRoles.find(
        (candidate) => candidate === token.previewSession?.role,
      );
      if (!role)
        return yield* Effect.fail(
          new PreviewSessionError({ reason: "unknown-preview-workload-role" }),
        );
      return {
        sessionId: token.previewSession.sessionId,
        generation: token.previewSession.generation,
        role,
        oauthClientId: token.clientId,
      };
    });

export interface PreviewSessionControllerHttpOptions {
  readonly authorityToken: Redacted.Redacted<string>;
  readonly administrationToken: Redacted.Redacted<string>;
  readonly authenticateWorkload: (
    headers: Headers.Headers,
  ) => Effect.Effect<PreviewWorkloadAuthenticatedIdentity, PreviewSessionError>;
}

const tokenMatches = (headers: Headers.Headers, expected: Redacted.Redacted<string>) => {
  const supplied =
    getBearerToken(Option.getOrUndefined(Headers.get(headers, "authorization"))) ?? "";
  const expectedToken = Redacted.value(expected);
  if (expectedToken.trim().length === 0) return false;
  const expectedBytes = Buffer.from(expectedToken);
  const suppliedBytes = Buffer.from(supplied);
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
};

const readBody = <A>(
  schema: Schema.Decoder<A, never>,
  request: HttpServerRequest.HttpServerRequest,
) =>
  HttpServerRequest.schemaBodyJson(schema).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.mapError(() => new Error("invalid-request-body")),
    Effect.match({
      onFailure: () => ({ ok: false as const }),
      onSuccess: (body) => ({ ok: true as const, body }),
    }),
  );

const unauthorized = () => HttpServerResponse.json({ error: "unauthorized" }, { status: 401 });
const forbidden = () => HttpServerResponse.json({ error: "forbidden" }, { status: 403 });
const badRequest = () =>
  HttpServerResponse.json({ error: "invalid-request-body" }, { status: 400 });
/** Internal RPC routes. Mount only on the HTTPS server layer below. */
export const PreviewSessionControllerHttpRoutes = (
  controller: PreviewSessionControllerApi,
  options: PreviewSessionControllerHttpOptions,
) => {
  if (
    Redacted.value(options.authorityToken).trim().length === 0 ||
    Redacted.value(options.administrationToken).trim().length === 0
  ) {
    throw new Error("Preview controller authority and administration tokens must be configured");
  }
  return Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/authorize",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!tokenMatches(request.headers, options.authorityToken)) return yield* unauthorized();
        const decoded = yield* readBody(AuthorityRequest, request);
        if (!decoded.ok) return yield* badRequest();
        const result = yield* Effect.result(
          controller.authorizeWorkload(
            decoded.body.binding.sessionId,
            decoded.body.binding.generation,
            decoded.body.binding.role,
            decoded.body.clientId,
          ),
        );
        return yield* HttpServerResponse.json({ authorized: result._tag === "Success" });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/client-requires-binding",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!tokenMatches(request.headers, options.authorityToken)) return yield* unauthorized();
        const decoded = yield* readBody(ClientRequiresBindingRequest, request);
        if (!decoded.ok) return yield* badRequest();
        const input = decoded.body;
        const result = yield* Effect.result(controller.isPreviewOAuthClient(input.oauthClientId));
        if (result._tag === "Failure") return yield* forbidden();
        return yield* HttpServerResponse.json({ required: result.success });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/credential/authorize",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!tokenMatches(request.headers, options.administrationToken))
          return yield* unauthorized();
        const decoded = yield* readBody(CredentialAuthorizeRequest, request);
        if (!decoded.ok) return yield* badRequest();
        const input = decoded.body;
        const result = yield* Effect.result(
          controller.authorizeCredential(input.id, input.generation, input.role),
        );
        if (result._tag === "Failure") return yield* forbidden();
        return yield* HttpServerResponse.json({ authorized: true, session: result.success });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/credential/issue/reserve",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!tokenMatches(request.headers, options.administrationToken))
          return yield* unauthorized();
        const decoded = yield* readBody(CredentialIssueRequest, request);
        if (!decoded.ok) return yield* badRequest();
        const input = decoded.body;
        const result = yield* Effect.result(
          controller.authorizeCredentialIssue(input.id, input.generation, input.role),
        );
        if (result._tag === "Failure") return yield* forbidden();
        return yield* HttpServerResponse.json({
          reservationId: result.success.reservationId,
          session: result.success.session,
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/credential/register",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!tokenMatches(request.headers, options.administrationToken))
          return yield* unauthorized();
        const decoded = yield* readBody(CredentialRegisterRequest, request);
        if (!decoded.ok) return yield* badRequest();
        const input = decoded.body;
        const result = yield* Effect.result(controller.registerCredentialIdentity(input));
        if (result._tag === "Failure") return yield* forbidden();
        return yield* HttpServerResponse.json({ registered: true });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/credential/issue/release",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!tokenMatches(request.headers, options.administrationToken))
          return yield* unauthorized();
        const decoded = yield* readBody(CredentialIssueReleaseRequest, request);
        if (!decoded.ok) return yield* badRequest();
        const input = decoded.body;
        const result = yield* Effect.result(controller.releaseCredentialIssue(input));
        if (result._tag === "Failure") return yield* forbidden();
        return yield* HttpServerResponse.json({ released: true });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/credential/removal/authorize",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!tokenMatches(request.headers, options.administrationToken))
          return yield* unauthorized();
        const decoded = yield* readBody(CredentialRemoveRequest, request);
        if (!decoded.ok) return yield* badRequest();
        const input = decoded.body;
        const result = yield* Effect.result(controller.authorizeCredentialRemoval(input));
        if (result._tag === "Failure") return yield* forbidden();
        return yield* HttpServerResponse.json({ authorized: true });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/credential/removal/complete",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!tokenMatches(request.headers, options.administrationToken))
          return yield* unauthorized();
        const decoded = yield* readBody(CredentialRemoveRequest, request);
        if (!decoded.ok) return yield* badRequest();
        const input = decoded.body;
        const result = yield* Effect.result(controller.removeCredentialIdentity(input));
        if (result._tag === "Failure") return yield* forbidden();
        return yield* HttpServerResponse.json({ removed: true });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/work/admit",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authentication = yield* Effect.result(options.authenticateWorkload(request.headers));
        if (authentication._tag === "Failure") return yield* unauthorized();
        const identity = authentication.success;
        const decoded = yield* readBody(AdmitWorkloadRequest, request);
        if (!decoded.ok) return yield* badRequest();
        const input = decoded.body;
        const admission = yield* Effect.result(controller.admitWorkload({ ...input, ...identity }));
        if (admission._tag === "Failure") return yield* forbidden();
        return yield* HttpServerResponse.json(admission.success, { status: 202 });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/_internal/preview/v1/work/settle",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const decoded = yield* readBody(PreviewWorkloadAdmissionSchema, request);
        if (!decoded.ok) return yield* badRequest();
        const admission = decoded.body;
        // The unpredictable admission ID is a one-time capability so accepted work can settle
        // after its session token has been fenced. The controller matches every original field.
        if (!tokenMatches(request.headers, Redacted.make(admission.admissionId)))
          return yield* unauthorized();
        const result = yield* Effect.result(controller.settleWorkload(admission));
        if (result._tag === "Failure") return yield* forbidden();
        return yield* HttpServerResponse.json({
          settled: true,
          admissionId: admission.admissionId,
        });
      }),
    ),
  );
};

/** Starts the controller RPC server with HTTPS. No plaintext server constructor is exported. */
export const PreviewSessionControllerHttpsLive = (
  options: PreviewSessionControllerHttpOptions & {
    readonly host: string;
    readonly port: number;
    readonly certificate: string;
    readonly privateKey: string;
  },
) => {
  const routes = Layer.unwrap(
    Effect.gen(function* () {
      const controller = yield* PreviewSessionController;
      return PreviewSessionControllerHttpRoutes(controller, options).pipe(
        Layer.provideMerge(HttpRouter.layer),
      );
    }),
  );
  return HttpRouter.serve(routes).pipe(
    HttpServer.withLogAddress,
    Layer.provide(
      NodeHttpServer.layer(
        () => createHttpsServer({ cert: options.certificate, key: options.privateKey }),
        { host: options.host, port: options.port },
      ),
    ),
  );
};

export class PreviewSessionControllerHttpClientError extends Schema.TaggedErrorClass<PreviewSessionControllerHttpClientError>()(
  "PreviewSessionControllerHttpClientError",
  { reason: Schema.String },
) {}

export interface PreviewSessionControllerHttpClientApi {
  readonly authorizeCredential: (
    id: string,
    generation: number,
    role: PreviewWorkloadAuthenticatedIdentity["role"],
  ) => Effect.Effect<PreviewSession, PreviewSessionControllerHttpClientError>;
  readonly authorizeCredentialIssue: (
    id: string,
    generation: number,
    role: PreviewWorkloadAuthenticatedIdentity["role"],
  ) => Effect.Effect<
    { readonly session: PreviewSession; readonly reservationId: string },
    PreviewSessionControllerHttpClientError
  >;
  readonly releaseCredentialIssue: (
    input: typeof CredentialIssueReleaseRequest.Type,
  ) => Effect.Effect<void, PreviewSessionControllerHttpClientError>;
  readonly registerCredentialIdentity: (
    input: typeof CredentialRegisterRequest.Type,
  ) => Effect.Effect<void, PreviewSessionControllerHttpClientError>;
  readonly authorizeCredentialRemoval: (
    input: typeof CredentialRemoveRequest.Type,
  ) => Effect.Effect<void, PreviewSessionControllerHttpClientError>;
  readonly removeCredentialIdentity: (
    input: typeof CredentialRemoveRequest.Type,
  ) => Effect.Effect<void, PreviewSessionControllerHttpClientError>;
  readonly admitWorkload: (
    input: typeof AdmitWorkloadRequest.Type,
  ) => Effect.Effect<PreviewWorkloadAdmission, PreviewSessionControllerHttpClientError>;
  readonly settleWorkload: (
    admission: PreviewWorkloadAdmission,
  ) => Effect.Effect<void, PreviewSessionControllerHttpClientError>;
}

export const makePreviewSessionControllerHttpClient = (options: {
  readonly controllerUrl: string;
  readonly administrationToken: Redacted.Redacted<string>;
  readonly workloadToken: Redacted.Redacted<string>;
  readonly httpClient: HttpClient.HttpClient;
}): PreviewSessionControllerHttpClientApi => {
  if (
    Redacted.value(options.administrationToken).trim().length === 0 ||
    Redacted.value(options.workloadToken).trim().length === 0
  ) {
    throw new Error("Preview controller administration and workload tokens must be configured");
  }
  const base = new URL(options.controllerUrl);
  if (base.protocol !== "https:") throw new Error("Preview session controller URL must use HTTPS");
  const root = `${base.origin}/_internal/preview/v1`;
  const post = <I, O>(input: {
    readonly path: string;
    readonly token: Redacted.Redacted<string>;
    readonly requestSchema: Schema.Codec<I, unknown, never, never>;
    readonly responseSchema: Schema.Decoder<O, never>;
    readonly body: I;
  }): Effect.Effect<O, PreviewSessionControllerHttpClientError> =>
    Effect.gen(function* () {
      const initial = HttpClientRequest.post(`${root}${input.path}`).pipe(
        HttpClientRequest.bearerToken(input.token),
      );
      const request = yield* HttpClientRequest.schemaBodyJson(input.requestSchema)(input.body)(
        initial,
      ).pipe(
        Effect.mapError(
          () => new PreviewSessionControllerHttpClientError({ reason: "request-encoding-failed" }),
        ),
      );
      const response = yield* options.httpClient.execute(request).pipe(
        Effect.timeout("5 seconds"),
        Effect.mapError(
          () =>
            new PreviewSessionControllerHttpClientError({ reason: "controller-request-failed" }),
        ),
      );
      const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.mapError(
          () =>
            new PreviewSessionControllerHttpClientError({ reason: "controller-request-denied" }),
        ),
      );
      return yield* HttpClientResponse.schemaBodyJson(input.responseSchema)(ok).pipe(
        Effect.mapError(
          () =>
            new PreviewSessionControllerHttpClientError({ reason: "invalid-controller-response" }),
        ),
      );
    });
  const admin = options.administrationToken;
  const workload = options.workloadToken;
  return {
    authorizeCredential: (id, generation, role) =>
      post({
        path: "/credential/authorize",
        token: admin,
        requestSchema: CredentialAuthorizeRequest,
        responseSchema: Schema.Struct({
          authorized: Schema.Literal(true),
          session: PreviewSessionSchema,
        }),
        body: { id, generation, role },
      }).pipe(Effect.map(({ session }) => session)),
    authorizeCredentialIssue: (id, generation, role) =>
      post({
        path: "/credential/issue/reserve",
        token: admin,
        requestSchema: CredentialIssueRequest,
        responseSchema: Schema.Struct({
          reservationId: Schema.NonEmptyString,
          session: PreviewSessionSchema,
        }),
        body: { id, generation, role },
      }),
    releaseCredentialIssue: (body) =>
      post({
        path: "/credential/issue/release",
        token: admin,
        requestSchema: CredentialIssueReleaseRequest,
        responseSchema: Schema.Struct({ released: Schema.Literal(true) }),
        body,
      }).pipe(Effect.asVoid),
    registerCredentialIdentity: (body) =>
      post({
        path: "/credential/register",
        token: admin,
        requestSchema: CredentialRegisterRequest,
        responseSchema: Schema.Struct({ registered: Schema.Literal(true) }),
        body,
      }).pipe(Effect.asVoid),
    authorizeCredentialRemoval: (body) =>
      post({
        path: "/credential/removal/authorize",
        token: admin,
        requestSchema: CredentialRemoveRequest,
        responseSchema: Schema.Struct({ authorized: Schema.Literal(true) }),
        body,
      }).pipe(Effect.asVoid),
    removeCredentialIdentity: (body) =>
      post({
        path: "/credential/removal/complete",
        token: admin,
        requestSchema: CredentialRemoveRequest,
        responseSchema: Schema.Struct({ removed: Schema.Literal(true) }),
        body,
      }).pipe(Effect.asVoid),
    admitWorkload: (body) =>
      post({
        path: "/work/admit",
        token: workload,
        requestSchema: AdmitWorkloadRequest,
        responseSchema: PreviewWorkloadAdmissionSchema,
        body,
      }),
    settleWorkload: (admission: PreviewWorkloadAdmission) =>
      post({
        path: "/work/settle",
        token: Redacted.make(admission.admissionId),
        requestSchema: PreviewWorkloadAdmissionSchema,
        responseSchema: Schema.Struct({
          settled: Schema.Literal(true),
          admissionId: Schema.NonEmptyString,
        }),
        body: admission,
      }).pipe(Effect.asVoid),
  };
};
