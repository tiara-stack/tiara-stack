import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      KimiClient: fileURLToPath(new URL("src/KimiClient.ts", import.meta.url)),
      KimiConfig: fileURLToPath(new URL("src/KimiConfig.ts", import.meta.url)),
      KimiError: fileURLToPath(new URL("src/KimiError.ts", import.meta.url)),
      KimiLanguageModel: fileURLToPath(new URL("src/KimiLanguageModel.ts", import.meta.url)),
      KimiTelemetry: fileURLToPath(new URL("src/KimiTelemetry.ts", import.meta.url)),
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
