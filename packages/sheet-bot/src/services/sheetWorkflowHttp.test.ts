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
import {
  makeSheetWorkflowHttpClients,
  WorkflowInputRejected,
  WorkflowTransportUnavailable,
} from "sheet-workflow-http-client";
import {
  enqueueCheckinsOpenWorkflow,
  enqueueConversationsSetLockdownWorkflow,
  enqueueMembersKickWorkflow,
  enqueueRoomOrdersCreateWorkflow,
  enqueueRoomOrdersNavigateWorkflow,
  enqueueRoomOrdersPinTentativeWorkflow,
  enqueueRoomOrdersSendWorkflow,
  enqueueScheduleWorkflow,
  enqueueScreenshotsCaptureAndDeliverWorkflow,
  enqueueStatusWorkflow,
  type CheckinsOpenEnqueue,
  type CheckinsOpenInput,
  type CheckinsOpenReference,
  type ConversationsSetLockdownEnqueue,
  type ConversationsSetLockdownInput,
  type MembersKickEnqueue,
  type MembersKickInput,
  type MembersKickReference,
  type RoomOrdersCreateEnqueue,
  type RoomOrdersCreateInput,
  type RoomOrdersCreateReference,
  type RoomOrdersNavigateEnqueue,
  type RoomOrdersNavigateInput,
  type RoomOrdersNavigateReference,
  type RoomOrdersPinTentativeEnqueue,
  type RoomOrdersPinTentativeInput,
  type RoomOrdersPinTentativeReference,
  type RoomOrdersSendEnqueue,
  type RoomOrdersSendInput,
  type RoomOrdersSendReference,
  type SchedulesDeliverUserScheduleEnqueue,
  type SchedulesDeliverUserScheduleInput,
  type SchedulesDeliverUserScheduleReference,
  type ScreenshotsCaptureAndDeliverEnqueue,
  type ScreenshotsCaptureAndDeliverInput,
  type ScreenshotsCaptureAndDeliverReference,
  type ServicesDeliverStatusEnqueue,
  type ServicesDeliverStatusInput,
  type ServicesDeliverStatusReference,
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

const makeRunReference = (
  invocationId: ServicesDeliverStatusReference["invocationId"],
): ServicesDeliverStatusReference => ({
  invocationId,
  contractIdentity: "services.deliverStatus",
  wireVersion: "1",
});

const makeClient = (
  enqueue: ServicesDeliverStatusEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueServicesDeliverStatus"> => ({
  enqueueServicesDeliverStatus: enqueue,
});

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

  it.live("forwards legacy status helpers without adding another retry layer", () =>
    Effect.gen(function* () {
      const statuses = [503, 202];
      let requests = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          requests += 1;
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: statuses.shift() ?? 500 }),
          );
        }),
      );
      const clients = makeSheetWorkflowHttpClients(httpClient, {
        baseUrl: "https://workflows.example.test",
      });
      const client = makeSheetWorkflowHttpClientShape(clients, clients);

      yield* enqueueStatusWorkflow(client, input);

      expect(requests).toBe(2);
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
      const fiber = yield* enqueueStatusWorkflow(
        makeClient(() => Effect.never),
        input,
      ).pipe(Effect.exit, Effect.forkChild);

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

const scheduleInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference"),
  day: 2,
  targetUserId: "target-user-1",
  targetUsername: "target-user",
} satisfies SchedulesDeliverUserScheduleInput;

const makeScheduleRunReference = (
  invocationId: SchedulesDeliverUserScheduleReference["invocationId"],
): SchedulesDeliverUserScheduleReference => ({
  invocationId,
  contractIdentity: "schedules.deliverUserSchedule",
  wireVersion: "1",
});

const makeScheduleClient = (
  enqueue: SchedulesDeliverUserScheduleEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueSchedulesDeliverUserSchedule"> => ({
  enqueueSchedulesDeliverUserSchedule: enqueue,
});

const checkinInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference"),
  conversationName: "running",
  hour: 12,
  template: "Check in",
} satisfies CheckinsOpenInput;

const makeCheckinRunReference = (
  invocationId: CheckinsOpenReference["invocationId"],
): CheckinsOpenReference => ({
  invocationId,
  contractIdentity: "checkins.open",
  wireVersion: "1",
});

const makeCheckinClient = (
  enqueue: CheckinsOpenEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueCheckinsOpen"> => ({
  enqueueCheckinsOpen: enqueue,
});

const lockdownInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: Schema.decodeUnknownSync(ResponseReference)("opaque-response-reference"),
  conversationId: "conversation-1",
  enabled: true,
} satisfies ConversationsSetLockdownInput;

