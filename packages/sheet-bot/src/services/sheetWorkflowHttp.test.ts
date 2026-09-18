import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Clock, ConfigProvider, Duration, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { messageRefFrom, ResponseReference } from "sheet-bot-api/references";
import type { SheetAuthClient as SheetAuthClientApi } from "sheet-auth/client";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import { makeSheetWorkflowHttpClients } from "sheet-workflow-http-client";
import {
  type ServicesDeliverStatusInput,
  SheetWorkflowHttpClient,
  type SheetWorkflowHttpClientShape,
  SheetWorkflowHttpRequestContext,
  makeSheetWorkflowHttpClientShape,
} from "./sheetWorkflowHttp";
import { SheetAuthClient } from "./sheetAuthClient";

const input = {
  responseReference: Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference"),
} satisfies ServicesDeliverStatusInput;

const slotsRefreshInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  conversationId: "conversation-1",
  triggerMessageId: "message-1",
};

const runExhaustedGatewayEnqueue = (
  enqueue: (client: SheetWorkflowHttpClientShape) => Effect.Effect<unknown, unknown, never>,
  expectedAttempts: number,
  expectedIntervals: ReadonlyArray<number>,
  clockAdvance: Duration.Input,
) =>
  Effect.gen(function* () {
    let attempts = 0;
    const requestTimes: number[] = [];
    const httpClient = HttpClient.make((request) =>
      Effect.gen(function* () {
        attempts += 1;
        requestTimes.push(yield* Clock.currentTimeMillis);
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
      }),
    );
    const clients = makeSheetWorkflowHttpClients(httpClient, {
      baseUrl: "https://workflows.example.test",
    });
    const client = makeSheetWorkflowHttpClientShape(clients, clients);
    const fiber = yield* enqueue(client).pipe(Effect.exit, Effect.forkChild);

    yield* TestClock.adjust(clockAdvance);
    const exit = yield* Fiber.join(fiber);

    expect(attempts).toBe(expectedAttempts);
    expect(requestTimes.slice(1).map((time, index) => time - requestTimes[index]!)).toEqual(
      expectedIntervals,
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }).pipe(Effect.provide(TestClock.layer()));

const oauthTokenData = (accessToken: string, scope: string) => ({
  access_token: accessToken,
  token_type: "Bearer",
  expires_in: 3_600,
  expires_at: Math.floor(Date.now() / 1_000) + 3_600,
  scope,
});

const makeControlledAuthClient = (requestedScopes: string[]): SheetAuthClientApi => ({
  getSession: async () => ({ data: null }),
  listAccounts: async () => ({ data: null }),
  getAccessToken: async () => ({ data: null }),
  signOut: async () => ({ data: null }),
  signIn: { social: async () => ({ data: null }) },
  sheetAuth: {
    discord: { accessToken: async () => ({ data: null }) },
    identity: async () => ({ data: null }),
    oauth2: {
      tokenExchange: async () => ({
        data: {
          ...oauthTokenData("user-token", "workflow.enqueue workflow.observe"),
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        },
      }),
    },
    internal: {
      subjectToken: async () => ({
        data: {
          subject_token: "subject-token",
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          expires_in: 60,
          expires_at: Math.floor(Date.now() / 1_000) + 60,
        },
      }),
    },
    trustedDiscordSession: async () => ({ data: null }),
  },
  oauth2: {
    token: async (options) => {
      const scope = String(options.scope);
      requestedScopes.push(scope);
      return {
        data: oauthTokenData(
          scope.includes("token.exchange") ? "actor-token" : "service-token",
          scope,
        ),
      };
    },
    getClients: async () => ({ data: null }),
    createClient: async () => ({ data: null }),
    updateClient: async () => ({ data: null }),
    client: { rotateSecret: async () => ({ data: null }) },
    deleteClient: async () => ({ data: null }),
  },
});

describe("SheetWorkflowHttpClient protected enqueue boundary", () => {
  it.live("constructs the real client with controlled HTTP and auth adapters", () =>
    Effect.gen(function* () {
      const requestedScopes: string[] = [];
      const requestRecords: Array<{
        readonly authorization: string | undefined;
        readonly payload: unknown;
      }> = [];
      const statuses = [503, 202, 202];
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          const payload =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : undefined;
          requestRecords.push({
            authorization: request.headers.authorization,
            payload,
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: statuses.shift() ?? 500 }),
          );
        }),
      );

      yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => mkdtemp(join(tmpdir(), "sheet-bot-workflow-client-")),
          catch: (cause) => cause,
        }),
        (directory) =>
          Effect.gen(function* () {
            const tokenPath = join(directory, "token");
            yield* Effect.tryPromise({
              try: () => writeFile(tokenPath, "kubernetes-token\n"),
              catch: (cause) => cause,
            });
            const client = yield* SheetWorkflowHttpClient.make.pipe(
              Effect.provideService(SheetAuthClient, makeControlledAuthClient(requestedScopes)),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    SHEET_WORKFLOWS_BASE_URL: "https://workflows.example.test",
                    SHEET_AUTH_OAUTH_CLIENT_ID: "sheet-bot-client",
                    SHEET_AUTH_OAUTH_CLIENT_SECRET: "sheet-bot-secret",
                    SHEET_AUTH_SUBJECT_TOKEN_KUBERNETES_TOKEN_PATH: tokenPath,
                  }),
                ),
              ),
            );
            const userReference = yield* SheetWorkflowHttpRequestContext.asDiscordUser(
              "discord-user-1",
              () => client.enqueueServicesDeliverStatus(input),
            )();
            const userPayloads = requestRecords.slice(0, 2).map(({ payload }) => payload) as Array<{
              readonly invocationId: string;
              readonly input: ServicesDeliverStatusInput;
            }>;

            expect(userReference.invocationId).toBe(userPayloads[0]?.invocationId);
            expect(userPayloads[0]?.invocationId).toBe(userPayloads[1]?.invocationId);
            expect(userPayloads[0]?.input).toEqual(input);
            expect(requestRecords[0]?.authorization).toBe("Bearer user-token");
            expect(requestedScopes.some((scope) => scope.includes("token.exchange"))).toBe(true);

            const missingContextExit = yield* Effect.exit(
              client.enqueueServicesDeliverStatus(input),
            );
            expect(Exit.isFailure(missingContextExit)).toBe(true);
            expect(requestRecords).toHaveLength(2);

            const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
            yield* client.enqueueSlotsRefreshButton({
              workspaceId,
              conversationId: "conversation-1",
              triggerMessageId: "message-1",
            });
            expect(requestRecords[2]?.authorization).toBe("Bearer service-token");
            expect(requestedScopes.some((scope) => scope === "service workflow.enqueue")).toBe(
              true,
            );
          }),
        (directory) =>
          Effect.tryPromise({
            try: () => rm(directory, { recursive: true, force: true }),
            catch: (cause) => cause,
          }).pipe(Effect.orDie),
      );
    }),
  );

  it.live("owns retryable transport recovery for status submission", () =>
    Effect.gen(function* () {
      const statuses = [503, 202];
      const requests: string[] = [];
      const userHttpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: statuses.shift() ?? 500 }),
          );
        }),
      );
      const serviceHttpClient = HttpClient.make(() => Effect.die("service principal was selected"));
      const userClients = makeSheetWorkflowHttpClients(userHttpClient, {
        baseUrl: "https://workflows.example.test",
      });
      const serviceClients = makeSheetWorkflowHttpClients(serviceHttpClient, {
        baseUrl: "https://workflows.example.test",
      });
      const client = makeSheetWorkflowHttpClientShape(userClients, serviceClients);

      const reference = yield* client.enqueueServicesDeliverStatus(input);

      expect(requests).toEqual([
        "https://workflows.example.test/workflows/services.deliverStatus/v/1/enqueue",
        "https://workflows.example.test/workflows/services.deliverStatus/v/1/enqueue",
      ]);
      expect(reference.contractIdentity).toBe("services.deliverStatus");
    }),
  );

  it.live("routes all autonomous enqueue operations through the service principal client", () =>
    Effect.gen(function* () {
      let serviceRequests = 0;
      const userHttpClient = HttpClient.make(() => Effect.die("user principal was selected"));
      const serviceHttpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          serviceRequests += 1;
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }));
        }),
      );
      const clients = makeSheetWorkflowHttpClients(userHttpClient, {
        baseUrl: "https://workflows.example.test",
      });
      const serviceClients = makeSheetWorkflowHttpClients(serviceHttpClient, {
        baseUrl: "https://workflows.example.test",
      });
      const client = makeSheetWorkflowHttpClientShape(clients, serviceClients);
      const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
      const sourceMessage = messageRefFrom(
        { platform: "discord", clientId: "discord-main" },
        workspaceId,
        "conversation-1",
        "message-1",
      );

      yield* client.enqueueSlotsRefreshButton({
        workspaceId,
        conversationId: "conversation-1",
        triggerMessageId: "message-1",
      });
      yield* client.enqueueWorkspacesDeliverWelcome({
        workspaceId,
        workspaceName: "Workspace",
        joinedAt: new Date("2026-09-14T00:00:00.000Z"),
      });
      yield* client.enqueueTeamSubmissionsProcess({
        sourceMessage,
        authorId: "author-1",
        authorDisplayName: "Author",
        content: "submission",
      });
      yield* client.enqueueAnnouncementsDeliverUpdate({
        workspaceId,
        workspaceName: "Workspace",
        joinedAt: new Date("2026-09-14T00:00:00.000Z"),
        announcement: {
          id: "announcement-1",
          publishedAt: new Date("2026-09-14T00:00:00.000Z"),
          title: "Announcement",
          description: "Description",
        },
      });

      expect(serviceRequests).toBe(4);
    }),
  );

  it.effect("uses the centralized six-attempt recovery budget for slot refresh", () =>
    runExhaustedGatewayEnqueue(
      (client) => client.enqueueSlotsRefreshButton(slotsRefreshInput),
      6,
      [100, 100, 100, 200, 100],
      Duration.seconds(10),
    ),
  );

  it.effect("keeps the service payload and invocation identity across slot recovery", () =>
    Effect.gen(function* () {
      const requestRecords: Array<{ readonly payload: unknown; readonly url: string }> = [];
      const userHttpClient = HttpClient.make(() => Effect.die("user principal was selected"));
      const serviceHttpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          const payload =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : undefined;
          requestRecords.push({ payload, url: request.url });
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
        }),
      );
      const userClients = makeSheetWorkflowHttpClients(userHttpClient, {
        baseUrl: "https://workflows.example.test",
      });
      const serviceClients = makeSheetWorkflowHttpClients(serviceHttpClient, {
        baseUrl: "https://workflows.example.test",
      });
      const client = makeSheetWorkflowHttpClientShape(userClients, serviceClients);
      const fiber = yield* client
        .enqueueSlotsRefreshButton(slotsRefreshInput)
        .pipe(Effect.exit, Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(10));
      const exit = yield* Fiber.join(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(requestRecords).toHaveLength(6);
      expect(new Set(requestRecords.map(({ url }) => url))).toEqual(
        new Set(["https://workflows.example.test/workflows/slots.refreshButton/v/1/enqueue"]),
      );
      const payloads = requestRecords.map(({ payload }) => payload) as Array<{
        readonly invocationId: string;
        readonly input: unknown;
      }>;
      expect(new Set(payloads.map(({ invocationId }) => invocationId)).size).toBe(1);
      expect(payloads.map(({ input }) => input)).toEqual(
        Array.from({ length: 6 }, () => slotsRefreshInput),
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not retry typed gateway enqueue failures under a background profile", () =>
    Effect.gen(function* () {
      const cases = [
        { status: 400 },
        { status: 401 },
        {
          status: 409,
          body: JSON.stringify({
            _tag: "InvocationConflict",
            invocationId: "123e4567-e89b-42d3-a456-426614174000",
            reason: "CanonicalInputMismatch",
            existing: { contractIdentity: "slots.refreshButton", wireVersion: "1" },
            requested: { contractIdentity: "slots.refreshButton", wireVersion: "1" },
            message: "Invocation input does not match the existing invocation",
          }),
        },
      ] as const;

      for (const testCase of cases) {
        const body = "body" in testCase ? testCase.body : null;
        let attempts = 0;
        const httpClient = HttpClient.make((request) =>
          Effect.sync(() => {
            attempts += 1;
            return HttpClientResponse.fromWeb(
              request,
              new Response(body, { status: testCase.status }),
            );
          }),
        );
        const clients = makeSheetWorkflowHttpClients(httpClient, {
          baseUrl: "https://workflows.example.test",
        });
        const client = makeSheetWorkflowHttpClientShape(clients, clients);
        const exit = yield* Effect.exit(client.enqueueSlotsRefreshButton(slotsRefreshInput));

        expect(attempts).toBe(1);
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect("uses the centralized six-attempt recovery budget for team submission", () =>
    runExhaustedGatewayEnqueue(
      (client) =>
        client.enqueueTeamSubmissionsProcess({
          sourceMessage: messageRefFrom(
            { platform: "discord", clientId: "discord-main" },
            slotsRefreshInput.workspaceId,
            "conversation-1",
            "message-1",
          ),
          authorId: "author-1",
          authorDisplayName: "Author",
          content: "150/700",
        }),
      6,
      [100, 100, 100, 200, 100],
      Duration.seconds(10),
    ),
  );

  it.effect("uses the centralized twenty-six-attempt recovery budget for announcements", () =>
    runExhaustedGatewayEnqueue(
      (client) =>
        client.enqueueAnnouncementsDeliverUpdate({
          workspaceId: slotsRefreshInput.workspaceId,
          workspaceName: "Workspace",
          joinedAt: new Date("2026-09-14T00:00:00.000Z"),
          announcement: {
            id: "announcement-1",
            publishedAt: new Date("2026-09-14T00:00:00.000Z"),
            title: "Announcement",
            description: "Description",
          },
        }),
      26,
      Array.from({ length: 25 }, (_, index) => (index % 2 === 0 ? 100 : 5_000)),
      Duration.minutes(2),
    ),
  );

  it.live("leaves an exhausted retryable transport failure ambiguous", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          attempts += 1;
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
        }),
      );
      const clients = makeSheetWorkflowHttpClients(httpClient, {
        baseUrl: "https://workflows.example.test",
      });
      const client = makeSheetWorkflowHttpClientShape(clients, clients);

      const exit = yield* Effect.exit(client.enqueueServicesDeliverStatus(input));

      expect(attempts).toBe(2);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "WorkflowTransportUnavailable",
          retryable: true,
        });
      }
    }),
  );

  it.effect("maps each attempt timeout to a retryable ambiguous outcome", () =>
    Effect.gen(function* () {
      const httpClient = HttpClient.make(() => Effect.never);
      const clients = makeSheetWorkflowHttpClients(httpClient, {
        baseUrl: "https://workflows.example.test",
      });
      const client = makeSheetWorkflowHttpClientShape(clients, clients);
      const fiber = yield* client
        .enqueueServicesDeliverStatus(input)
        .pipe(Effect.exit, Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(30));
      yield* TestClock.adjust(Duration.millis(100));
      yield* TestClock.adjust(Duration.seconds(30));
      const exit = yield* Fiber.join(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "WorkflowTransportUnavailable",
          retryable: true,
        });
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.live(
    "does not retry typed input rejection, unauthorized invocation, or invocation conflict",
    () =>
      Effect.gen(function* () {
        const cases = [
          { status: 400, expectedAttempts: 1 },
          { status: 401, expectedAttempts: 1 },
          {
            status: 409,
            expectedAttempts: 1,
            body: {
              _tag: "InvocationConflict",
              invocationId: "123e4567-e89b-42d3-a456-426614174000",
              reason: "CanonicalInputMismatch",
              existing: { contractIdentity: "services.deliverStatus", wireVersion: "1" },
              requested: { contractIdentity: "services.deliverStatus", wireVersion: "1" },
              message: "Invocation input does not match the existing invocation",
            },
          },
        ] as const;

        for (const testCase of cases) {
          const { status, expectedAttempts } = testCase;
          const body = "body" in testCase ? testCase.body : undefined;
          let attempts = 0;
          const httpClient = HttpClient.make((request) =>
            Effect.sync(() => {
              attempts += 1;
              return HttpClientResponse.fromWeb(
                request,
                new Response(body === undefined ? null : JSON.stringify(body), { status }),
              );
            }),
          );
          const clients = makeSheetWorkflowHttpClients(httpClient, {
            baseUrl: "https://workflows.example.test",
          });
          const client = makeSheetWorkflowHttpClientShape(clients, clients);
          const exit = yield* Effect.exit(client.enqueueServicesDeliverStatus(input));

          expect(attempts).toBe(expectedAttempts);
          expect(Exit.isFailure(exit)).toBe(true);
        }
      }),
  );
});
