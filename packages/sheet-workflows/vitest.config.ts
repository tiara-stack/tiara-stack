import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
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
  test: {
    include: ["src/**/*.test.ts"],
  },
});
