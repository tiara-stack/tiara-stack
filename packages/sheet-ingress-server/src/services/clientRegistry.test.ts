import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer } from "effect";
import { ClientRegistry } from "./clientRegistry";

const makeConfigLayer = (
  entries: Array<{
    platform: string;
    clientId: string;
    baseUrl: string;
    serviceTokenResource: string;
  }>,
) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        SHEET_CLIENTS: JSON.stringify(entries),
        PORT: "3000",
        SHEET_APIS_BASE_URL: "http://sheet-apis",
        SHEET_WORKFLOWS_BASE_URL: "http://sheet-workflows",
        SHEET_BOT_BASE_URL: "http://sheet-bot",
        SHEET_AUTH_ISSUER: "http://auth",
        SHEET_AUTH_OAUTH_CLIENT_ID: "client-id",
        SHEET_AUTH_OAUTH_CLIENT_SECRET: "secret",
        TRUSTED_ORIGINS: "http://localhost",
      },
    }),
  );

describe("ClientRegistry", () => {
  it.effect("resolves multiple client entries to different base URLs", () =>
    Effect.gen(function* () {
      const configLayer = makeConfigLayer([
        {
          platform: "discord",
          clientId: "discord-main",
          baseUrl: "http://sheet-bot-discord-main:3000",
          serviceTokenResource: "sheet-bot",
        },
        {
          platform: "discord",
          clientId: "discord-alt",
          baseUrl: "http://sheet-bot-discord-alt:3000",
          serviceTokenResource: "sheet-bot-alt",
        },
      ]);

      const registry = yield* Effect.provide(
        ClientRegistry,
        Layer.provide(ClientRegistry.layer, configLayer),
      );

      const mainEntry = yield* registry.resolve({ platform: "discord", clientId: "discord-main" });
      expect(mainEntry.baseUrl).toBe("http://sheet-bot-discord-main:3000");
      expect(mainEntry.serviceTokenResource).toBe("sheet-bot");

      const altEntry = yield* registry.resolve({ platform: "discord", clientId: "discord-alt" });
      expect(altEntry.baseUrl).toBe("http://sheet-bot-discord-alt:3000");
      expect(altEntry.serviceTokenResource).toBe("sheet-bot-alt");
    }),
  );

  it.effect("fails for unknown client refs", () =>
    Effect.gen(function* () {
      const configLayer = makeConfigLayer([
        {
          platform: "discord",
          clientId: "discord-main",
          baseUrl: "http://sheet-bot-discord-main:3000",
          serviceTokenResource: "sheet-bot",
        },
      ]);

      const registry = yield* Effect.provide(
        ClientRegistry,
        Layer.provide(ClientRegistry.layer, configLayer),
      );

      const exit = yield* Effect.exit(
        registry.resolve({ platform: "discord", clientId: "unknown-client" }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
