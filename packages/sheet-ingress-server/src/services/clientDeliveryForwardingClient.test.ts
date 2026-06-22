// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ClientDeliveryForwardingClient } from "./clientDeliveryForwardingClient";
import { ClientRegistry } from "./clientRegistry";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const clientRef = { platform: "discord", clientId: "discord-main" } as const;
const workspaceRef = { client: clientRef, workspaceId: "guild-1" } as const;
const conversationRef = { workspace: workspaceRef, conversationId: "channel-1" } as const;
const messageRef = { conversation: conversationRef, messageId: "message-1" } as const;
const outboundMessage = { content: "Done" } as const;

const makeClientRegistry = () =>
  ({
    resolve: () =>
      Effect.succeed({
        baseUrl: "http://sheet-bot",
        clientId: clientRef.clientId,
        platform: clientRef.platform,
        serviceTokenResource: "sheet-bot",
      }),
  }) as never;

const makeSheetApisRpcTokens = () =>
  ({
    getServiceToken: (resource: string) => Effect.succeed(`${resource}-token`),
  }) as never;

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  httpClient: HttpClient.HttpClient = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }))),
  ),
) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provideService(ClientRegistry, makeClientRegistry()),
        Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ) as Effect.Effect<A, E, never>,
    ),
  );

type ForwardingClient = Effect.Success<typeof ClientDeliveryForwardingClient.make>;

const makeRequestCapturingClient = () => {
  const requestReceived = Deferred.makeUnsafe<HttpClientRequest.HttpClientRequest>();
  const httpClient = HttpClient.make((request) =>
    Deferred.succeed(requestReceived, request).pipe(
      Effect.as(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }))),
    ),
  );

  return { httpClient, requestReceived };
};

const captureForwardedRequest = <A, E>(
  useClient: (client: ForwardingClient) => Effect.Effect<A, E, never>,
) => {
  const { httpClient, requestReceived } = makeRequestCapturingClient();

  return run(
    Effect.gen(function* () {
      const client = yield* ClientDeliveryForwardingClient.make;
      const fiber = yield* Effect.forkScoped(Effect.ignore(useClient(client)));
      const request = yield* Deferred.await(requestReceived);
      yield* Fiber.interrupt(fiber);
      return request;
    }),
    httpClient,
  );
};

const expectForwardedClientRequest = (
  request: HttpClientRequest.HttpClientRequest,
  method: string,
  url: string,
) => {
  expect(request.method).toBe(method);
  expect(request.url).toBe(url);
  expect(request.headers["x-sheet-ingress-auth"]).toBe("Bearer sheet-bot-token");
};

const expectJsonRequestBody = (request: HttpClientRequest.HttpClientRequest, body: object) => {
  expect(request.body._tag).toBe("Uint8Array");
  if (request.body._tag === "Uint8Array") {
    expect(JSON.parse(new TextDecoder().decode(request.body.body))).toMatchObject(body);
  }
};

describe("ClientDeliveryForwardingClient", () => {
  it.each([
    {
      body: { conversation: conversationRef, message: outboundMessage },
      method: "POST",
      name: "sends messages with POST",
      runRequest: (client: ForwardingClient) =>
        client.sendMessage(conversationRef, outboundMessage),
      url: "http://sheet-bot/clients/messages/send",
    },
    {
      body: { messageRef, message: outboundMessage },
      method: "PATCH",
      name: "updates messages with PATCH",
      runRequest: (client: ForwardingClient) => client.updateMessage(messageRef, outboundMessage),
      url: "http://sheet-bot/clients/messages/update",
    },
    {
      body: {
        interaction: {
          client: clientRef,
          deadlineEpochMs: 1_783_000_000_000,
          token: "interaction-token",
        },
        message: outboundMessage,
      },
      method: "PATCH",
      name: "updates interaction responses with PATCH",
      runRequest: (client: ForwardingClient) =>
        client.updateInteraction(
          {
            client: clientRef,
            deadlineEpochMs: 1_783_000_000_000,
            token: "interaction-token",
          },
          outboundMessage,
        ),
      url: "http://sheet-bot/clients/interactions/original-response",
    },
    {
      body: { messageRef },
      method: "POST",
      name: "pins messages with POST",
      runRequest: (client: ForwardingClient) => client.pinMessage(messageRef),
      url: "http://sheet-bot/clients/messages/pin",
    },
    {
      body: { messageRef },
      method: "POST",
      name: "deletes messages with POST",
      runRequest: (client: ForwardingClient) => client.deleteMessage(messageRef),
      url: "http://sheet-bot/clients/messages/delete",
    },
    {
      body: { workspace: workspaceRef, userId: "user-1", roleId: "role-1" },
      method: "POST",
      name: "adds member roles with POST",
      runRequest: (client: ForwardingClient) =>
        client.addMemberRole(workspaceRef, "user-1", "role-1"),
      url: "http://sheet-bot/clients/members/roles/add",
    },
    {
      body: { workspace: workspaceRef, userId: "user-1", roleId: "role-1" },
      method: "POST",
      name: "removes member roles with POST",
      runRequest: (client: ForwardingClient) =>
        client.removeMemberRole(workspaceRef, "user-1", "role-1"),
      url: "http://sheet-bot/clients/members/roles/remove",
    },
  ])("$name", async ({ body, method, runRequest, url }) => {
    const request = await captureForwardedRequest(
      (client) => runRequest(client) as Effect.Effect<unknown, unknown, never>,
    );

    expectForwardedClientRequest(request, method, url);
    expectJsonRequestBody(request, body);
  });

  it.each([
    {
      name: "gets workspaces with GET",
      runRequest: (client: ForwardingClient) => client.getWorkspace(workspaceRef),
      url: "http://sheet-bot/clients/discord/discord-main/workspaces/guild-1",
    },
    {
      name: "gets conversations with GET",
      runRequest: (client: ForwardingClient) => client.getConversations(workspaceRef),
      url: "http://sheet-bot/clients/discord/discord-main/workspaces/guild-1/conversations",
    },
    {
      name: "gets members with GET",
      runRequest: (client: ForwardingClient) => client.getMembers(workspaceRef),
      url: "http://sheet-bot/clients/discord/discord-main/workspaces/guild-1/members",
    },
  ])("$name", async ({ runRequest, url }) => {
    const request = await captureForwardedRequest(
      (client) => runRequest(client) as Effect.Effect<unknown, unknown, never>,
    );

    expectForwardedClientRequest(request, "GET", url);
  });
});
