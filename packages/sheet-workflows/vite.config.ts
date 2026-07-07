// fallow-ignore-file code-duplication
import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

const alwaysBundleDependencies = () => true;
const sheetDbSchemaModels = fileURLToPath(import.meta.resolve("sheet-db-schema/models"));

export default defineConfig({
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
      sourcemap: true,
      tsconfig: "tsconfig.build.json",
      dts: {
        tsgo: true,
      },
      deps: {
        alwaysBundle: alwaysBundleDependencies,
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
