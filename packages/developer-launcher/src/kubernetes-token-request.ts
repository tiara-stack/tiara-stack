import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { PreviewWorkloadCredentialRequest } from "./preview-workload-credentials";

const TokenRequestBody = Schema.Struct({
  apiVersion: Schema.Literal("authentication.k8s.io/v1"),
  kind: Schema.Literal("TokenRequest"),
  spec: Schema.Struct({
    audiences: Schema.Array(Schema.NonEmptyString),
    expirationSeconds: Schema.Literals([600]),
  }),
});

const TokenRequestResponse = Schema.Struct({
  spec: Schema.Struct({ audiences: Schema.Array(Schema.String) }),
  status: Schema.Struct({
    token: Schema.NonEmptyString,
    expirationTimestamp: Schema.String,
  }),
});
const tokenRequestClockSkewToleranceMs = 60_000;

export class KubernetesTokenRequestError extends Schema.TaggedErrorClass<KubernetesTokenRequestError>()(
  "KubernetesTokenRequestError",
  { reason: Schema.String },
) {}

export interface KubernetesTokenRequestClientApi {
  readonly request: (input: PreviewWorkloadCredentialRequest) => Effect.Effect<
    {
      readonly token: string;
      readonly issuedAt: number;
      readonly expiresAt: number;
    },
    KubernetesTokenRequestError
  >;
}

export class KubernetesTokenRequestClient extends Context.Service<
  KubernetesTokenRequestClient,
  KubernetesTokenRequestClientApi
>()("developer-launcher/KubernetesTokenRequestClient") {}

const serviceAccountParts = (
  serviceAccount: string,
): Effect.Effect<
  { readonly namespace: string; readonly name: string },
  KubernetesTokenRequestError
> => {
  const [namespace, name, extra] = serviceAccount.split("/");
  const segment = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
  if (
    !namespace ||
    !name ||
    extra !== undefined ||
    !segment.test(namespace) ||
    !segment.test(name)
  ) {
    return Effect.fail(new KubernetesTokenRequestError({ reason: "invalid-service-account-name" }));
  }
  return Effect.succeed({ namespace, name });
};

/** Uses only the explicitly supplied controller credential and exact TokenRequest audience. */
export const KubernetesTokenRequestClientLive = (options: {
  readonly apiServerUrl: string;
  readonly controllerToken: Redacted.Redacted<string>;
  readonly allowInsecureLoopbackForTests?: boolean;
}) =>
  Layer.effect(
    KubernetesTokenRequestClient,
    Effect.gen(function* () {
      const parsedBaseUrl = new URL(options.apiServerUrl);
      const loopbackForTests =
        options.allowInsecureLoopbackForTests === true &&
        ["localhost", "127.0.0.1", "::1"].includes(parsedBaseUrl.hostname);
      if (parsedBaseUrl.protocol !== "https:" && !loopbackForTests) {
        return yield* Effect.fail(
          new KubernetesTokenRequestError({ reason: "kubernetes-api-requires-tls" }),
        );
      }
      const http = yield* HttpClient.HttpClient;
      return {
        request: (input) =>
          Effect.gen(function* () {
            const { namespace, name } = yield* serviceAccountParts(input.serviceAccount);
            const baseUrl = options.apiServerUrl.replace(/\/$/, "");
            const url = `${baseUrl}/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts/${encodeURIComponent(name)}/token`;
            const request = HttpClientRequest.post(url).pipe(
              HttpClientRequest.bearerToken(options.controllerToken),
              HttpClientRequest.schemaBodyJson(TokenRequestBody)({
                apiVersion: "authentication.k8s.io/v1",
                kind: "TokenRequest",
                spec: {
                  audiences: [input.audience],
                  expirationSeconds: input.expirationSeconds,
                },
              }),
            );
            const response = yield* request.pipe(
              Effect.flatMap(http.execute),
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenRequestResponse)),
              Effect.timeout("5 seconds"),
              Effect.mapError(
                () => new KubernetesTokenRequestError({ reason: "token-request-failed" }),
              ),
            );
            const observedAt = yield* Clock.currentTimeMillis;
            if (!response.spec.audiences.includes(input.audience)) {
              return yield* Effect.fail(
                new KubernetesTokenRequestError({ reason: "token-request-audience-mismatch" }),
              );
            }
            const expiresAt = Date.parse(response.status.expirationTimestamp);
            const latestAllowedExpiration =
              observedAt + input.expirationSeconds * 1_000 + tokenRequestClockSkewToleranceMs;
            if (
              !Number.isFinite(expiresAt) ||
              expiresAt <= observedAt ||
              expiresAt > latestAllowedExpiration
            ) {
              return yield* Effect.fail(
                new KubernetesTokenRequestError({ reason: "invalid-token-request-expiry" }),
              );
            }
            const issuedAt = Math.max(observedAt, expiresAt - input.expirationSeconds * 1_000);
            return { token: response.status.token, issuedAt, expiresAt };
          }),
      } satisfies KubernetesTokenRequestClientApi;
    }),
  );