const makeLockdownClient = (
  enqueue: ConversationsSetLockdownEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueConversationsSetLockdown"> => ({
  enqueueConversationsSetLockdown: enqueue,
});

const makeRoomOrderCreateClient = (
  enqueue: RoomOrdersCreateEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersCreate"> => ({
  enqueueRoomOrdersCreate: enqueue,
});

const makeRoomOrderNavigateClient = (
  enqueue: RoomOrdersNavigateEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersNavigate"> => ({
  enqueueRoomOrdersNavigate: enqueue,
});

const makeRoomOrderSendClient = (
  enqueue: RoomOrdersSendEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersSend"> => ({
  enqueueRoomOrdersSend: enqueue,
});

const makeRoomOrderPinTentativeClient = (
  enqueue: RoomOrdersPinTentativeEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueRoomOrdersPinTentative"> => ({
  enqueueRoomOrdersPinTentative: enqueue,
});

const makeMembersKickClient = (
  enqueue: MembersKickEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueMembersKick"> => ({
  enqueueMembersKick: enqueue,
});

const makeScreenshotClient = (
  enqueue: ScreenshotsCaptureAndDeliverEnqueue,
): Pick<SheetWorkflowHttpClientShape, "enqueueScreenshotsCaptureAndDeliver"> => ({
  enqueueScreenshotsCaptureAndDeliver: enqueue,
});

const roomOrderCreateInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: input.responseReference,
  conversationName: "running",
  hour: 12,
  healNeeded: 1,
} satisfies RoomOrdersCreateInput;

const roomOrderMessageInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: input.responseReference,
  messageId: "room-order-message-1",
  messageConversationId: "running-channel-1",
  messageContent: "Room order",
} satisfies RoomOrdersSendInput;

const roomOrderNavigateInput = {
  ...roomOrderMessageInput,
  direction: "previous" as const,
} satisfies RoomOrdersNavigateInput;

const roomOrderPinTentativeInput = roomOrderMessageInput satisfies RoomOrdersPinTentativeInput;

const membersKickInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: input.responseReference,
  conversationName: "running",
  hour: 12,
} satisfies MembersKickInput;

const screenshotInput = {
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
  responseReference: input.responseReference,
  conversationName: "running",
  day: 2,
} satisfies ScreenshotsCaptureAndDeliverInput;

const makeRoomOrderCreateReference = (
  invocationId: RoomOrdersCreateReference["invocationId"],
): RoomOrdersCreateReference => ({
  invocationId,
  contractIdentity: "roomOrders.create",
  wireVersion: "1",
});

const makeRoomOrderNavigateReference = (
  invocationId: RoomOrdersNavigateReference["invocationId"],
): RoomOrdersNavigateReference => ({
  invocationId,
  contractIdentity: "roomOrders.navigate",
  wireVersion: "1",
});

const makeRoomOrderSendReference = (
  invocationId: RoomOrdersSendReference["invocationId"],
): RoomOrdersSendReference => ({
  invocationId,
  contractIdentity: "roomOrders.send",
  wireVersion: "1",
});

const makeRoomOrderPinTentativeReference = (
  invocationId: RoomOrdersPinTentativeReference["invocationId"],
): RoomOrdersPinTentativeReference => ({
  invocationId,
  contractIdentity: "roomOrders.pinTentative",
  wireVersion: "1",
});

const makeMembersKickReference = (
  invocationId: MembersKickReference["invocationId"],
): MembersKickReference => ({
  invocationId,
  contractIdentity: "members.kick",
  wireVersion: "1",
});

const makeScreenshotReference = (
  invocationId: ScreenshotsCaptureAndDeliverReference["invocationId"],
): ScreenshotsCaptureAndDeliverReference => ({
  invocationId,
  contractIdentity: "screenshots.captureAndDeliver",
  wireVersion: "1",
});

describe("SheetWorkflowHttpClient status enqueue", () => {
  it.live("maps the opaque response reference and reuses invocation identity on retry", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly input: ServicesDeliverStatusInput;
        readonly invocationId: ServicesDeliverStatusReference["invocationId"];
      }> = [];
      let attempts = 0;
      const client = makeClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        calls.push({ input: requestInput, invocationId });
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: true,
                message: "enqueue response was ambiguous",
              }),
            )
          : Effect.succeed(makeRunReference(invocationId));
      });

      const reference = yield* enqueueStatusWorkflow(client, input);

      expect(calls).toHaveLength(2);
      expect(calls[0]?.input).toEqual(input);
      expect(calls[1]?.input).toEqual(input);
      expect(calls[0]?.invocationId).toBe(calls[1]?.invocationId);
      expect(reference.invocationId).toBe(calls[0]?.invocationId);
    }),
  );

  it.effect("does not retry a definitive workflow input rejection", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = makeClient(() => {
        attempts += 1;
        return Effect.fail(new WorkflowInputRejected({ message: "workflow input was rejected" }));
      });

      const exit = yield* Effect.exit(enqueueStatusWorkflow(client, input));

      expect(attempts).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(WorkflowInputRejected);
    }),
  );
});

