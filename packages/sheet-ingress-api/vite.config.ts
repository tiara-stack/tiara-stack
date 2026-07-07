import { readdirSync } from "fs";
import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

const collectEntries = (relativeDir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(fileURLToPath(new URL(`./src/${relativeDir}`, import.meta.url)), {
      recursive: true,
      withFileTypes: true,
    })
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
      )
      .map((entry) => {
        const path = `${entry.parentPath}/${entry.name}`;
        const relativePath = path
          .slice(srcDir.length + 1)
          .replace(/\.ts$/, "")
          .replace(/\/index$/, "");

        return [relativePath, path];
      }),
  );

export default defineConfig({
  resolve: {
    alias: {
      "dfx-discord-utils/discord/api": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/api.ts", import.meta.url),
      ),
      "dfx-discord-utils/discord/schema": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/schema/index.ts", import.meta.url),
      ),
    },
  },
  pack: {
    entry: {
      "api-groups": fileURLToPath(new URL("./src/api-groups.ts", import.meta.url)),
      api: fileURLToPath(new URL("./src/api.ts", import.meta.url)),
      "auth/scopePolicy": fileURLToPath(new URL("./src/auth/scopePolicy.ts", import.meta.url)),
      clientActions: fileURLToPath(new URL("./src/clientActions.ts", import.meta.url)),
      tokenCache: fileURLToPath(new URL("./src/tokenCache.ts", import.meta.url)),
      "handlers/health/schema": fileURLToPath(
        new URL("./src/handlers/health/schema.ts", import.meta.url),
      ),
      "handlers/clientDelivery/api": fileURLToPath(
        new URL("./src/handlers/clientDelivery/api.ts", import.meta.url),
      ),
      index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      "middlewares/sheetAuthTokenAuthorization/tag": fileURLToPath(
        new URL("./src/middlewares/sheetAuthTokenAuthorization/tag.ts", import.meta.url),
      ),
      "middlewares/forwardedAuthHeaders": fileURLToPath(
        new URL("./src/middlewares/forwardedAuthHeaders.ts", import.meta.url),
      ),
      "middlewares/rpcTag": fileURLToPath(new URL("./src/middlewares/rpcTag.ts", import.meta.url)),
      "middlewares/rpcScopePolicy": fileURLToPath(
        new URL("./src/middlewares/rpcScopePolicy.ts", import.meta.url),
      ),
      "middlewares/sheetIngressServiceAuthorization/tag": fileURLToPath(
        new URL("./src/middlewares/sheetIngressServiceAuthorization/tag.ts", import.meta.url),
      ),
      "middlewares/sheetBotServiceAuthorization/tag": fileURLToPath(
        new URL("./src/middlewares/sheetBotServiceAuthorization/tag.ts", import.meta.url),
      ),
      "middlewares/sheetApisServiceUserFallback/tag": fileURLToPath(
        new URL("./src/middlewares/sheetApisServiceUserFallback/tag.ts", import.meta.url),
      ),
      "middlewares/sheetApisAnonymousUserFallback/tag": fileURLToPath(
        new URL("./src/middlewares/sheetApisAnonymousUserFallback/tag.ts", import.meta.url),
      ),
      "sheet-apis": fileURLToPath(new URL("./src/sheet-apis.ts", import.meta.url)),
      "sheet-apis-internal": fileURLToPath(
        new URL("./src/sheet-apis-internal.ts", import.meta.url),
      ),
      "sheet-apis-rpc": fileURLToPath(new URL("./src/sheet-apis-rpc.ts", import.meta.url)),
      "sheet-workflows": fileURLToPath(new URL("./src/sheet-workflows.ts", import.meta.url)),
      "sheet-workflows-internal": fileURLToPath(
        new URL("./src/sheet-workflows-internal.ts", import.meta.url),
      ),
      "sheet-workflows-rpc": fileURLToPath(
        new URL("./src/sheet-workflows-rpc.ts", import.meta.url),
      ),
      "sheet-workflows-workflows": fileURLToPath(
        new URL("./src/sheet-workflows-workflows.ts", import.meta.url),
      ),
      ...collectEntries("schemas"),
    },
    sourcemap: true,
    tsconfig: "tsconfig.build.json",
    alias: {
      "dfx-discord-utils/discord/api": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/api.ts", import.meta.url),
      ),
      "dfx-discord-utils/discord/schema": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/schema/index.ts", import.meta.url),
      ),
    },
    dts: {
      tsgo: true,
    },
    deps: {
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
