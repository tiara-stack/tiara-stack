import { DiscordConfig, Intents } from "dfx";
import { Config, Effect, Redacted } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { discordConfigLayer } from "./config";

const getTestConfig = (options: Parameters<typeof discordConfigLayer>[0]) =>
  Effect.gen(function* () {
    return yield* DiscordConfig.DiscordConfig;
  }).pipe(Effect.provide(discordConfigLayer(options)));

describe("discordConfigLayer", () => {
  it.effect("builds dfx Discord config from Effect configs", () =>
    Effect.gen(function* () {
      const config = yield* getTestConfig({
        token: Config.succeed(Redacted.make("discord-token")),
        intents: Config.succeed(Intents.fromList(["Guilds"])),
      });

      expect(Redacted.value(config.token)).toBe("discord-token");
      expect(Intents.toList(config.gateway.intents)).toEqual(["Guilds", "GuildMembers"]);
    }),
  );

  it.effect("defaults Discord intents when omitted", () =>
    Effect.gen(function* () {
      const config = yield* getTestConfig({
        token: Config.succeed(Redacted.make("discord-token")),
      });

      expect(Redacted.value(config.token)).toBe("discord-token");
      expect(Intents.toList(config.gateway.intents)).toEqual(["Guilds", "GuildMembers"]);
    }),
  );
});
