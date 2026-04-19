import { globSync } from "glob";
import path from "pathe";
import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

const filePaths = [
  ...globSync("./src/index.ts", { nodir: true }).map((file) =>
    fileURLToPath(new URL(file, import.meta.url)),
  ),
  ...globSync("./src/*/index.ts", { nodir: true }).map((file) =>
    fileURLToPath(new URL(file, import.meta.url)),
  ),
];

const directEntries = {
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
};

export default defineConfig({
  pack: {
    entry: {
      ...Object.fromEntries(
        filePaths.map((filePath) => {
          const relativePath = path.relative("./src", filePath);
          const parsed = path.parse(relativePath);
          const module = path.join(parsed.dir.replace(/\.+\//g, ""), parsed.name);

          return [module, filePath];
        }),
      ),
      ...directEntries,
    },
    sourcemap: true,
    deps: {
      neverBundle: ["@effect/platform", "@effect/platform-node", "dfx", "effect"],
      onlyBundle: false,
    },
    dts: {
      tsgo: true,
    },
  },
  lint: {
    ignorePatterns: ["dist"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
