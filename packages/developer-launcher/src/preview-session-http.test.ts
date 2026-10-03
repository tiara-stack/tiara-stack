import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import {
  Headers,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
} from "effect/unstable/http";
import {
  makePreviewSessionControllerHttpClient,
  PreviewSessionControllerHttpRoutes,
  type PreviewSessionControllerHttpOptions,
} from "./preview-session-http";
import { PreviewSessionError, type PreviewSessionControllerApi } from "./preview-sessions";

const deadController = (): PreviewSessionControllerApi => ({
  create: () => Effect.die("unexpected controller call"),
  status: () => Effect.die("unexpected controller call"),
  heartbeat: () => Effect.die("unexpected controller call"),
  resume: () => Effect.die("unexpected controller call"),
  activate: () => Effect.die("unexpected controller call"),
  stop: () => Effect.die("unexpected controller call"),
  admit: () => Effect.die("unexpected controller call"),
  settle: () => Effect.die("unexpected controller call"),
  authorizeCredential: () => Effect.die("unexpected controller call"),
  authorizeCredentialIssue: () => Effect.die("unexpected controller call"),
  releaseCredentialIssue: () => Effect.die("unexpected controller call"),
  registerCredentialIdentity: () => Effect.die("unexpected controller call"),
  authorizeWorkload: () => Effect.die("unexpected controller call"),
  isPreviewOAuthClient: () => Effect.die("unexpected controller call"),
  authorizeCredentialRemoval: () => Effect.die("unexpected controller call"),
  removeCredentialIdentity: () => Effect.die("unexpected controller call"),
  isCredentialIdentityRegistered: () => Effect.die("unexpected controller call"),
  admitWorkload: () => Effect.die("unexpected controller call"),
  settleWorkload: () => Effect.die("unexpected controller call"),
});

const makeHandler = (
  controller: PreviewSessionControllerApi,
  authenticateWorkload: PreviewSessionControllerHttpOptions["authenticateWorkload"],
) =>
  PreviewSessionControllerHttpRoutes(controller, {
    authorityToken: Redacted.make("auth-authority-token"),
    administrationToken: Redacted.make("controller-admin-token"),
    authenticateWorkload,
  }).pipe(Layer.provide(HttpRouter.layer));

