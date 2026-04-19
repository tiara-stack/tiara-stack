import { fileURLToPath } from "url";
import { defineConfig, Rolldown } from "vite-plus";

const bigIntRewrite = (): Rolldown.Plugin => ({
  name: "bigIntRewrite",
  transform(code, id) {
    if (id.endsWith(".js") || id.endsWith(".ts")) {
      return code.replace(/(^|\W)(\d+)n/g, "$1BigInt($2)");
    }
    return code;
  },
});

export default defineConfig({
  pack: {
    entry: { index: fileURLToPath(new URL("src/index.ts", import.meta.url)) },
    sourcemap: true,
    format: "umd",
    outputOptions: { name: "sheetFormulas" },
    target: "es6",
    minify: true,
    deps: {
      alwaysBundle: [/^.*$/],
      onlyBundle: false,
    },
    plugins: [bigIntRewrite()],
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
