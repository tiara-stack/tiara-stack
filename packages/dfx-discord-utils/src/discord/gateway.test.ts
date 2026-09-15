import { DiscordREST, Ix } from "dfx";
import { DiscordGateway, runIx } from "dfx/gateway";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber } from "effect";

describe("Discord interaction dispatch", () => {
  it.live("keeps a malformed message component from killing the interaction subscriber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let interactionHandler:
          | ((interaction: never) => Effect.Effect<unknown, unknown, never>)
          | undefined;
        const gateway = {
          handleDispatch: (event: string, handler: typeof interactionHandler) => {
            if (event === "INTERACTION_CREATE") {
              interactionHandler = handler;
            }
            return Effect.never;
          },
        };
        const rest = {
          getMyApplication: () => Effect.succeed({ id: "application-1" }),
          bulkSetApplicationCommands: () => Effect.succeed(undefined),
          bulkSetGuildApplicationCommands: () => Effect.succeed(undefined),
        };
        const interactionBuilder = Ix.builder.add(
          Ix.messageComponent(
            () => {
              throw new Error("component predicate failed");
            },
            Effect.succeed({ type: 4 } as never),
          ),
        );

        const registryFiber = yield* runIx(() => Effect.void)(interactionBuilder).pipe(
          Effect.provideService(DiscordGateway, gateway as never),
          Effect.provideService(DiscordREST, rest as never),
          Effect.forkScoped,
        );

        yield* Effect.sleep(Duration.millis(10));
        expect(interactionHandler).toBeDefined();

        const callbackExit = yield* Effect.exit(
          Effect.suspend(() =>
            interactionHandler!({
              id: "interaction-1",
              type: 3,
              data: { custom_id: "test" },
            } as never),
          ),
        );

        expect(Exit.isSuccess(callbackExit)).toBe(true);
        yield* Fiber.interrupt(registryFiber);
      }),
    ),
  );

  it.live("keeps interaction dispatch alive when command synchronization fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let interactionSubscriptions = 0;
        const gateway = {
          handleDispatch: (event: string) => {
            if (event === "INTERACTION_CREATE") {
              interactionSubscriptions += 1;
            }
            return Effect.never;
          },
        };
        const rest = {
          getMyApplication: () => Effect.succeed({ id: "application-1" }),
          bulkSetApplicationCommands: () => Effect.fail(new Error("command sync failed")),
          bulkSetGuildApplicationCommands: () => Effect.succeed(undefined),
        };

        const registryFiber = yield* runIx(() => Effect.void)(Ix.builder).pipe(
          Effect.provideService(DiscordGateway, gateway as never),
          Effect.provideService(DiscordREST, rest as never),
          Effect.forkScoped,
        );

        yield* Effect.sleep(Duration.millis(10));
        expect(interactionSubscriptions).toBe(1);
        expect(registryFiber.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(registryFiber);
      }),
    ),
  );
});