describe("SheetWorkflowHttpClient schedule enqueue", () => {
  it.live("preserves the schedule payload and reuses invocation identity on retry", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly input: SchedulesDeliverUserScheduleInput;
        readonly invocationId: SchedulesDeliverUserScheduleReference["invocationId"];
      }> = [];
      let attempts = 0;
      const client = makeScheduleClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        calls.push({ input: requestInput, invocationId });
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: true,
                message: "enqueue response was ambiguous",
              }),
            )
          : Effect.succeed(makeScheduleRunReference(invocationId));
      });

      const reference = yield* enqueueScheduleWorkflow(client, scheduleInput);

      expect(calls).toHaveLength(2);
      expect(calls[0]?.input).toEqual(scheduleInput);
      expect(calls[1]?.input).toEqual(scheduleInput);
      expect(calls[0]?.invocationId).toBe(calls[1]?.invocationId);
      expect(reference).toEqual(makeScheduleRunReference(calls[0]!.invocationId));
    }),
  );

  it.effect("does not retry a definitive workflow input rejection", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = makeScheduleClient(() => {
        attempts += 1;
        return Effect.fail(new WorkflowInputRejected({ message: "workflow input was rejected" }));
      });

      const exit = yield* Effect.exit(enqueueScheduleWorkflow(client, scheduleInput));

      expect(attempts).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(WorkflowInputRejected);
    }),
  );
});

describe("SheetWorkflowHttpClient expanded catalog enqueue", () => {
  it.live("preserves a check-in payload and invocation identity across an ambiguous retry", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly input: CheckinsOpenInput;
        readonly invocationId: CheckinsOpenReference["invocationId"];
      }> = [];
      let attempts = 0;
      const client = makeCheckinClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        calls.push({ input: requestInput, invocationId });
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: true,
                message: "enqueue response was ambiguous",
              }),
            )
          : Effect.succeed(makeCheckinRunReference(invocationId));
      });

      const reference = yield* enqueueCheckinsOpenWorkflow(client, checkinInput);

      expect(calls).toHaveLength(2);
      expect(calls[0]?.input).toEqual(checkinInput);
      expect(calls[1]?.input).toEqual(checkinInput);
      expect(calls[0]?.invocationId).toBe(calls[1]?.invocationId);
      expect(reference).toEqual(makeCheckinRunReference(calls[0]!.invocationId));
    }),
  );

  it.effect("keeps a typed input rejection definitive for a lockdown enqueue", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = makeLockdownClient(() => {
        attempts += 1;
        return Effect.fail(new WorkflowInputRejected({ message: "lockdown was rejected" }));
      });

      const exit = yield* Effect.exit(
        enqueueConversationsSetLockdownWorkflow(client, lockdownInput),
      );

      expect(attempts).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(WorkflowInputRejected);
    }),
  );
});

