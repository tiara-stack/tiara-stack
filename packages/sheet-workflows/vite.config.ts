import { fileURLToPath } from "url";
import { app } from "tooling-config/vite";

const alwaysBundleDependencies = () => true;
const sheetDbSchemaModels = fileURLToPath(import.meta.resolve("sheet-db-schema/models"));

export default app({
  resolve: {
    alias: {
      "sheet-auth/client": fileURLToPath(new URL("../sheet-auth/src/client.ts", import.meta.url)),
      "sheet-auth/oauth": fileURLToPath(new URL("../sheet-auth/src/oauth.ts", import.meta.url)),
      "sheet-auth/oauth-resource-authorization": fileURLToPath(
        new URL("../sheet-auth/src/oauth-resource-authorization.ts", import.meta.url),
      ),
    },
  },
  pack: [
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
      },
    },
  ],
});
