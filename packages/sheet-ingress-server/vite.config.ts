import { globSync } from "glob";
import path from "pathe";
import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

const filePaths = [
  ...globSync("./src/index.ts", { nodir: true }).map((file) =>
    fileURLToPath(new URL(file, import.meta.url)),
  ),
  ...globSync("./src/**/index.ts", { nodir: true }).map((file) =>
    fileURLToPath(new URL(file, import.meta.url)),
  ),
];

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
      "sheet-ingress-api/api": fileURLToPath(
        new URL("../sheet-ingress-api/src/api.ts", import.meta.url),
      ),
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
      "sheet-ingress-api/sheet-workflows-rpc": fileURLToPath(
        new URL("../sheet-ingress-api/src/sheet-workflows-rpc.ts", import.meta.url),
      ),
      "sheet-ingress-api/sheet-workflows-workflows": fileURLToPath(
        new URL("../sheet-ingress-api/src/sheet-workflows-workflows.ts", import.meta.url),
      ),
      "sheet-ingress-api": fileURLToPath(new URL("../sheet-ingress-api/src", import.meta.url)),
    },
  },
  pack: {
    entry: Object.fromEntries(
      filePaths.map((filePath) => {
        const relativePath = path.relative("./src", filePath);
        const parsed = path.parse(relativePath);
        const module = path.join(parsed.dir.replace(/\.+\//g, ""), parsed.name);

        return [module, filePath];
      }),
    ),
    sourcemap: true,
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
