// fallow-ignore-file code-duplication
import { defineConfig } from "vite-plus";
import { lightFormat } from "date-fns";
import { fileURLToPath } from "url";
import simpleGit from "simple-git";

const git = simpleGit();
const date = lightFormat(new Date(), "yyyyMMdd");
const hash = (await git.revparse("HEAD").catch(() => "unknown")).substring(0, 7);
const alwaysBundleDependencies = () => true;
const sheetDbSchemaModels = fileURLToPath(import.meta.resolve("sheet-db-schema/models"));
const declarationFilePattern = /\.d\.[cm]?ts$/;
const effectDeclarationExternalPlugin = () => ({
  name: "sheet-bot:external-effect-dts",
  resolveId: {
    order: "pre" as const,
    handler(id: string, importer?: string) {
      if (
        importer?.replaceAll("\\", "/").match(declarationFilePattern) &&
        id.startsWith("effect/")
      ) {
        return {
          id,
          external: true,
        };
      }
    },
  },
});

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "dfx-discord-utils": fileURLToPath(new URL("../dfx-discord-utils/src", import.meta.url)),
      "sheet-auth": fileURLToPath(new URL("../sheet-auth/src", import.meta.url)),
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
    alias: {
      "sheet-db-schema/models": sheetDbSchemaModels,
    },
    tsconfig: "tsconfig.build.json",
    dts: {
      tsgo: true,
    },
    plugins: [effectDeclarationExternalPlugin()],
    deps: {
      alwaysBundle: alwaysBundleDependencies,
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
