import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

const alwaysBundleDependencies = () => true;
const sheetIngressApiDist = fileURLToPath(new URL("../sheet-ingress-api/dist", import.meta.url));
const sheetDbSchemaModels = fileURLToPath(import.meta.resolve("sheet-db-schema/models"));

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
    },
  },
  pack: [
    {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      alias: {
        "sheet-db-schema/models": sheetDbSchemaModels,
        "sheet-ingress-api": sheetIngressApiDist,
      },
      sourcemap: true,
      deps: {
        alwaysBundle: alwaysBundleDependencies,
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
