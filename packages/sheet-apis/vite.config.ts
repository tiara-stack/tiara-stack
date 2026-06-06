import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

const alwaysBundleDependencies = () => true;
const sheetIngressApiDist = fileURLToPath(new URL("../sheet-ingress-api/dist", import.meta.url));
const sheetDbSchemaModels = fileURLToPath(import.meta.resolve("sheet-db-schema/models"));

export default defineConfig({
  pack: [
    {
      entry: {
        "api-groups": fileURLToPath(new URL("./src/api-groups.ts", import.meta.url)),
        schema: fileURLToPath(new URL("./src/schema.ts", import.meta.url)),
      },
      sourcemap: true,
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
        "sheet-ingress-api": sheetIngressApiDist,
      },
      sourcemap: true,
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
