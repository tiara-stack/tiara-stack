import { createServer, type RequestListener } from "node:http";
import { Effect, Layer, Redacted } from "effect";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  KubernetesTokenRequestClient,
  KubernetesTokenRequestClientLive,
  KubernetesServiceAccountClient,
  KubernetesServiceAccountClientLive,
} from "./kubernetes-token-request";
import { makePreviewWorkloadCredentialRequest } from "./preview-workload-credentials";

const withServer = <A, E>(listener: RequestListener, use: (url: string) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => createServer(listener)),
        (value) =>
          value.listening
            ? Effect.tryPromise(
                () =>
                  new Promise<void>((resolve, reject) =>
                    value.close((error) => (error ? reject(error) : resolve())),
                  ),
              ).pipe(Effect.orDie)
            : Effect.void,
      );
      yield* Effect.tryPromise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve());
          }),
      ).pipe(Effect.orDie);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected test HTTP address");
      return yield* use(`http://127.0.0.1:${address.port}`).pipe(
        Effect.provide(NodeServices.layer),
      );
    }),
  );

const httpClientLayer = () =>
  Layer.provide(NodeHttpClient.layerNodeHttpNoAgent, NodeHttpClient.layerAgentOptions());

const request = makePreviewWorkloadCredentialRequest({
  sessionId: "session-a",
  generation: 2,
  role: "sheet-workflows-runner",
  kind: "host-token-request",
  credentialName: "workload-identity",
  audience: "sheet-auth-subject-token",
  serviceAccount: "tiara-stack-dev/preview-session-runner",
});

