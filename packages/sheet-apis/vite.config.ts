import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "sheet-ingress-api/middlewares/forwardedAuthHeaders": fileURLToPath(
        new URL("../sheet-ingress-api/src/middlewares/forwardedAuthHeaders.ts", import.meta.url),
      ),
      "sheet-ingress-api": fileURLToPath(new URL("../sheet-ingress-api/src", import.meta.url)),
      "sheet-db-schema": fileURLToPath(new URL("../sheet-db-schema/src", import.meta.url)),
    },
  },
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
      sourcemap: true,
      deps: {
        alwaysBundle: [/^.*$/],
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
