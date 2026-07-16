import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/index.mts", import.meta.url)),
      snapshot: fileURLToPath(new URL("src/snapshot.mts", import.meta.url)),
    },
    sourcemap: true,
    deps: {
      onlyBundle: false,
    },
    dts: false,
  },
  lint: {
    ignorePatterns: ["dist"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
