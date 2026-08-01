import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { ConfigProvider, Duration, Effect, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import {
  createOAuthClientCredentialsToken,
  createSheetAuthClient,
  OAuthClientCredentialsTokenError,
} from "sheet-auth/client";
import {
  makeZero,
  runProactiveZeroAuthRefresh,
  shouldRefreshZeroAuth,
  zeroAuthRefreshDelay,
} from "./zeroClient";
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

type ConnectionState = Parameters<typeof shouldRefreshZeroAuth>[0];

const needsAuthState = {
  name: "needs-auth",
  reason: { type: "query", status: 401 },
} satisfies ConnectionState;

const token = (accessToken: string, expiresAt = 2_000_000_000) => ({
  accessToken: Redacted.make(accessToken),
  expiresAt,
  expiresIn: 3600,
  scope: "service",
  tokenType: "Bearer" as const,
});

const authError = () =>
  new OAuthClientCredentialsTokenError({
    message: "auth unavailable",
    statusText: "SERVICE_UNAVAILABLE",
  });

const configLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    SHEET_AUTH_OAUTH_CLIENT_ID: "sheet-apis",
    SHEET_AUTH_OAUTH_CLIENT_SECRET: "client-secret",
    ZERO_CACHE_SERVER: "http://zero-cache.test",
    ZERO_CACHE_USER_ID: "sheet-apis",
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

describe("sheet Zero OAuth refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    zeroConstructor.mockReset();
  });

  it("refreshes one minute before token expiry", () => {
    expect(Duration.toMillis(zeroAuthRefreshDelay(3_700, 100))).toBe(
      Duration.toMillis(Duration.minutes(59)),
    );
  });

  it("uses a non-zero delay for already-expired tokens", () => {
    expect(Duration.toMillis(zeroAuthRefreshDelay(100, 100))).toBe(
      Duration.toMillis(Duration.seconds(1)),
    );
  });

  it("refreshes only for explicit authentication failures", () => {
    expect(
      shouldRefreshZeroAuth({
        name: "needs-auth",
        reason: { type: "query", status: 401 },
      }),
    ).toBe(true);
    // zero-cache revalidation of an expired service token surfaces as an
    // "error" state with the TransformFailed message — must recover.
    expect(
      shouldRefreshZeroAuth({
        name: "error",
        reason: "Fetch from API server returned non-OK status 500",
      }),
    ).toBe(true);
    expect(shouldRefreshZeroAuth({ name: "error", reason: "Zero cache crashed" })).toBe(false);
    expect(shouldRefreshZeroAuth({ name: "connected" })).toBe(false);
  });

  it.effect("keeps scheduling proactive refreshes from each replacement token", () =>
    Effect.gen(function* () {
      const refresh = vi
        .fn(() => Effect.succeed({ auth: "second", refreshAfter: Duration.seconds(20) }))
        .mockReturnValueOnce(Effect.succeed({ auth: "first", refreshAfter: Duration.seconds(10) }));
      const fiber = yield* runProactiveZeroAuthRefresh(Duration.seconds(5), refresh).pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(4));
      expect(refresh).not.toHaveBeenCalled();
      yield* TestClock.adjust(Duration.seconds(1));
      expect(refresh).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(Duration.seconds(9));
      expect(refresh).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(Duration.seconds(1));
      expect(refresh).toHaveBeenCalledTimes(2);

      yield* Fiber.interrupt(fiber);
    }),
  );

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
        .mockReturnValueOnce(Effect.fail(authError()))
        .mockReturnValueOnce(Effect.succeed(token("recovered-token")));

      const fiber = yield* runMakeZero(Effect.scoped(makeZero())).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      let completed = false;
      let iterations = 0;
      for (; !completed && iterations < 3; iterations += 1) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
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
            mock.emit(needsAuthState);
            yield* waitForMockCalls(mock.connect, 1, "needs-auth reconnect");

            expect(mock.connect).toHaveBeenCalledWith({ auth: "refreshed-token" });
          }),
        ),
      );
    }),
  );

  it.effect("keeps retrying connection-state authentication until it recovers", () =>
    Effect.gen(function* () {
      const mock = makeZeroMock();
      const getToken = vi.mocked(createOAuthClientCredentialsToken);
      getToken.mockReturnValueOnce(Effect.succeed(token("initial-token")));
      for (let attempt = 0; attempt < 6; attempt += 1) {
        getToken.mockReturnValueOnce(Effect.fail(authError()));
      }
      getToken
        .mockReturnValueOnce(Effect.succeed(token("recovered-token")))
        .mockReturnValue(Effect.succeed(token("recovered-token")));

      yield* runMakeZero(
        Effect.scoped(
          Effect.gen(function* () {
            yield* makeZero();
            mock.emit(needsAuthState);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(Duration.seconds(30));
            yield* waitForMockCalls(mock.connect, 1, "recovered authentication reconnect");

            expect(getToken).toHaveBeenCalledTimes(8);
            expect(mock.connect).toHaveBeenCalledWith({ auth: "recovered-token" });
          }),
        ),
      );
    }),
  );

  it.effect("retries when reconnecting does not reach the connected state", () =>
    Effect.gen(function* () {
      const mock = makeZeroMock();
      mock.setNextConnectState(needsAuthState);
      vi.mocked(createOAuthClientCredentialsToken)
        .mockReturnValueOnce(Effect.succeed(token("initial-token")))
        .mockReturnValue(Effect.succeed(token("refreshed-token")));

      yield* runMakeZero(
        Effect.scoped(
          Effect.gen(function* () {
            yield* makeZero();
            mock.emit(needsAuthState);
            yield* waitForMockCalls(mock.connect, 1, "initial reconnect attempt");

            expect(mock.connect).toHaveBeenCalledTimes(1);
            mock.setNextConnectState({ name: "connected" });
            yield* TestClock.adjust(Duration.seconds(1));
            yield* waitForMockCalls(mock.connect, 2, "fresh-auth reconnect retry");

            expect(mock.connect).toHaveBeenCalledTimes(2);
            expect(createOAuthClientCredentialsToken).toHaveBeenCalledTimes(3);
          }),
        ),
      );
    }),
  );

  it.effect("reuses refreshed authentication while retrying a disconnected state", () =>
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
            mock.emit(needsAuthState);
            yield* waitForMockCalls(mock.connect, 1, "initial disconnected reconnect");

            expect(mock.connect).toHaveBeenCalledTimes(1);
            mock.setNextConnectState({ name: "connected" });
            yield* TestClock.adjust(Duration.seconds(1));
            yield* waitForMockCalls(mock.connect, 2, "disconnected reconnect retry");

            expect(mock.connect).toHaveBeenCalledTimes(2);
            expect(createOAuthClientCredentialsToken).toHaveBeenCalledTimes(2);
          }),
        ),
      );
    }),
  );

  it.effect("uses the Effect clock to schedule proactive refresh", () =>
    Effect.gen(function* () {
      const mock = makeZeroMock();
      vi.mocked(createOAuthClientCredentialsToken)
        .mockReturnValueOnce(Effect.succeed(token("initial-token", 70)))
        .mockReturnValueOnce(Effect.succeed(token("proactive-token", 100)));

      yield* runMakeZero(
        Effect.scoped(
          Effect.gen(function* () {
            yield* makeZero();
            yield* TestClock.adjust(Duration.seconds(9));
            expect(mock.connect).not.toHaveBeenCalled();
            yield* TestClock.adjust(Duration.seconds(1));

            expect(mock.connect).toHaveBeenCalledWith({ auth: "proactive-token" });
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