describe("preview session controller HTTP routes", () => {
  it("refuses to configure routes with empty controller credentials", () => {
    expect(() =>
      PreviewSessionControllerHttpRoutes(deadController(), {
        authorityToken: Redacted.make(""),
        administrationToken: Redacted.make("admin-token"),
        authenticateWorkload: () => Effect.fail(new PreviewSessionError({ reason: "unused" })),
      }),
    ).toThrow("tokens must be configured");
  });

  it.effect("returns a client error for invalid authority request bodies", () =>
    Effect.gen(function* () {
      let authorizeCalls = 0;
      const controller: PreviewSessionControllerApi = {
        ...deadController(),
        authorizeWorkload: () => {
          authorizeCalls += 1;
          return Effect.die("invalid request reached the controller");
        },
      };
      const handler = yield* HttpRouter.toHttpEffect(
        makeHandler(controller, () => Effect.fail(new PreviewSessionError({ reason: "unused" }))),
      );
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/_internal/preview/v1/authorize", {
              method: "POST",
              headers: { authorization: "Bearer auth-authority-token" },
              body: JSON.stringify({ clientId: "client-a" }),
            }),
          ),
        ),
      );
      expect(response.status).toBe(400);
      expect(authorizeCalls).toBe(0);
    }),
  );

  it.effect("rejects unauthorized controller administration and settlement calls", () =>
    Effect.gen(function* () {
      let adminCalls = 0;
      let settlementCalls = 0;
      const controller: PreviewSessionControllerApi = {
        ...deadController(),
        removeCredentialIdentity: () => {
          adminCalls += 1;
          return Effect.void;
        },
        settleWorkload: () => {
          settlementCalls += 1;
          return Effect.void;
        },
      };
      const handler = yield* HttpRouter.toHttpEffect(
        makeHandler(controller, () =>
          Effect.fail(new PreviewSessionError({ reason: "bad-token" })),
        ),
      );
      const adminResponse = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/_internal/preview/v1/credential/removal/complete", {
              method: "POST",
              headers: { authorization: "Bearer wrong" },
              body: JSON.stringify({
                id: "session-a",
                generation: 1,
                role: "sheet-web",
                oauthClientId: "client-a",
                serviceAccount: "tiara-dev/preview-a-web",
              }),
            }),
          ),
        ),
      );
      const settleResponse = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/_internal/preview/v1/work/settle", {
              method: "POST",
              headers: { authorization: "Bearer wrong" },
              body: JSON.stringify({
                admissionId: "admission-a",
                sessionId: "session-a",
                generation: 1,
                role: "sheet-web",
                oauthClientId: "client-a",
                groupId: "application-zero",
                invocationId: "invocation-a",
                continuationId: null,
                endpoint: "endpoint-a",
                target: "target-a",
              }),
            }),
          ),
        ),
      );
      expect(adminResponse.status).toBe(401);
      expect(settleResponse.status).toBe(401);
      expect(adminCalls).toBe(0);
      expect(settlementCalls).toBe(0);
    }),
  );

  it.effect("uses separate admin and workload tokens over an HTTPS-only client", () =>
    Effect.gen(function* () {
      const observations: Array<{
        readonly url: string;
        readonly authorization: string | undefined;
      }> = [];
      const httpClient = HttpClient.make((request) => {
        observations.push({
          url: request.url,
          authorization: Option.getOrUndefined(Headers.get(request.headers, "authorization")),
        });
        const responseBody = request.url.endsWith("/credential/issue/reserve")
          ? {
              reservationId: "issue-reservation-a",
              session: {
                id: "session-a",
                owner: "owner",
                checkout: "/checkout",
                resources: {},
                manifests: { "sheet-web": "sha256:web" },
                requestedRevision: "rev-a",
                activeRevision: null,
                phase: "pending",
                generation: 1,
                leaseDeadline: 100_000,
                lastRenewedAt: 0,
                supervisorLeaseUntil: 30_000,
                unsettled: 0,
                endedAt: null,
              },
            }
          : request.url.endsWith("/credential/issue/release")
            ? { released: true }
            : request.url.endsWith("/work/admit")
              ? {
                  admissionId: "admission-a",
                  sessionId: "session-a",
                  generation: 1,
                  role: "sheet-web",
                  oauthClientId: "web-client-a",
                  groupId: "application-zero",
                  invocationId: "invoke-a",
                  continuationId: null,
                  endpoint: "endpoint-a",
                  target: "target-a",
                }
              : request.url.endsWith("/work/settle")
                ? { settled: true, admissionId: "admission-a" }
                : { registered: true };
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(responseBody), {
              headers: { "Content-Type": "application/json" },
            }),
          ),
        );
      });
      const client = makePreviewSessionControllerHttpClient({
        controllerUrl: "https://preview-controller.dev/base",
        administrationToken: Redacted.make("admin-only-token"),
        workloadToken: Redacted.make("workload-only-token"),
        httpClient,
      });
      const reservation = yield* client.authorizeCredentialIssue("session-a", 1, "sheet-web");
      yield* client.registerCredentialIdentity({
        id: "session-a",
        generation: 1,
        role: "sheet-web",
        reservationId: reservation.reservationId,
        credentialName: "preview-admission",
        serviceAccount: "tiara-dev/preview-a-web",
        oauthClientId: "web-client-a",
        credentialFile: "/private/session-a/web/token",
      });
      yield* client.releaseCredentialIssue({
        id: "session-a",
        generation: 1,
        role: "sheet-web",
        reservationId: reservation.reservationId,
      });
      const admission = yield* client.admitWorkload({
        groupId: "application-zero",
        invocationId: "invoke-a",
        continuationId: null,
        endpoint: "endpoint-a",
        target: "target-a",
      });
      yield* client.settleWorkload(admission);
      expect(observations.map(({ authorization }) => authorization)).toEqual([
        "Bearer admin-only-token",
        "Bearer admin-only-token",
        "Bearer admin-only-token",
        "Bearer workload-only-token",
        "Bearer admission-a",
      ]);
      expect(observations.every(({ url }) => url.startsWith("https://"))).toBe(true);
      expect(() =>
        makePreviewSessionControllerHttpClient({
          controllerUrl: "http://preview-controller.dev",
          administrationToken: Redacted.make("admin-only-token"),
          workloadToken: Redacted.make("workload-only-token"),
          httpClient,
        }),
      ).toThrow("HTTPS");
    }),
  );

  it.effect(
    "settles an exact prior admission with its one-time capability after workload auth ends",
    () =>
      Effect.gen(function* () {
        let settlementCalls = 0;
        const controller: PreviewSessionControllerApi = {
          ...deadController(),
          settleWorkload: (admission) => {
            settlementCalls += 1;
            expect(admission.target).toBe("target-a");
            return Effect.void;
          },
        };
        const handler = yield* HttpRouter.toHttpEffect(
          makeHandler(controller, () =>
            Effect.fail(new PreviewSessionError({ reason: "session-stopped" })),
          ),
        );
        const response = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/_internal/preview/v1/work/settle", {
                method: "POST",
                headers: { authorization: "Bearer admission-a" },
                body: JSON.stringify({
                  admissionId: "admission-a",
                  sessionId: "session-a",
                  generation: 4,
                  role: "sheet-workflows-runner",
                  oauthClientId: "runner-client-a",
                  groupId: "workflow-execution",
                  invocationId: "invocation-a",
                  continuationId: "continuation-a",
                  endpoint: "endpoint-a",
                  target: "target-a",
                }),
              }),
            ),
          ),
        );
        expect(response.status).toBe(200);
        expect(settlementCalls).toBe(1);
      }),
  );
});