const PreviewOwnerLabels = Schema.Struct({
  "tiara-stack.io/preview-session": Schema.String,
  "tiara-stack.io/preview-generation": Schema.String,
  "tiara-stack.io/preview-role": Schema.String,
  "tiara-stack.io/preview-credential": Schema.String,
});

const ServiceAccountResponse = Schema.Struct({
  metadata: Schema.Struct({
    name: Schema.String,
    namespace: Schema.String,
    uid: Schema.NonEmptyString,
    labels: Schema.Record(Schema.String, Schema.String),
  }),
});

export class KubernetesServiceAccountClientError extends Schema.TaggedErrorClass<KubernetesServiceAccountClientError>()(
  "KubernetesServiceAccountClientError",
  { reason: Schema.String },
) {}

export interface KubernetesServiceAccountClientApi {
  readonly ensureOwned: (
    input: PreviewWorkloadCredentialRequest,
  ) => Effect.Effect<
    { readonly uid: string; readonly created: boolean },
    KubernetesServiceAccountClientError
  >;
  readonly deleteOwned: (
    input: PreviewWorkloadCredentialRequest,
    expectedUid?: string,
  ) => Effect.Effect<void, KubernetesServiceAccountClientError>;
}

export class KubernetesServiceAccountClient extends Context.Service<
  KubernetesServiceAccountClient,
  KubernetesServiceAccountClientApi
>()("developer-launcher/KubernetesServiceAccountClient") {}

const ownerLabelsFor = (input: PreviewWorkloadCredentialRequest) => ({
  "tiara-stack.io/preview-session": input.sessionId,
  "tiara-stack.io/preview-generation": String(input.generation),
  "tiara-stack.io/preview-role": input.role,
  "tiara-stack.io/preview-credential": input.credentialName,
});

