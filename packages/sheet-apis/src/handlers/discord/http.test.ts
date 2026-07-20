import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Effect, Exit, Logger, Metric, References } from "effect";
import { discordGuildCacheFailures } from "@/metrics/discord";
import { resolveCachedDiscordGuilds } from "./http";

class TestGuildCacheError extends Data.TaggedError("TestGuildCacheError")<{
  readonly message: string;
}> {}

describe("Discord guild cache lookup", () => {
  it.effect("returns every guild when all cache lookups succeed", () =>
    Effect.gen(function* () {
      const guilds = yield* resolveCachedDiscordGuilds(["guild-1", "guild-2"], (guildId) =>
        Effect.succeed({ id: guildId }),
      );

      expect(guilds).toEqual([{ id: "guild-1" }, { id: "guild-2" }]);
    }),
  );

  it.effect("logs, counts, and rejects mixed cache results", () => {
    const logEntries: Array<{
      readonly annotations: Readonly<Record<string, unknown>>;
      readonly message: unknown;
    }> = [];
    const logger = Logger.make(({ fiber, message }) => {
      logEntries.push({
        annotations: fiber.getRef(References.CurrentLogAnnotations),
        message,
      });
    });
    const failureMetric = Metric.withAttributes(discordGuildCacheFailures, {
      reason: "TestGuildCacheError",
    });

    return Effect.gen(function* () {
      const before = yield* Metric.value(failureMetric);
      const exit = yield* Effect.exit(
        resolveCachedDiscordGuilds(["guild-1", "guild-2", "guild-3"], (guildId) =>
          guildId === "guild-1"
            ? Effect.succeed({ id: guildId })
            : Effect.fail(new TestGuildCacheError({ message: "cache unavailable" })),
        ),
      );
      const after = yield* Metric.value(failureMetric);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) return;
      expect(Cause.squash(exit.cause)).toMatchObject({
        message: "Failed to resolve 2 of 3 Discord guilds from cache",
      });
      expect(after.count - before.count).toBe(2);
      expect(logEntries).toHaveLength(2);
      expect(logEntries).toContainEqual({
        annotations: expect.objectContaining({
          error: "cache unavailable",
          guildId: "guild-2",
          reason: "TestGuildCacheError",
        }),
        message: ["Discord guild cache lookup failed"],
      });
      expect(logEntries).toContainEqual({
        annotations: expect.objectContaining({
          error: "cache unavailable",
          guildId: "guild-3",
          reason: "TestGuildCacheError",
        }),
        message: ["Discord guild cache lookup failed"],
      });
    }).pipe(Effect.provide(Logger.layer([logger])));
  });
});
