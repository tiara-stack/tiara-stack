import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,vite.config.ts,tsconfig*.json,.github/**/*,packages/**/*}":
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
    ignorePatterns: [".output", ".ts-out", "dist", "node_modules", "native", "packages/*/test-d"],
    options: { typeAware: true, typeCheck: true },
  },
});
