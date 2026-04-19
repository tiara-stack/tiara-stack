import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      entry: {
        api: fileURLToPath(new URL("./src/api.ts", import.meta.url)),
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
        neverBundle: [
          "playwright",
          "playwright-core",
          /^(dfx-discord-utils|sheet-auth|sheet-db-schema|typhoon-core)(?:\/.*)?$/,
        ],
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
