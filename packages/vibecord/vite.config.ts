import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/bot/index.ts", import.meta.url)),
      register: fileURLToPath(new URL("src/register.ts", import.meta.url)),
    },
    sourcemap: true,
    deps: {
      alwaysBundle: [/^.*$/],
      neverBundle: ["zlib-sync"],
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