export const KubernetesServiceAccountClientLive = (options: {
  readonly apiServerUrl: string;
  readonly controllerToken: Redacted.Redacted<string>;
  readonly allowInsecureLoopbackForTests?: boolean;
}) =>
  Layer.effect(
    KubernetesServiceAccountClient,
    Effect.gen(function* () {
      const baseUrl = new URL(options.apiServerUrl);
      const loopbackForTests =
        options.allowInsecureLoopbackForTests === true &&
        ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
      if (baseUrl.protocol !== "https:" && !loopbackForTests) {
        return yield* Effect.fail(
          new KubernetesServiceAccountClientError({ reason: "kubernetes-api-requires-tls" }),
        );
      }
      const http = yield* HttpClient.HttpClient;
      const apiRoot = `${baseUrl.origin}${baseUrl.pathname.replace(/\/+$/, "")}`;
      const getOwned = (
        input: PreviewWorkloadCredentialRequest,
      ): Effect.Effect<{ readonly uid: string } | undefined, KubernetesServiceAccountClientError> =>
        Effect.gen(function* () {
          const { namespace, name } = yield* serviceAccountParts(input.serviceAccount).pipe(
            Effect.mapError(
              () =>
                new KubernetesServiceAccountClientError({ reason: "invalid-service-account-name" }),
            ),
          );
          const request = HttpClientRequest.get(
            `${apiRoot}/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts/${encodeURIComponent(name)}`,
          ).pipe(HttpClientRequest.bearerToken(options.controllerToken));
          const response = yield* http.execute(request).pipe(
            Effect.timeout("5 seconds"),
            Effect.mapError(
              () =>
                new KubernetesServiceAccountClientError({ reason: "service-account-read-failed" }),
            ),
          );
          if (response.status === 404) return undefined;
          if (response.status < 200 || response.status >= 300) {
            return yield* Effect.fail(
              new KubernetesServiceAccountClientError({ reason: "service-account-read-failed" }),
            );
          }
          const resource = yield* HttpClientResponse.schemaBodyJson(ServiceAccountResponse)(
            response,
          ).pipe(
            Effect.mapError(
              () =>
                new KubernetesServiceAccountClientError({
                  reason: "invalid-service-account-response",
                }),
            ),
          );
          const expected = ownerLabelsFor(input);
          const labels = resource.metadata.labels;
          if (
            resource.metadata.name !== name ||
            resource.metadata.namespace !== namespace ||
            Object.entries(expected).some(([key, value]) => labels[key] !== value)
          ) {
            return yield* Effect.fail(
              new KubernetesServiceAccountClientError({ reason: "service-account-owner-mismatch" }),
            );
          }
          return { uid: resource.metadata.uid };
        });

      return {
        ensureOwned: (
          input,
        ): Effect.Effect<
          { readonly uid: string; readonly created: boolean },
          KubernetesServiceAccountClientError
        > =>
          Effect.gen(function* () {
            const existing = yield* getOwned(input);
            if (existing) return { ...existing, created: false };
            const { namespace, name } = yield* serviceAccountParts(input.serviceAccount).pipe(
              Effect.mapError(
                () =>
                  new KubernetesServiceAccountClientError({
                    reason: "invalid-service-account-name",
                  }),
              ),
            );
            const request = yield* HttpClientRequest.schemaBodyJson(
              Schema.Struct({
                apiVersion: Schema.Literal("v1"),
                kind: Schema.Literal("ServiceAccount"),
                metadata: Schema.Struct({
                  name: Schema.String,
                  namespace: Schema.String,
                  labels: PreviewOwnerLabels,
                }),
              }),
            )({
              apiVersion: "v1",
              kind: "ServiceAccount",
              metadata: { name, namespace, labels: ownerLabelsFor(input) },
            })(
              HttpClientRequest.post(
                `${apiRoot}/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts`,
              ).pipe(HttpClientRequest.bearerToken(options.controllerToken)),
            ).pipe(
              Effect.mapError(
                () =>
                  new KubernetesServiceAccountClientError({
                    reason: "invalid-service-account-request",
                  }),
              ),
            );
            const response = yield* http.execute(request).pipe(
              Effect.timeout("5 seconds"),
              Effect.mapError(
                () =>
                  new KubernetesServiceAccountClientError({
                    reason: "service-account-create-failed",
                  }),
              ),
            );
            if (response.status === 409) {
              const existing = yield* getOwned(input);
              if (existing) return { ...existing, created: false };
              return yield* Effect.fail(
                new KubernetesServiceAccountClientError({
                  reason: "service-account-create-conflict",
                }),
              );
            }
            if (response.status < 200 || response.status >= 300) {
              return yield* Effect.fail(
                new KubernetesServiceAccountClientError({
                  reason: "service-account-create-failed",
                }),
              );
            }
            yield* HttpClientResponse.schemaBodyJson(ServiceAccountResponse)(response).pipe(
              Effect.mapError(
                () =>
                  new KubernetesServiceAccountClientError({
                    reason: "invalid-service-account-response",
                  }),
              ),
            );
            const owned = yield* getOwned(input);
            if (!owned)
              return yield* Effect.fail(
                new KubernetesServiceAccountClientError({
                  reason: "service-account-create-owner-mismatch",
                }),
              );
            return { ...owned, created: true };
          }),
        deleteOwned: (
          input,
          expectedUid,
        ): Effect.Effect<void, KubernetesServiceAccountClientError> =>
          Effect.gen(function* () {
            const owned = yield* getOwned(input);
            if (!owned) return yield* Effect.void;
            if (expectedUid !== undefined && owned.uid !== expectedUid) return yield* Effect.void;
            const { namespace, name } = yield* serviceAccountParts(input.serviceAccount).pipe(
              Effect.mapError(
                () =>
                  new KubernetesServiceAccountClientError({
                    reason: "invalid-service-account-name",
                  }),
              ),
            );
            const request = HttpClientRequest.delete(
              `${apiRoot}/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts/${encodeURIComponent(name)}`,
            ).pipe(
              HttpClientRequest.bearerToken(options.controllerToken),
              HttpClientRequest.bodyJsonUnsafe({
                apiVersion: "v1",
                kind: "DeleteOptions",
                preconditions: { uid: owned.uid },
              }),
            );
            const response = yield* http.execute(request).pipe(
              Effect.timeout("5 seconds"),
              Effect.mapError(
                () =>
                  new KubernetesServiceAccountClientError({
                    reason: "service-account-delete-failed",
                  }),
              ),
            );
            if (response.status < 200 || response.status >= 300) {
              return yield* Effect.fail(
                new KubernetesServiceAccountClientError({
                  reason: "service-account-delete-failed",
                }),
              );
            }
            return yield* Effect.void;
          }),
      } satisfies KubernetesServiceAccountClientApi;
    }),
  );
