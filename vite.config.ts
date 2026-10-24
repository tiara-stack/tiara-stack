import { defineConfig } from "vite-plus";
import { lintPolicy } from "./packages/tooling-config/src/lint-policy.ts";

export default defineConfig({
  staged: {
    "{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,vite.config.ts,tsconfig*.json,.github/**/*,packages/**/*,deploy/**/*}":
      "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      "packages/sheet-web/src/routeTree.gen.ts",
      "charts/tiara-stack/templates",
      "native",
      "dist",
      ".output",
      ".ts-out",
      "node_modules",
    ],
  },
  lint: {
    jsPlugins: ["./packages/tooling-config/src/oxlint-plugins/effect-policy.mjs"],
    ignorePatterns: [".output", ".ts-out", "dist", "node_modules", "native", "packages/*/test-d"],
    plugins: ["unicorn", "typescript", "oxc"],
    ...lintPolicy,
  },
});
