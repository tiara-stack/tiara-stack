import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      cli: fileURLToPath(new URL("./src/cli.ts", import.meta.url)),
    },
    sourcemap: true,
    deps: {
      neverBundle: ["@effect/language-service", "glob"],
      onlyBundle: false,
    },
    dts: {
      tsgo: true,
    },
  },
  lint: {
    ignorePatterns: ["dist"],
    env: {
      node: true,
      es2022: true,
    },
    plugins: ["unicorn", "typescript", "oxc"],
    rules: {
      "no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
