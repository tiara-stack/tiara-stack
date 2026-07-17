import { fileURLToPath } from "url";
import { app, packageEntries } from "tooling-config/vite";

const alwaysBundleDependencies = () => true;
const sheetDbSchemaModels = fileURLToPath(import.meta.resolve("sheet-db-schema/models"));

export default app({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "dfx-discord-utils/discord/api": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/api.ts", import.meta.url),
      ),
      "dfx-discord-utils/discord/schema": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/schema/index.ts", import.meta.url),
      ),
      "sheet-auth": fileURLToPath(new URL("../sheet-auth/src", import.meta.url)),
      "sheet-ingress-api": fileURLToPath(new URL("../sheet-ingress-api/src", import.meta.url)),
    },
  },
  pack: {
    entry: packageEntries(import.meta.url, ["./src/index.ts", "./src/**/index.ts"]),
    alias: {
      "sheet-db-schema/models": sheetDbSchemaModels,
    },
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: alwaysBundleDependencies,
    },
  },
});
