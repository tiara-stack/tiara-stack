import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "effect-ai-codex": fileURLToPath(new URL("../effect-ai-codex/src/index.ts", import.meta.url)),
      "effect-ai-kimi": fileURLToPath(new URL("../effect-ai-kimi/src/index.ts", import.meta.url)),
    },
  },
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/index.ts", import.meta.url)),
    },
    sourcemap: true,
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
