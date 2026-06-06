import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "dfx-discord-utils/discord/schema": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/schema/index.ts", import.meta.url),
      ),
      "sheet-db-schema/models": fileURLToPath(
        new URL("../sheet-db-schema/src/models.ts", import.meta.url),
      ),
      "sheet-db-schema/zero": fileURLToPath(
        new URL("../sheet-db-schema/src/zero/index.ts", import.meta.url),
      ),
      "sheet-db-schema": fileURLToPath(new URL("../sheet-db-schema/src", import.meta.url)),
      "sheet-auth/client": fileURLToPath(new URL("../sheet-auth/src/client.ts", import.meta.url)),
      "sheet-auth/plugins/kubernetes-oauth/rpc-authorization": fileURLToPath(
        new URL("../sheet-auth/src/plugins/kubernetes-oauth/rpc-authorization.ts", import.meta.url),
      ),
      "sheet-auth/plugins/kubernetes-oauth": fileURLToPath(
        new URL("../sheet-auth/src/plugins/kubernetes-oauth/index.ts", import.meta.url),
      ),
      "sheet-ingress-api/middlewares/forwardedAuthHeaders": fileURLToPath(
        new URL("../sheet-ingress-api/src/middlewares/forwardedAuthHeaders.ts", import.meta.url),
      ),
      "sheet-ingress-api/api": fileURLToPath(
        new URL("../sheet-ingress-api/src/api.ts", import.meta.url),
      ),
      "sheet-ingress-api/discordComponents": fileURLToPath(
        new URL("../sheet-ingress-api/src/discordComponents.ts", import.meta.url),
      ),
      "sheet-ingress-api/handlers": fileURLToPath(
        new URL("../sheet-ingress-api/src/handlers", import.meta.url),
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
      "sheet-ingress-api/sheet-apis": fileURLToPath(
        new URL("../sheet-ingress-api/src/sheet-apis.ts", import.meta.url),
      ),
      "sheet-ingress-api/sheet-workflows-rpc": fileURLToPath(
        new URL("../sheet-ingress-api/src/sheet-workflows-rpc.ts", import.meta.url),
      ),
      "sheet-ingress-api/sheet-workflows-workflows": fileURLToPath(
        new URL("../sheet-ingress-api/src/sheet-workflows-workflows.ts", import.meta.url),
      ),
      "sheet-ingress-api": fileURLToPath(new URL("../sheet-ingress-api/src", import.meta.url)),
    },
  },
  pack: [
    {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      sourcemap: true,
      deps: {
        alwaysBundle: [/^.*$/],
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
