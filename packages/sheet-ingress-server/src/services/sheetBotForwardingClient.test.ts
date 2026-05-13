import { describe, expect, it } from "vitest";
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetBotForwardingClient } from "./sheetBotForwardingClient";
import { SheetBotRpcClient } from "./sheetBotRpcClient";

const makeSheetApisRpcTokens = () =>
  ({
    getServiceToken: () => Effect.succeed("ingress-token"),
  }) as never;

const getRpcRequestHeaders = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") return [];

  const body = new TextDecoder().decode(request.body.body);
  const parsed = JSON.parse(body) as
    | {
        readonly headers?: ReadonlyArray<readonly [string, string]>;
      }
    | Array<{
        readonly headers?: ReadonlyArray<readonly [string, string]>;
      }>;
  const message = Array.isArray(parsed) ? parsed[0] : parsed;

  return message?.headers ?? [];
};

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  httpClient: HttpClient.HttpClient = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }))),
  ),
  sheetApisRpcTokens: never = makeSheetApisRpcTokens(),
) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(SheetBotRpcClient.layer),
        Effect.provideService(SheetApisRpcTokens, sheetApisRpcTokens),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ SHEET_BOT_BASE_URL: "http://sheet-bot" }),
          ),
        ),
      ) as Effect.Effect<A, E, never>,
    ),
  );

describe("SheetBotForwardingClient", () => {
  it("exposes application and cache compatibility wrappers", async () => {
    const client = await run(SheetBotForwardingClient.make);

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
  });

  it("adds the ingress bearer token to RPC HTTP requests", async () => {
    const requestReceived = Deferred.makeUnsafe<HttpClientRequest.HttpClientRequest>();
    const httpClient = HttpClient.make((request) => {
      return Deferred.succeed(requestReceived, request).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }))),
      );
    });

    const request = await run(
      Effect.gen(function* () {
        const client = yield* SheetBotForwardingClient.make;
        const fiber = yield* Effect.forkScoped(Effect.ignore(client.application.getApplication()));
        const request = yield* Deferred.await(requestReceived);
        yield* Fiber.interrupt(fiber);
        return request;
      }),
      httpClient,
    );

    expect(request.url).toBe("http://sheet-bot/rpc/");
    expect(getRpcRequestHeaders(request)).toContainEqual([
      "x-sheet-ingress-auth",
      "Bearer ingress-token",
    ]);
  });

  it("surfaces ingress token failures as RPC client errors", async () => {
    const ingressTokenFailure = new Error("ingress token refresh failed");
    const sheetApisRpcTokens = {
      getServiceToken: () => Effect.fail(ingressTokenFailure),
    } as never;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* SheetBotForwardingClient.make;
          return yield* client.application.getApplication();
        }).pipe(
          Effect.provide(SheetBotRpcClient.layer),
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
  });
});
