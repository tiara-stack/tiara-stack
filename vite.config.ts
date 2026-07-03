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
    options: { typeAware: true, typeCheck: true },
  },
});
