import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, HashSet, Redacted } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetBotForwardingClient } from "./sheetBotForwardingClient";
import { SheetBotHttpClient } from "./sheetBotHttpClient";

const makeServiceUser = () =>
  Effect.succeed({
    accountId: "service",
    userId: "service",
    permissions: HashSet.fromIterable(["service"]),
    scopes: new Set(["service"]) as never,
    token: Redacted.make("unavailable"),
    tokenType: "service",
  });

const makeSheetApisRpcTokens = () =>
  ({
    getServiceUser: makeServiceUser,
    getServiceToken: () => Effect.succeed("ingress-service-token"),
    getDelegatedAuthorization: () => Effect.succeed(Redacted.make("ingress-delegated-token")),
  }) as never;

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  httpClient: HttpClient.HttpClient = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }))),
  ),
  sheetApisRpcTokens: never = makeSheetApisRpcTokens(),
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(SheetBotHttpClient.layer),
      Effect.provideService(SheetApisRpcTokens, sheetApisRpcTokens),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ SHEET_BOT_BASE_URL: "http://sheet-bot" }),
        ),
      ),
    ) as Effect.Effect<A, E, never>,
  );

type ForwardingClient = Effect.Success<typeof SheetBotForwardingClient.make>;

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
      const client = yield* SheetBotForwardingClient.make;
      const fiber = yield* Effect.forkScoped(Effect.ignore(useClient(client)));
      const request = yield* Deferred.await(requestReceived);
      yield* Fiber.interrupt(fiber);
      return request;
    }),
    httpClient,
  );
};

const interactionToken = "interaction-token";
const donePayload = { content: "Done" };

const expectForwardedSheetBotRequest = (
  request: HttpClientRequest.HttpClientRequest,
  url: string,
) => {
  expect(request.url).toBe(url);
  expect(request.headers.authorization).toBe("Bearer ingress-service-token");
};

const expectJsonRequestBody = (request: HttpClientRequest.HttpClientRequest, body: object) => {
  expect(request.body._tag).toBe("Uint8Array");
  if (request.body._tag === "Uint8Array") {
    expect(JSON.parse(new TextDecoder().decode(request.body.body))).toMatchObject(body);
  }
};

const expectFormDataRequestBody = (
  request: HttpClientRequest.HttpClientRequest,
  body: {
    readonly interactionToken: string;
    readonly payload: object;
  },
) => {
  expect(request.body._tag).toBe("FormData");
  if (request.body._tag === "FormData") {
    expect(request.body.formData.get("interactionToken")).toBe(body.interactionToken);
    expect(request.body.formData.get("payload")).toBe(JSON.stringify(body.payload));
  }
};

describe("SheetBotForwardingClient", () => {
  it.live("exposes application and cache compatibility wrappers", () =>
    Effect.gen(function* () {
      const client = yield* run(SheetBotForwardingClient.make);

      expect(client.application.getApplication).toEqual(expect.any(Function));
      expect(client.bot.createInteractionResponse).toEqual(expect.any(Function));
      expect(client.bot.sendMessage).toEqual(expect.any(Function));
      expect(client.bot.updateMessage).toEqual(expect.any(Function));
      expect(client.bot.updateOriginalInteractionResponse).toEqual(expect.any(Function));
      expect(client.bot.createPin).toEqual(expect.any(Function));
      expect(client.bot.deleteMessage).toEqual(expect.any(Function));
      expect(client.bot.addGuildMemberRole).toEqual(expect.any(Function));
      expect(client.bot.removeGuildMemberRole).toEqual(expect.any(Function));
      expect(client.cache.getMember).toEqual(expect.any(Function));
    }),
  );

  it.live("adds the ingress bearer token to sheet-bot HTTP API requests", () =>
    Effect.gen(function* () {
      const request = yield* captureForwardedRequest((client) =>
        client.application.getApplication(),
      );

      expectForwardedSheetBotRequest(request, "http://sheet-bot/application");
    }),
  );

  it.live.each([
    {
      expectedUrl: `http://sheet-bot/bot/interactions/${interactionToken}/original-response`,
      name: "includes the interaction token when updating the original interaction response",
      runRequest: (client: ForwardingClient) =>
        client.bot.updateOriginalInteractionResponse({
          params: { interactionToken },
          payload: donePayload,
        }),
    },
    {
      bodyKind: "json",
      expectedBody: {
        interactionToken,
        payload: donePayload,
      },
      expectedUrl: "http://sheet-bot/bot/interactions/original-response",
      name: "can update the original interaction response with the token in the body",
      runRequest: (client: ForwardingClient) =>
        client.bot.updateOriginalInteractionResponseByPayload({
          interactionToken,
          payload: donePayload,
        }),
    },
    {
      bodyKind: "formData",
      expectedBody: {
        interactionToken,
        payload: donePayload,
      },
      expectedUrl: "http://sheet-bot/bot/interactions/original-response/files",
      name: "can update the original interaction response with files and the token in the body",
      runRequest: (client: ForwardingClient) => {
        const formData = new FormData();
        formData.append("interactionToken", interactionToken);
        formData.append("payload", JSON.stringify(donePayload));
        formData.append("files", new File(["content"], "screenshot.png", { type: "image/png" }));

        return client.bot.updateOriginalInteractionResponseWithFilesByPayload({
          payload: formData,
        });
      },
    },
  ])("$name", ({ bodyKind, expectedBody, expectedUrl, runRequest }) =>
    Effect.gen(function* () {
      const request = yield* captureForwardedRequest(
        (client) => runRequest(client) as Effect.Effect<unknown, unknown, never>,
      );

      expectForwardedSheetBotRequest(request, expectedUrl);
      if (bodyKind === "json") {
        expectJsonRequestBody(request, expectedBody);
      }
      if (bodyKind === "formData") {
        expectFormDataRequestBody(request, expectedBody);
      }
    }),
  );

  it.live("surfaces ingress token failures as HTTP client errors", () =>
    Effect.gen(function* () {
      const ingressTokenFailure = new Error("ingress token refresh failed");
      const sheetApisRpcTokens = {
        getServiceUser: makeServiceUser,
        getServiceToken: () => Effect.fail(ingressTokenFailure),
        getDelegatedAuthorization: () =>
          Effect.fail(new Error("delegated token path should not be used")),
      } as never;

      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* SheetBotForwardingClient.make;
            return yield* client.application.getApplication();
          }).pipe(
            Effect.provide(SheetBotHttpClient.layer),
            Effect.provideService(SheetApisRpcTokens, sheetApisRpcTokens),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 })),
                ),
              ),
            ),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ SHEET_BOT_BASE_URL: "http://sheet-bot" }),
              ),
            ),
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const cause = Cause.pretty(exit.cause);
        expect(cause).toContain("ingress token refresh failed");
      }
    }),
  );
});
