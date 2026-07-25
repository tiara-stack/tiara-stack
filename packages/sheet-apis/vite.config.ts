import { fileURLToPath } from "url";
import { app } from "tooling-config/vite";

const alwaysBundleDependencies = () => true;
const sheetDbSchemaModels = fileURLToPath(import.meta.resolve("sheet-db-schema/models"));

export default app({
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
        testdb: fileURLToPath(new URL("./src/testdb.ts", import.meta.url)),
      },
      tsconfig: "tsconfig.build.json",
    },
    {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      alias: {
        "sheet-db-schema/models": sheetDbSchemaModels,
      },
      tsconfig: "tsconfig.build.json",
      deps: {
        alwaysBundle: alwaysBundleDependencies,
        neverBundle: ["playwright", "playwright-core"],
      },
    },
  ],
});
