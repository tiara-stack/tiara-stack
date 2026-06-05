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
      "sheet-ingress-api": fileURLToPath(new URL("../sheet-ingress-api/src", import.meta.url)),
      "sheet-db-schema": fileURLToPath(new URL("../sheet-db-schema/src", import.meta.url)),
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
