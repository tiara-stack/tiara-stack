import { fileURLToPath } from "url";
import { library, packageEntries } from "tooling-config/vite";

const directEntries = {
  "discord/api": fileURLToPath(new URL("./src/discord/api.ts", import.meta.url)),
  "discord/cache": fileURLToPath(new URL("./src/discord/cache/index.ts", import.meta.url)),
  "discord/cache/shared": fileURLToPath(new URL("./src/discord/cache/shared.ts", import.meta.url)),
  "discord/cache/guilds": fileURLToPath(new URL("./src/discord/cache/guilds.ts", import.meta.url)),
  "discord/cache/roles": fileURLToPath(new URL("./src/discord/cache/roles.ts", import.meta.url)),
  "discord/cache/members": fileURLToPath(
    new URL("./src/discord/cache/members.ts", import.meta.url),
  ),
  "discord/cache/channels": fileURLToPath(
    new URL("./src/discord/cache/channels.ts", import.meta.url),
  ),
  "discord/schema": fileURLToPath(new URL("./src/discord/schema/index.ts", import.meta.url)),
  "discord/gateway": fileURLToPath(new URL("./src/discord/gateway.ts", import.meta.url)),
  "discord/http": fileURLToPath(new URL("./src/discord/http.ts", import.meta.url)),
  "discord/discordApiClient": fileURLToPath(
    new URL("./src/discord/discordApiClient.ts", import.meta.url),
  ),
};

export default library({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  pack: {
    entry: {
      ...packageEntries(import.meta.url, ["./src/index.ts", "./src/*/index.ts"]),
      ...directEntries,
    },
    deps: {
      neverBundle: ["@effect/platform", "@effect/platform-node", "dfx", "effect"],
    },
  },
});
