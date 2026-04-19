import { defineConfig } from "vite-plus";
import { lightFormat } from "date-fns";
import simpleGit from "simple-git";

const git = simpleGit();
const date = lightFormat(new Date(), "yyyyMMdd");
const hash = (await git.revparse("HEAD").catch(() => "unknown")).substring(0, 7);

export default defineConfig({
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
      neverBundle: [
        /^(dfx-discord-utils|sheet-apis|sheet-auth|sheet-db-schema|typhoon-core)(?:\/.*)?$/,
      ],
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
