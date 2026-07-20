import { Metric } from "effect";

export const discordGuildCacheFailures = Metric.counter("discord_guild_cache_failures_total", {
  description:
    "Discord guild cache lookups that failed while resolving the current user guilds, grouped by reason",
  incremental: true,
});
