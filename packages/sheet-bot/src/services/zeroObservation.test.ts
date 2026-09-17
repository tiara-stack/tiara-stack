import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { ConnectionState } from "@rocicorp/zero";
import { vi } from "vitest";
import { schema } from "sheet-zero-api";
import { makeResilientSheetZero } from "./zeroObservation";

const fakeZero = vi.hoisted(() => {
  type Listener = (state: ConnectionState) => void;

  class FakeConnectionState {
    current: ConnectionState = { name: "connected" };
    private readonly listeners = new Set<Listener>();

    subscribe(listener: Listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(state: ConnectionState) {
      this.current = state;
      for (const listener of this.listeners) listener(state);
    }
  }

  class FakeConnection {
    readonly state = new FakeConnectionState();
    readonly authTokens: string[] = [];
    nextState: ConnectionState = { name: "connected" };

    async connect(options: { readonly auth: string }) {
      this.authTokens.push(options.auth);
      this.state.emit(this.nextState);
    }
  }

  class FakeZero {
    static readonly instances: FakeZero[] = [];
    readonly connection = new FakeConnection();
    closed = false;

    constructor(readonly options: Record<string, unknown>) {
      FakeZero.instances.push(this);
    }

    async close() {
      this.closed = true;
    }
  }

  return { FakeZero, instances: FakeZero.instances };
});

vi.mock("@rocicorp/zero", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rocicorp/zero")>()),
  Zero: fakeZero.FakeZero,
}));

const connectedAuth = (token: string) => ({
  accessToken: token,
  expiresAtEpochSeconds: 2_000,
});

describe("resilient Sheet Zero observation", () => {
  it.effect("reconnects the same owner with refreshed credentials", () =>
    Effect.gen(function* () {
      const get = vi.fn(() => Effect.succeed(connectedAuth("initial")));
      const refresh = vi.fn(() => Effect.succeed(connectedAuth("refreshed")));
      let zero: (typeof fakeZero.instances)[number] | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const resilient = yield* makeResilientSheetZero({
            cacheURL: "https://zero.example.test",
            userID: "user-1",
            storageKey: "observation:user-1",
            schema,
            auth: { get, refresh },
          });
          zero = fakeZero.instances.at(-1);
          if (zero === undefined) return yield* Effect.die("Fake Zero was not constructed");

          zero.connection.state.emit({
            name: "needs-auth",
            reason: { type: "query", status: 401 },
          });
          yield* TestClock.adjust(Duration.millis(10));

          expect(get).toHaveBeenCalledOnce();
          expect(refresh).toHaveBeenCalledOnce();
          expect(zero.connection.authTokens).toEqual(["refreshed"]);
          expect(zero.options).toMatchObject({
            cacheURL: "https://zero.example.test",
            userID: "user-1",
            storageKey: "observation:user-1",
          });
          expect(resilient.zero).toBe(zero);
        }),
      );

      expect(zero?.closed).toBe(true);
    }),
  );

  it.effect("fails permanently when refreshed credentials are rejected", () =>
    Effect.gen(function* () {
      const refresh = vi.fn(() => Effect.succeed(connectedAuth("still-invalid")));
      let zero: (typeof fakeZero.instances)[number] | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const resilient = yield* makeResilientSheetZero({
            cacheURL: "https://zero.example.test",
            userID: "user-2",
            schema,
            auth: {
              get: () => Effect.succeed(connectedAuth("initial")),
              refresh,
            },
          });
          zero = fakeZero.instances.at(-1);
          if (zero === undefined) return yield* Effect.die("Fake Zero was not constructed");
          zero.connection.nextState = {
            name: "needs-auth",
            reason: { type: "query", status: 403 },
          };
          zero.connection.state.emit({
            name: "needs-auth",
            reason: { type: "query", status: 401 },
          });

          const failureFiber = yield* Stream.runHead(resilient.permanentAuthorizationFailure).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          yield* TestClock.adjust(Duration.seconds(1));
          const failure = yield* Fiber.join(failureFiber);
          expect(Exit.isFailure(failure)).toBe(true);
          expect(refresh).toHaveBeenCalledOnce();
        }),
      );

      expect(zero?.closed).toBe(true);
    }),
  );
});
