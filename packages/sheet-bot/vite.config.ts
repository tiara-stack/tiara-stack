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
      "sheet-ingress-api": fileURLToPath(new URL("../sheet-ingress-api/src", import.meta.url)),
      "sheet-db-schema": fileURLToPath(new URL("../sheet-db-schema/src", import.meta.url)),
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
