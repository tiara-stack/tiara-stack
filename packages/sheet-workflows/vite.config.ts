import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "dfx-discord-utils/discord/schema": fileURLToPath(
        new URL("../dfx-discord-utils/src/discord/schema/index.ts", import.meta.url),
      ),
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
