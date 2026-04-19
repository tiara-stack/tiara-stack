import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/schema.ts", import.meta.url)),
      zero: fileURLToPath(new URL("src/zero/index.ts", import.meta.url)),
    },
    sourcemap: true,
    deps: {
      onlyBundle: false,
    },
  },
  lint: {
    ignorePatterns: ["dist"],
    env: {
      browser: true,
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