describe("Kubernetes TokenRequest client", () => {
  it.live("requests the exact service account, audience, and ten minute lifetime", () => {
    let requestPath: string | undefined;
    let authorization: string | undefined;
    let body: unknown;
    const listener: RequestListener = (request, response) => {
      requestPath = request.url;
      authorization = request.headers.authorization;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            spec: { audiences: ["sheet-auth-subject-token"], expirationSeconds: 600 },
            status: {
              token: "scoped-host-token",
              expirationTimestamp: new Date(Date.now() + 480_000).toISOString(),
            },
          }),
        );
      });
    };
    return withServer(listener, (url) =>
      Effect.gen(function* () {
        const clientLayer = KubernetesTokenRequestClientLive({
          apiServerUrl: url,
          controllerToken: Redacted.make("controller-admin-token"),
          allowInsecureLoopbackForTests: true,
        }).pipe(Layer.provide(httpClientLayer()));
        const client = yield* KubernetesTokenRequestClient.pipe(Effect.provide(clientLayer));
        const result = yield* client.request(request);
        expect(requestPath).toBe(
          "/api/v1/namespaces/tiara-stack-dev/serviceaccounts/preview-session-runner/token",
        );
        expect(authorization).toBe("Bearer controller-admin-token");
        expect(body).toMatchObject({
          apiVersion: "authentication.k8s.io/v1",
          kind: "TokenRequest",
          spec: { audiences: ["sheet-auth-subject-token"], expirationSeconds: 600 },
        });
        expect(result.token).toBe("scoped-host-token");
        expect(result.expiresAt - result.issuedAt).toBeLessThanOrEqual(480_000);
      }),
    );
  });

  it.live("rejects a TokenRequest result that omits the requested audience", () => {
    const listener: RequestListener = (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          spec: { audiences: ["other-audience"], expirationSeconds: 600 },
          status: {
            token: "wrong-audience-token",
            expirationTimestamp: new Date(Date.now() + 300_000).toISOString(),
          },
        }),
      );
    };
    return withServer(listener, (url) =>
      Effect.gen(function* () {
        const clientLayer = KubernetesTokenRequestClientLive({
          apiServerUrl: url,
          controllerToken: Redacted.make("controller-admin-token"),
          allowInsecureLoopbackForTests: true,
        }).pipe(Layer.provide(httpClientLayer()));
        const client = yield* KubernetesTokenRequestClient.pipe(Effect.provide(clientLayer));
        const result = yield* Effect.exit(client.request(request));
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  it.live("derives token issue time from server expiry when the API clock is ahead", () => {
    const localNow = Date.now();
    const listener: RequestListener = (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          spec: { audiences: ["sheet-auth-subject-token"], expirationSeconds: 600 },
          status: {
            token: "clock-skewed-token",
            expirationTimestamp: new Date(localNow + 660_000).toISOString(),
          },
        }),
      );
    };
    return withServer(listener, (url) =>
      Effect.gen(function* () {
        const clientLayer = KubernetesTokenRequestClientLive({
          apiServerUrl: url,
          controllerToken: Redacted.make("controller-admin-token"),
          allowInsecureLoopbackForTests: true,
        }).pipe(Layer.provide(httpClientLayer()));
        const client = yield* KubernetesTokenRequestClient.pipe(Effect.provide(clientLayer));
        const result = yield* client.request(request);
        expect(result.issuedAt).toBeGreaterThan(localNow);
        expect(result.expiresAt - result.issuedAt).toBe(600_000);
      }),
    );
  });

  it.live("rejects an expiry that exceeds the request lifetime and clock-skew allowance", () => {
    const listener: RequestListener = (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          spec: { audiences: ["sheet-auth-subject-token"], expirationSeconds: 600 },
          status: {
            token: "overlong-token",
            expirationTimestamp: new Date(Date.now() + 900_000).toISOString(),
          },
        }),
      );
    };
    return withServer(listener, (url) =>
      Effect.gen(function* () {
        const clientLayer = KubernetesTokenRequestClientLive({
          apiServerUrl: url,
          controllerToken: Redacted.make("controller-admin-token"),
          allowInsecureLoopbackForTests: true,
        }).pipe(Layer.provide(httpClientLayer()));
        const client = yield* KubernetesTokenRequestClient.pipe(Effect.provide(clientLayer));
        const result = yield* Effect.exit(client.request(request));
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  it.live("creates and deletes only the exact owner-labeled service account", () => {
    const expectedLabels = {
      "tiara-stack.io/preview-session": "session-a",
      "tiara-stack.io/preview-generation": "2",
      "tiara-stack.io/preview-role": "sheet-workflows-runner",
      "tiara-stack.io/preview-credential": "workload-identity",
    };
    let exists = false;
    const methods: string[] = [];
    const listener: RequestListener = (request, response) => {
      methods.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && !exists) {
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      if (request.method === "POST") exists = true;
      if (request.method === "DELETE") exists = false;
      response.end(
        JSON.stringify({
          metadata: {
            name: "preview-session-runner",
            namespace: "tiara-stack-dev",
            uid: "service-account-uid-1",
            labels: expectedLabels,
          },
        }),
      );
    };
    return withServer(listener, (url) =>
      Effect.gen(function* () {
        const layer = KubernetesServiceAccountClientLive({
          apiServerUrl: `${url}/kubernetes-proxy/`,
          controllerToken: Redacted.make("controller-admin-token"),
          allowInsecureLoopbackForTests: true,
        }).pipe(Layer.provide(httpClientLayer()));
        const client = yield* KubernetesServiceAccountClient.pipe(Effect.provide(layer));
        const owned = yield* client.ensureOwned(request);
        expect(owned).toEqual({ uid: "service-account-uid-1", created: true });
        const reused = yield* client.ensureOwned(request);
        expect(reused).toEqual({ uid: "service-account-uid-1", created: false });
        yield* client.deleteOwned(request, owned.uid);
        expect(methods).toEqual([
          "GET /kubernetes-proxy/api/v1/namespaces/tiara-stack-dev/serviceaccounts/preview-session-runner",
          "POST /kubernetes-proxy/api/v1/namespaces/tiara-stack-dev/serviceaccounts",
          "GET /kubernetes-proxy/api/v1/namespaces/tiara-stack-dev/serviceaccounts/preview-session-runner",
          "GET /kubernetes-proxy/api/v1/namespaces/tiara-stack-dev/serviceaccounts/preview-session-runner",
          "GET /kubernetes-proxy/api/v1/namespaces/tiara-stack-dev/serviceaccounts/preview-session-runner",
          "DELETE /kubernetes-proxy/api/v1/namespaces/tiara-stack-dev/serviceaccounts/preview-session-runner",
        ]);
      }),
    );
  });

  it.live("refuses an existing service account owned by another session", () => {
    const listener: RequestListener = (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          metadata: {
            name: "preview-session-runner",
            namespace: "tiara-stack-dev",
            uid: "service-account-uid-2",
            labels: {
              "tiara-stack.io/preview-session": "other-session",
              "tiara-stack.io/preview-generation": "2",
              "tiara-stack.io/preview-role": "sheet-workflows-runner",
              "tiara-stack.io/preview-credential": "workload-identity",
            },
          },
        }),
      );
    };
    return withServer(listener, (url) =>
      Effect.gen(function* () {
        const layer = KubernetesServiceAccountClientLive({
          apiServerUrl: url,
          controllerToken: Redacted.make("controller-admin-token"),
          allowInsecureLoopbackForTests: true,
        }).pipe(Layer.provide(httpClientLayer()));
        const client = yield* KubernetesServiceAccountClient.pipe(Effect.provide(layer));
        const result = yield* Effect.exit(client.ensureOwned(request));
        expect(result._tag).toBe("Failure");
      }),
    );
  });
});
