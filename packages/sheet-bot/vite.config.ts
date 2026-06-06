import { defineConfig } from "vite-plus";
import { lightFormat } from "date-fns";
import { fileURLToPath } from "url";
import simpleGit from "simple-git";

const git = simpleGit();
const date = lightFormat(new Date(), "yyyyMMdd");
const hash = (await git.revparse("HEAD").catch(() => "unknown")).substring(0, 7);

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "sheet-db-schema/models": fileURLToPath(
        new URL("../sheet-db-schema/src/models.ts", import.meta.url),
      ),
      "sheet-db-schema/zero": fileURLToPath(
        new URL("../sheet-db-schema/src/zero/index.ts", import.meta.url),
      ),
      "sheet-db-schema": fileURLToPath(new URL("../sheet-db-schema/src", import.meta.url)),
      "sheet-ingress-api/discordComponents": fileURLToPath(
        new URL("../sheet-ingress-api/src/discordComponents.ts", import.meta.url),
      ),
      "sheet-ingress-api/middlewares": fileURLToPath(
        new URL("../sheet-ingress-api/src/middlewares", import.meta.url),
      ),
      "sheet-ingress-api/schemas": fileURLToPath(
        new URL("../sheet-ingress-api/src/schemas", import.meta.url),
      ),
      "sheet-ingress-api/sheet-apis-rpc": fileURLToPath(
        new URL("../sheet-ingress-api/src/sheet-apis-rpc.ts", import.meta.url),
      ),
      "sheet-ingress-api/sheet-workflows": fileURLToPath(
        new URL("../sheet-ingress-api/src/sheet-workflows.ts", import.meta.url),
      ),
      "sheet-ingress-api": fileURLToPath(new URL("../sheet-ingress-api/src", import.meta.url)),
    },
  },
  pack: {
    entry: {
      index: "src/index.ts",
      main: "src/main.ts",
    },
    sourcemap: true,
    env: {
      BUILD_DATE: date,
      BUILD_HASH: hash,
      BUILD_VERSION: `${date}-${hash}`,
    },
    deps: {
      alwaysBundle: [/^.*$/],
      onlyBundle: false,
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
