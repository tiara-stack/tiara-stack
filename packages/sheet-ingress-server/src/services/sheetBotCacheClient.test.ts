import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Layer, Option } from "effect";
import { SheetBotCacheClient } from "./sheetBotCacheClient";
import { SheetBotForwardingClient } from "./sheetBotForwardingClient";

const makeSheetBotForwardingClient = ({
  getMember = vi.fn(() =>
    Effect.succeed({
      value: {
        roles: ["role-1"],
      },
    }),
  ),
  getRolesForParent = vi.fn(() =>
    Effect.succeed([
      {
        value: {
          id: "role-1",
          permissions: "8",
        },
      },
    ]),
  ),
}: {
  readonly getMember?: ReturnType<typeof vi.fn>;
  readonly getRolesForParent?: ReturnType<typeof vi.fn>;
} = {}) => ({
  client: {
    application: {
      getApplication: vi.fn(() => Effect.succeed({ ownerId: "owner-1" })),
    },
    cache: {
      getMember,
      getRolesForParent,
    },
  } as never,
  getMember,
  getRolesForParent,
});

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  sheetBotForwardingClient: typeof SheetBotForwardingClient.Service,
) =>
  effect.pipe(
    Effect.provide(Layer.effect(SheetBotCacheClient, SheetBotCacheClient.make)),
    Effect.provideService(SheetBotForwardingClient, sheetBotForwardingClient),
  );

describe("SheetBotCacheClient", () => {
  it("maps missing bot cache members to Option.none", async () => {
    const { client, getMember } = makeSheetBotForwardingClient({
      getMember: vi.fn(() =>
        Effect.fail({
          _tag: "CacheNotFoundError",
          message: "Member not found",
        }),
      ),
    });

    const result = await Effect.runPromise(
      run(
        Effect.gen(function* () {
          const cache = yield* SheetBotCacheClient;
          return yield* cache.getMember("guild-1", "user-1");
        }),
        client,
      ),
    );

    expect(Option.isNone(result)).toBe(true);
    expect(getMember).toHaveBeenCalledWith({
      params: { parentId: "guild-1", resourceId: "user-1" },
    });
  });

  it("converts role cache entries to a role map", async () => {
    const { client, getRolesForParent } = makeSheetBotForwardingClient();

    const result = await Effect.runPromise(
      run(
        Effect.gen(function* () {
          const cache = yield* SheetBotCacheClient;
          return yield* cache.getRolesForGuild("guild-1");
        }),
        client,
      ),
    );

    expect(result).toEqual(new Map([["role-1", { id: "role-1", permissions: "8" }]]));
    expect(getRolesForParent).toHaveBeenCalledWith({
      params: { parentId: "guild-1" },
    });
  });
});
