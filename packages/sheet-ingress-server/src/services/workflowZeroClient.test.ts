import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { ConfigProvider, Effect, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import {
  createOAuthClientCredentialsToken,
  createSheetAuthClient,
  OAuthClientCredentialsTokenError,
} from "sheet-auth/client";
import { makeZero, shouldRefreshWorkflowZeroAuth } from "./workflowZeroClient";
import { SheetAuthClient } from "./sheetAuthClient";

const zeroConstructor = vi.hoisted(() => vi.fn());

vi.mock("@rocicorp/zero", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rocicorp/zero")>();
  return { ...actual, Zero: zeroConstructor };
});

vi.mock("sheet-auth/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sheet-auth/client")>();
  return {
    ...actual,
    createOAuthClientCredentialsToken: vi.fn(),
  };
});

type ConnectionState = Parameters<typeof shouldRefreshWorkflowZeroAuth>[0];

const token = (accessToken: string) => ({
  accessToken: Redacted.make(accessToken),
  expiresAt: 2_000_000_000,
  expiresIn: 3600,
  scope: "service ingress.forward",
  tokenType: "Bearer" as const,
});

const configLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    SHEET_AUTH_OAUTH_CLIENT_ID: "sheet-ingress",
    SHEET_AUTH_OAUTH_CLIENT_SECRET: "client-secret",
    ZERO_CACHE_SERVER: "http://zero-cache.test",
    ZERO_CACHE_USER_ID: "sheet-ingress",
    ZERO_OAUTH_AUDIENCE: "sheet-db-server",
  }),
);

const sheetAuthClientLayer = Layer.succeed(
  SheetAuthClient,
  createSheetAuthClient("http://sheet-auth.test"),
);

const runMakeZero = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(sheetAuthClientLayer), Effect.provide(configLayer));

const makeZeroMock = () => {
  const subscribers = new Set<(state: ConnectionState) => void>();
  let currentState: ConnectionState = { name: "connected" };
  let nextConnectState: ConnectionState = { name: "connected" };
  const connect = vi.fn(() => {
    currentState = nextConnectState;
    return Promise.resolve();
  });
  const close = vi.fn();
  const unsubscribe = vi.fn();
  const zero = {
    close,
    connection: {
      connect,
      state: {
        get current() {
          return currentState;
        },
        subscribe: (subscriber: (state: ConnectionState) => void) => {
          subscribers.add(subscriber);
          return () => {
            subscribers.delete(subscriber);
            unsubscribe();
          };
        },
      },
    },
  };
  zeroConstructor.mockImplementationOnce(function () {
    return zero;
  });
  return {
    close,
    connect,
    emit: (state: ConnectionState) => {
      currentState = state;
      for (const subscriber of subscribers) subscriber(state);
    },
    setNextConnectState: (state: ConnectionState) => {
      nextConnectState = state;
    },
    unsubscribe,
  };
};

const waitForMockCalls = (
  mock: { readonly mock: { readonly calls: ReadonlyArray<unknown> } },
  expected: number,
  label: string,
) =>
  Effect.gen(function* () {
    const observed = yield* Effect.yieldNow.pipe(
      Effect.andThen(Effect.sync(() => mock.mock.calls.length)),
      Effect.repeat({
        times: 20,
        until: (calls) => calls >= expected,
      }),
    );
    if (observed < expected) {
      return yield* Effect.die(
        new Error(`${label} observed ${String(observed)} calls; expected ${String(expected)}`),
      );
    }
  });