describe("SheetWorkflowHttpClient room-order, member, and screenshot enqueue", () => {
  it.live("preserves every migrated payload and retries room creation with one invocation ID", () =>
    Effect.gen(function* () {
      const roomOrderCreateCalls: Array<{
        readonly input: RoomOrdersCreateInput;
        readonly invocationId: RoomOrdersCreateReference["invocationId"];
      }> = [];
      const roomOrderNavigateCalls: Array<{
        readonly input: RoomOrdersNavigateInput;
        readonly invocationId: RoomOrdersNavigateReference["invocationId"];
      }> = [];
      const roomOrderSendCalls: Array<{
        readonly input: RoomOrdersSendInput;
        readonly invocationId: RoomOrdersSendReference["invocationId"];
      }> = [];
      const roomOrderPinTentativeCalls: Array<{
        readonly input: RoomOrdersPinTentativeInput;
        readonly invocationId: RoomOrdersPinTentativeReference["invocationId"];
      }> = [];
      const membersKickCalls: Array<{
        readonly input: MembersKickInput;
        readonly invocationId: MembersKickReference["invocationId"];
      }> = [];
      const screenshotCalls: Array<{
        readonly input: ScreenshotsCaptureAndDeliverInput;
        readonly invocationId: ScreenshotsCaptureAndDeliverReference["invocationId"];
      }> = [];
      let roomOrderCreateAttempts = 0;

      const roomOrderCreateClient = makeRoomOrderCreateClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        roomOrderCreateCalls.push({ input: requestInput, invocationId });
        roomOrderCreateAttempts += 1;
        return roomOrderCreateAttempts === 1
          ? Effect.fail(
              new WorkflowTransportUnavailable({
                operation: "Enqueue",
                retryable: true,
                message: "enqueue response was ambiguous",
              }),
            )
          : Effect.succeed(makeRoomOrderCreateReference(invocationId));
      });
      const roomOrderNavigateClient = makeRoomOrderNavigateClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        roomOrderNavigateCalls.push({ input: requestInput, invocationId });
        return Effect.succeed(makeRoomOrderNavigateReference(invocationId));
      });
      const roomOrderSendClient = makeRoomOrderSendClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        roomOrderSendCalls.push({ input: requestInput, invocationId });
        return Effect.succeed(makeRoomOrderSendReference(invocationId));
      });
      const roomOrderPinTentativeClient = makeRoomOrderPinTentativeClient(
        (requestInput, options) => {
          const invocationId = options?.invocationId;
          if (invocationId === undefined) return Effect.die("invocation ID is required");
          roomOrderPinTentativeCalls.push({ input: requestInput, invocationId });
          return Effect.succeed(makeRoomOrderPinTentativeReference(invocationId));
        },
      );
      const membersKickClient = makeMembersKickClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        membersKickCalls.push({ input: requestInput, invocationId });
        return Effect.succeed(makeMembersKickReference(invocationId));
      });
      const screenshotClient = makeScreenshotClient((requestInput, options) => {
        const invocationId = options?.invocationId;
        if (invocationId === undefined) return Effect.die("invocation ID is required");
        screenshotCalls.push({ input: requestInput, invocationId });
        return Effect.succeed(makeScreenshotReference(invocationId));
      });

      const roomOrderCreateReference = yield* enqueueRoomOrdersCreateWorkflow(
        roomOrderCreateClient,
        roomOrderCreateInput,
      );
      const roomOrderNavigateReference = yield* enqueueRoomOrdersNavigateWorkflow(
        roomOrderNavigateClient,
        roomOrderNavigateInput,
      );
      const roomOrderSendReference = yield* enqueueRoomOrdersSendWorkflow(
        roomOrderSendClient,
        roomOrderMessageInput,
      );
      const roomOrderPinTentativeReference = yield* enqueueRoomOrdersPinTentativeWorkflow(
        roomOrderPinTentativeClient,
        roomOrderPinTentativeInput,
      );
      const membersKickReference = yield* enqueueMembersKickWorkflow(
        membersKickClient,
        membersKickInput,
      );
      const screenshotReference = yield* enqueueScreenshotsCaptureAndDeliverWorkflow(
        screenshotClient,
        screenshotInput,
      );

      expect(roomOrderCreateCalls).toHaveLength(2);
      expect(roomOrderCreateCalls[0]?.input).toEqual(roomOrderCreateInput);
      expect(roomOrderCreateCalls[1]?.input).toEqual(roomOrderCreateInput);
      expect(roomOrderCreateCalls[0]?.invocationId).toBe(roomOrderCreateCalls[1]?.invocationId);
      expect(roomOrderCreateReference).toEqual(
        makeRoomOrderCreateReference(roomOrderCreateCalls[0]!.invocationId),
      );
      expect(roomOrderNavigateCalls).toEqual([
        { input: roomOrderNavigateInput, invocationId: roomOrderNavigateReference.invocationId },
      ]);
      expect(roomOrderSendCalls).toEqual([
        { input: roomOrderMessageInput, invocationId: roomOrderSendReference.invocationId },
      ]);
      expect(roomOrderPinTentativeCalls).toEqual([
        {
          input: roomOrderPinTentativeInput,
          invocationId: roomOrderPinTentativeReference.invocationId,
        },
      ]);
      expect(membersKickCalls).toEqual([
        { input: membersKickInput, invocationId: membersKickReference.invocationId },
      ]);
      expect(screenshotCalls).toEqual([
        { input: screenshotInput, invocationId: screenshotReference.invocationId },
      ]);
    }),
  );

  it.effect("does not retry a definitive screenshot input rejection", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const client = makeScreenshotClient(() => {
        attempts += 1;
        return Effect.fail(new WorkflowInputRejected({ message: "screenshot was rejected" }));
      });

      const exit = yield* Effect.exit(
        enqueueScreenshotsCaptureAndDeliverWorkflow(client, screenshotInput),
      );

      expect(attempts).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(WorkflowInputRejected);
    }),
  );
});
