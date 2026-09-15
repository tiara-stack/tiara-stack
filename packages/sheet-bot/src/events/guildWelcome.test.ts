import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeSheetWorkflowHttpClients } from "sheet-workflow-http-client";
import { makeGuildWelcomeHandler, makeGuildWelcomeWorkflowRequest } from "./guildWelcome";
import { makeSheetWorkflowHttpClientShape } from "../services/sheetWorkflowHttp";

describe("makeGuildWelcomeWorkflowRequest", () => {
  const startupEpochMs = Date.parse("2026-05-31T12:00:00.000Z");

  it("builds a payload for a recent guild join", () => {
    const request = makeGuildWelcomeWorkflowRequest(
      {
        id: "guild-1",
        name: "Guild One",
        joined_at: "2026-05-31T11:55:00.000Z",
        system_channel_id: "system-channel",
      },
      startupEpochMs,
    );

    expect(request).not.toBeNull();
    expect(request?.input).toEqual({
      workspaceId: "guild-1",
      workspaceName: "Guild One",
      joinedAt: new Date("2026-05-31T11:55:00.000Z"),
      systemConversationId: "system-channel",
    });
    expect(request?.invocationId).toBe(
      makeGuildWelcomeWorkflowRequest(
        {
          id: "guild-1",
          name: "Renamed guild",
          joined_at: "2026-05-31T11:55:00.000Z",
        },
        startupEpochMs,
      )?.invocationId,
    );
  });

  it("ignores startup replay, unavailable guilds, and invalid join timestamps", () => {
    expect(
      makeGuildWelcomeWorkflowRequest(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "2026-05-31T11:49:59.999Z",
        },
        startupEpochMs,
      ),
    ).toBeNull();
    expect(
      makeGuildWelcomeWorkflowRequest(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "2026-05-31T11:55:00.000Z",
          unavailable: true,
        },
        startupEpochMs,
      ),
    ).toBeNull();
    expect(
      makeGuildWelcomeWorkflowRequest(
        {
          id: "guild-1",
          name: "Guild One",
          joined_at: "not-a-date",
        },
        startupEpochMs,
      ),
    ).toBeNull();
  });
});

describe("makeGuildWelcomeHandler", () => {
  it.effect("lets the protected client own recovery and catches an exhausted enqueue", () => {
    const logMessages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      logMessages.push(message);
    });

    return Effect.gen(function* () {
      const requestRecords: Array<{ readonly input: unknown; readonly invocationId: string }> = [];
      const userHttpClient = HttpClient.make(() => Effect.die("user principal was selected"));
      const serviceHttpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          const payload =
            request.body._tag === "Uint8Array"
              ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
                  readonly input: unknown;
                  readonly invocationId: string;
                })
              : undefined;
          if (payload !== undefined) {
            requestRecords.push(payload);
          }
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
        }),
      );
      const protectedClient = makeSheetWorkflowHttpClientShape(
        makeSheetWorkflowHttpClients(userHttpClient, {
          baseUrl: "https://workflows.example.test",
        }),
        makeSheetWorkflowHttpClients(serviceHttpClient, {
          baseUrl: "https://workflows.example.test",
        }),
      );
      let enqueueCalls = 0;
      const handler = makeGuildWelcomeHandler({
        clientId: "discord-main",
        startupEpochMs: Date.parse("2026-09-15T12:00:00.000Z"),
        enqueue: (input, options) => {
          enqueueCalls += 1;
          return protectedClient.enqueueWorkspacesDeliverWelcome(input, options);
        },
      });
      const fiber = yield* handler({
        id: "guild-1",
        name: "Guild One",
        joined_at: "2026-09-15T11:55:00.000Z",
        system_channel_id: "system-channel",
      }).pipe(Effect.exit, Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(1));
      const exit = yield* Fiber.join(fiber);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(enqueueCalls).toBe(1);
      expect(requestRecords).toHaveLength(2);
      expect(new Set(requestRecords.map(({ invocationId }) => invocationId)).size).toBe(1);
      expect(requestRecords[0]?.input).toEqual(requestRecords[1]?.input);
      expect(requestRecords[0]?.input).toMatchObject({
        workspaceId: "guild-1",
        workspaceName: "Guild One",
        systemConversationId: "system-channel",
      });
      expect(
        logMessages.some((message) =>
          JSON.stringify(message).includes("Failed to enqueue guild welcome workflow"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger])));
  });
});
