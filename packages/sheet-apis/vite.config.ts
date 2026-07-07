// fallow-ignore-file code-duplication
import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

const alwaysBundleDependencies = () => true;
const sheetDbSchemaModels = fileURLToPath(import.meta.resolve("sheet-db-schema/models"));

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "dfx-discord-utils": fileURLToPath(new URL("../dfx-discord-utils/src", import.meta.url)),
      "dfx-discord-utils/discord/cache/guilds": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/cache/guilds.ts", import.meta.url),
      ),
      "dfx-discord-utils/discord/cache/members": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/cache/members.ts", import.meta.url),
      ),
      "dfx-discord-utils/discord/cache/roles": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/cache/roles.ts", import.meta.url),
      ),
      "dfx-discord-utils/discord/schema": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/schema/index.ts", import.meta.url),
      ),
      "sheet-auth": fileURLToPath(new URL("../sheet-auth/src", import.meta.url)),
      "sheet-auth/client": fileURLToPath(new URL("../sheet-auth/src/client.ts", import.meta.url)),
      "sheet-ingress-api": fileURLToPath(new URL("../sheet-ingress-api/src", import.meta.url)),
    },
  },
  pack: [
    {
      entry: {
        "api-groups": fileURLToPath(new URL("./src/api-groups.ts", import.meta.url)),
        schema: fileURLToPath(new URL("./src/schema.ts", import.meta.url)),
      },
      sourcemap: true,
      tsconfig: "tsconfig.build.json",
      dts: {
        tsgo: true,
      },
      deps: {
        onlyBundle: false,
      },
    },
    {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      alias: {
        "sheet-db-schema/models": sheetDbSchemaModels,
      },
      sourcemap: true,
      tsconfig: "tsconfig.build.json",
      dts: {
        tsgo: true,
      },
      deps: {
        alwaysBundle: alwaysBundleDependencies,
        neverBundle: ["playwright", "playwright-core"],
        onlyBundle: false,
      },
    },
  ],
  lint: {
    ignorePatterns: ["dist"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
