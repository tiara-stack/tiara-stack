import { fileURLToPath } from "node:url";
import { app } from "tooling-config/vite";

export default app({
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
  },
});
