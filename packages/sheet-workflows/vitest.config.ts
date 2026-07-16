import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "sheet-auth/client": fileURLToPath(new URL("../sheet-auth/src/client.ts", import.meta.url)),
      "sheet-auth/oauth": fileURLToPath(new URL("../sheet-auth/src/oauth.ts", import.meta.url)),
      "sheet-auth/oauth-resource-authorization": fileURLToPath(
        new URL("../sheet-auth/src/oauth-resource-authorization.ts", import.meta.url),
      ),
      "sheet-ingress-api": fileURLToPath(new URL("../sheet-ingress-api/src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
