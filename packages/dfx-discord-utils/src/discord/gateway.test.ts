import { DiscordREST, Ix } from "dfx";
import { DiscordGateway, runIx } from "dfx/gateway";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

describe("Discord interaction dispatch", () => {
  it.live("keeps a malformed message component from killing the interaction subscriber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const interactionReady = yield* Deferred.make<void>();
        let interactionHandler:
          | ((interaction: never) => Effect.Effect<unknown, unknown, never>)
          | undefined;
        const gateway = {
          handleDispatch: (event: string, handler: typeof interactionHandler) => {
            return Effect.sync(() => {
              if (event === "INTERACTION_CREATE") {
                interactionHandler = handler;
              }
            }).pipe(
              Effect.andThen(
                event === "INTERACTION_CREATE"
                  ? Deferred.succeed(interactionReady, undefined)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never),
            );
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

        yield* Deferred.await(interactionReady);
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
        const interactionReady = yield* Deferred.make<void>();
        const commandSyncAttempted = yield* Deferred.make<void>();
        let synchronizationAttempts = 0;
        let interactionSubscriptionAttempts = 0;
        const gateway = {
          handleDispatch: (event: string) => {
            if (event !== "INTERACTION_CREATE") return Effect.never;
            return Effect.suspend(() => {
              interactionSubscriptionAttempts += 1;
              return interactionSubscriptionAttempts === 1
                ? Effect.fail(new Error("interaction subscription failed"))
                : Deferred.succeed(interactionReady, undefined).pipe(Effect.andThen(Effect.never));
            });
          },
        };
        const rest = {
          getMyApplication: () => Effect.succeed({ id: "application-1" }),
          bulkSetApplicationCommands: () =>
            Effect.suspend(() => {
              synchronizationAttempts += 1;
              const failure = Effect.fail(new Error("command sync failed"));
              return synchronizationAttempts === 2
                ? failure.pipe(Effect.ensuring(Deferred.succeed(commandSyncAttempted, undefined)))
                : failure;
            }),
          bulkSetGuildApplicationCommands: () => Effect.succeed(undefined),
        };

        const registryFiber = yield* runIx(() => Effect.void)(Ix.builder).pipe(
          Effect.provideService(DiscordGateway, gateway as never),
          Effect.provideService(DiscordREST, rest as never),
          Effect.forkScoped,
        );

        yield* Deferred.await(interactionReady);
        yield* Deferred.await(commandSyncAttempted);
        expect(interactionSubscriptionAttempts).toBe(2);
        expect(synchronizationAttempts).toBe(2);
        expect(registryFiber.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(registryFiber);
      }),
    ),
  );
});
