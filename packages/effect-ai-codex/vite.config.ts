import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      CodexClient: fileURLToPath(new URL("src/CodexClient.ts", import.meta.url)),
      CodexConfig: fileURLToPath(new URL("src/CodexConfig.ts", import.meta.url)),
      CodexError: fileURLToPath(new URL("src/CodexError.ts", import.meta.url)),
      CodexLanguageModel: fileURLToPath(new URL("src/CodexLanguageModel.ts", import.meta.url)),
      CodexTelemetry: fileURLToPath(new URL("src/CodexTelemetry.ts", import.meta.url)),
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
