// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, HashSet, Redacted } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { DiscordBotNotFoundError } from "sheet-ingress-api/client-delivery";
import { ClientDeliveryForwardingClient } from "./clientDeliveryForwardingClient";
import { ClientRegistry } from "./clientRegistry";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const clientRef = { platform: "discord", clientId: "discord-main" } as const;
const altClientRef = { platform: "discord", clientId: "discord-alt" } as const;
const altWorkspaceRef = { client: altClientRef, workspaceId: "guild-1" } as const;
const workspaceRef = { client: clientRef, workspaceId: "guild-1" } as const;
const conversationRef = { workspace: workspaceRef, conversationId: "channel-1" } as const;
const messageRef = { conversation: conversationRef, messageId: "message-1" } as const;
const outboundMessage = { content: "Done" } as const;
const outboundMessageWithFile = {
  content: "Failed",
  files: [
    {
      content: new TextEncoder().encode("trace details"),
      contentType: "text/plain",
      name: "error.txt",
    },
  ],
} as const;

const extractFailure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

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

const makeClientRegistryWithAlt = () =>
  ({
    resolve: (ref: { platform: string; clientId: string }) =>
      ref.clientId === "discord-alt"
        ? Effect.succeed({
            baseUrl: "http://sheet-bot-discord-alt",
            clientId: "discord-alt",
            platform: "discord",
            serviceTokenResource: "sheet-bot-alt",
          })
        : Effect.succeed({
            baseUrl: "http://sheet-bot",
            clientId: clientRef.clientId,
            platform: clientRef.platform,
            serviceTokenResource: "sheet-bot",
          }),
  }) as never;

const makeSheetApisRpcTokens = () =>
  ({
    getServiceUser: () =>
      Effect.succeed({
        accountId: "service",
        userId: "service",
        permissions: HashSet.fromIterable(["service"]),
        scopes: new Set(["service"]) as never,
        token: Redacted.make("unavailable"),
        tokenType: "service",
      }),
    getServiceToken: (resource: string) => Effect.succeed(`${resource}-service-token`),
    getDelegatedAuthorization: ({ resource }: { readonly resource: string }) =>
      Effect.succeed(Redacted.make(`${resource}-delegated-token`)),
  }) as never;

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  httpClient: HttpClient.HttpClient = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }))),
  ),
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provideService(ClientRegistry, makeClientRegistry()),
      Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ) as Effect.Effect<A, E, never>,
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

const captureForwardedRequestWithRegistry = <A, E>(
  useClient: (client: ForwardingClient) => Effect.Effect<A, E, never>,
  clientRegistry: ReturnType<typeof makeClientRegistryWithAlt>,
) => {
  const { httpClient, requestReceived } = makeRequestCapturingClient();

  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* ClientDeliveryForwardingClient.make;
      const fiber = yield* Effect.forkScoped(Effect.ignore(useClient(client)));
      const request = yield* Deferred.await(requestReceived);
      yield* Fiber.interrupt(fiber);
      return request;
    }).pipe(
      Effect.provideService(ClientRegistry, clientRegistry),
      Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ) as Effect.Effect<HttpClientRequest.HttpClientRequest, never, never>,
  );
};

const expectForwardedClientRequest = (
  request: HttpClientRequest.HttpClientRequest,
  method: string,
  url: string,
) => {
  expect(request.method).toBe(method);
  expect(request.url).toBe(url);
  expect(request.headers.authorization).toBe("Bearer sheet-bot-service-token");
};

const expectJsonRequestBody = (request: HttpClientRequest.HttpClientRequest, body: object) => {
  expect(request.body._tag).toBe("Uint8Array");
  if (request.body._tag === "Uint8Array") {
    expect(JSON.parse(new TextDecoder().decode(request.body.body))).toMatchObject(body);
  }
};

const makeJsonHttpClient = (body: unknown, status: number) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
    ),
  );