describe("workflow Zero authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    zeroConstructor.mockReset();
  });

  it("refreshes for authentication connection failures", () => {
    expect(
      shouldRefreshWorkflowZeroAuth({
        name: "needs-auth",
        reason: { type: "query", status: 401 },
      }),
    ).toBe(true);
    expect(
      shouldRefreshWorkflowZeroAuth({
        name: "error",
        reason: "Fetch from API server returned non-OK status 500",
      }),
    ).toBe(true);
  });

  it("does not refresh for unrelated connection states", () => {
    expect(shouldRefreshWorkflowZeroAuth({ name: "error", reason: "Zero cache crashed" })).toBe(
      false,
    );
    expect(shouldRefreshWorkflowZeroAuth({ name: "connected" })).toBe(false);
  });

  it.effect("acquires the initial token before constructing Zero", () =>
    Effect.gen(function* () {
      const mock = makeZeroMock();
      vi.mocked(createOAuthClientCredentialsToken).mockReturnValueOnce(
        Effect.succeed(token("initial-token")),
      );

      yield* runMakeZero(Effect.scoped(makeZero()));

      expect(zeroConstructor).toHaveBeenCalledOnce();
      expect(zeroConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ auth: "initial-token" }),
      );
      expect(mock.connect).not.toHaveBeenCalled();
    }),
  );

  it.effect("retries a transient initial-token failure", () =>
    Effect.gen(function* () {
      makeZeroMock();
      vi.mocked(createOAuthClientCredentialsToken)
        .mockReturnValueOnce(
          Effect.fail(
            new OAuthClientCredentialsTokenError({
              message: "auth unavailable",
              statusText: "SERVICE_UNAVAILABLE",
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(token("recovered-token")));

      const fiber = yield* runMakeZero(Effect.scoped(makeZero())).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      let completed = false;
      let iterations = 0;
      for (; !completed && iterations < 3; iterations += 1) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        completed = fiber.pollUnsafe() !== undefined;
      }
      if (!completed) {
        return yield* Effect.die(
          new Error(
            `Initial authentication retry did not complete after ${iterations} iterations; observed ${String(vi.mocked(createOAuthClientCredentialsToken).mock.calls.length)} token requests`,
          ),
        );
      }
      yield* Fiber.join(fiber);

      expect(createOAuthClientCredentialsToken).toHaveBeenCalledTimes(2);
      expect(zeroConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ auth: "recovered-token" }),
      );
    }),
  );

  it.effect("refreshes authentication after Zero reports needs-auth", () =>
    Effect.gen(function* () {
      const mock = makeZeroMock();
      vi.mocked(createOAuthClientCredentialsToken)
        .mockReturnValueOnce(Effect.succeed(token("initial-token")))
        .mockReturnValueOnce(Effect.succeed(token("refreshed-token")));

      yield* runMakeZero(
        Effect.scoped(
          Effect.gen(function* () {
            yield* makeZero();
            mock.emit({
              name: "needs-auth",
              reason: { type: "query", status: 401 },
            });
            yield* waitForMockCalls(mock.connect, 1, "needs-auth reconnect");

            expect(mock.connect).toHaveBeenCalledWith({ auth: "refreshed-token" });
          }),
        ),
      );
    }),
  );

  it.effect("refreshes authentication after expired-token revalidation fails", () =>
    Effect.gen(function* () {
      const mock = makeZeroMock();
      vi.mocked(createOAuthClientCredentialsToken)
        .mockReturnValueOnce(Effect.succeed(token("initial-token")))
        .mockReturnValueOnce(Effect.succeed(token("refreshed-token")));

      yield* runMakeZero(
        Effect.scoped(
          Effect.gen(function* () {
            yield* makeZero();
            mock.emit({
              name: "error",
              reason: "Fetch from API server returned non-OK status 500",
            });
            yield* waitForMockCalls(mock.connect, 1, "expired-token reconnect");

            expect(mock.connect).toHaveBeenCalledWith({ auth: "refreshed-token" });
          }),
        ),
      );
    }),
  );

  it.effect("retries when reconnecting resolves without reaching connected", () =>
    Effect.gen(function* () {
      const mock = makeZeroMock();
      mock.setNextConnectState({
        name: "needs-auth",
        reason: { type: "query", status: 401 },
      });
      vi.mocked(createOAuthClientCredentialsToken)
        .mockReturnValueOnce(Effect.succeed(token("initial-token")))
        .mockReturnValue(Effect.succeed(token("refreshed-token")));

      yield* runMakeZero(
        Effect.scoped(
          Effect.gen(function* () {
            yield* makeZero();
            mock.emit({
              name: "needs-auth",
              reason: { type: "query", status: 401 },
            });
            yield* waitForMockCalls(mock.connect, 1, "initial reconnect attempt");

            mock.setNextConnectState({ name: "connected" });
            yield* TestClock.adjust("1 second");
            yield* waitForMockCalls(mock.connect, 2, "connected reconnect retry");

            expect(mock.connect).toHaveBeenCalledTimes(2);
            expect(createOAuthClientCredentialsToken).toHaveBeenCalledTimes(3);
          }),
        ),
      );
    }),
  );

  it.effect("reuses refreshed authentication for ordinary reconnect failures", () =>
    Effect.gen(function* () {
      const mock = makeZeroMock();
      mock.setNextConnectState({ name: "disconnected", reason: "connection lost" });
      vi.mocked(createOAuthClientCredentialsToken)
        .mockReturnValueOnce(Effect.succeed(token("initial-token")))
        .mockReturnValue(Effect.succeed(token("refreshed-token")));

      yield* runMakeZero(
        Effect.scoped(
          Effect.gen(function* () {
            yield* makeZero();
            mock.emit({
              name: "needs-auth",
              reason: { type: "query", status: 401 },
            });
            yield* waitForMockCalls(mock.connect, 1, "initial reconnect attempt");

            mock.setNextConnectState({ name: "connected" });
            yield* TestClock.adjust("1 second");
            yield* waitForMockCalls(mock.connect, 2, "connected reconnect retry");

            expect(mock.connect).toHaveBeenCalledTimes(2);
            expect(createOAuthClientCredentialsToken).toHaveBeenCalledTimes(2);
          }),
        ),
      );
    }),
  );

  it.effect("closes Zero and unsubscribes during scope finalization", () =>
    Effect.gen(function* () {
      const mock = makeZeroMock();
      vi.mocked(createOAuthClientCredentialsToken).mockReturnValueOnce(
        Effect.succeed(token("initial-token")),
      );

      yield* runMakeZero(Effect.scoped(makeZero()));

      expect(mock.close).toHaveBeenCalledOnce();
      expect(mock.unsubscribe).toHaveBeenCalledOnce();
    }),
  );
});
