import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      "packages/sheet-web/src/routeTree.gen.ts",
      "charts/tiara-stack/templates",
      "dist",
      ".output",
      ".ts-out",
      "node_modules",
    ],
  },
  lint: {
    ignorePatterns: [".output", ".ts-out", "dist", "node_modules"],
    jsPlugins: ["./packages/effect-lint/oxlint-plugin.mjs"],
    rules: {
      "effect/unnecessaryPipe": "warn",
      "effect/unnecessaryPipeChain": "warn",
      "effect/unnecessaryEffectGen": "warn",
      "effect/effectMapVoid": "warn",
      "effect/effectSucceedWithVoid": "warn",
      "effect/schemaStructWithTag": "warn",
      "effect/schemaUnionOfLiterals": "warn",
      "effect/unnecessaryArrowBlock": "warn",
      "effect/globalFetch": "warn",
      "effect/processEnv": "warn",
      "effect/globalDate": "warn",
      "effect/globalConsole": "warn",
      "effect/globalRandom": "warn",
    },
    options: { typeAware: true, typeCheck: true },
  },
});