describe("ClientDeliveryForwardingClient", () => {
  it.effect("preserves a typed not-found error from message delivery", () => {
    const httpClient = makeJsonHttpClient(
      { _tag: "DiscordBotNotFoundError", message: "message not found", status: 404 },
      404,
    );
    return run(
      Effect.gen(function* () {
        const client = yield* ClientDeliveryForwardingClient.make;
        const exit = yield* Effect.exit(client.updateMessage(messageRef, outboundMessage));
        const error = extractFailure(exit);

        expect(error).toBeInstanceOf(DiscordBotNotFoundError);
        expect(error).toMatchObject({
          _tag: "DiscordBotNotFoundError",
          status: 404,
        });
      }),
      httpClient,
    );
  });

  it.effect("preserves a typed not-found error from workspace delivery", () => {
    const httpClient = makeJsonHttpClient(
      { _tag: "DiscordBotNotFoundError", message: "workspace not found", status: 404 },
      404,
    );
    return run(
      Effect.gen(function* () {
        const client = yield* ClientDeliveryForwardingClient.make;
        const exit = yield* Effect.exit(client.getWorkspace(workspaceRef));
        const error = extractFailure(exit);

        expect(error).toBeInstanceOf(DiscordBotNotFoundError);
        expect(error).toMatchObject({
          _tag: "DiscordBotNotFoundError",
          status: 404,
        });
      }),
      httpClient,
    );
  });

  it.effect("does not misclassify unrelated downstream not-found responses", () => {
    const httpClient = makeJsonHttpClient(
      { _tag: "UnknownError", message: "message not found" },
      404,
    );
    return run(
      Effect.gen(function* () {
        const client = yield* ClientDeliveryForwardingClient.make;
        const exit = yield* Effect.exit(client.updateMessage(messageRef, outboundMessage));
        const error = extractFailure(exit);

        expect(error).not.toBeInstanceOf(DiscordBotNotFoundError);
        expect(error).toMatchObject({ _tag: "UnknownError" });
      }),
      httpClient,
    );
  });

  it.effect("does not trust a not-found tag without the required error fields", () => {
    const httpClient = makeJsonHttpClient({ _tag: "DiscordBotNotFoundError" }, 404);
    return run(
      Effect.gen(function* () {
        const client = yield* ClientDeliveryForwardingClient.make;
        const exit = yield* Effect.exit(client.updateMessage(messageRef, outboundMessage));
        const error = extractFailure(exit);

        expect(error).not.toBeInstanceOf(DiscordBotNotFoundError);
        expect(error).toMatchObject({ _tag: "UnknownError" });
      }),
      httpClient,
    );
  });

  it.live.each([
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
  ])("$name", ({ body, method, runRequest, url }) =>
    Effect.gen(function* () {
      const request = yield* captureForwardedRequest(
        (client) => runRequest(client) as Effect.Effect<unknown, unknown, never>,
      );

      expectForwardedClientRequest(request, method, url);
      expectJsonRequestBody(request, body);
    }),
  );

  it.live.each([
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
  ])("$name", ({ runRequest, url }) =>
    Effect.gen(function* () {
      const request = yield* captureForwardedRequest(
        (client) => runRequest(client) as Effect.Effect<unknown, unknown, never>,
      );

      expectForwardedClientRequest(request, "GET", url);
    }),
  );

  it.live("encodes outbound file content before forwarding interaction responses", () =>
    Effect.gen(function* () {
      const interaction = {
        client: clientRef,
        deadlineEpochMs: 1_783_000_000_000,
        token: "interaction-token",
      } as const;
      const request = yield* captureForwardedRequest(
        (client) =>
          client.updateInteraction(interaction, outboundMessageWithFile) as Effect.Effect<
            unknown,
            unknown,
            never
          >,
      );

      expectForwardedClientRequest(
        request,
        "PATCH",
        "http://sheet-bot/clients/interactions/original-response",
      );
      expectJsonRequestBody(request, {
        interaction,
        message: {
          ...outboundMessageWithFile,
          files: [
            {
              content: "dHJhY2UgZGV0YWlscw==",
              contentType: "text/plain",
              name: "error.txt",
            },
          ],
        },
      });
    }),
  );

  it.effect("forwards non-default ClientRef to alternate base URL", () =>
    Effect.gen(function* () {
      const altConversationRef = {
        workspace: altWorkspaceRef,
        conversationId: "channel-1",
      } as const;

      const request = yield* captureForwardedRequestWithRegistry(
        (client) =>
          client.sendMessage(altConversationRef, outboundMessage) as Effect.Effect<
            unknown,
            unknown,
            never
          >,
        makeClientRegistryWithAlt(),
      );

      // Use manual assertions instead of expectForwardedClientRequest
      // because the alt client uses a different auth token
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://sheet-bot-discord-alt/clients/messages/send");
      expect(request.headers.authorization).toBe("Bearer sheet-bot-alt-service-token");
      expectJsonRequestBody(request, {
        conversation: altConversationRef,
        message: outboundMessage,
      });
    }),
  );
});
