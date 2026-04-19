import { globSync } from "glob";
import path from "pathe";
import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

const filePaths = [
  ...globSync("./src/index.ts", { nodir: true }).map((file) =>
    fileURLToPath(new URL(file, import.meta.url)),
  ),
  ...globSync("./src/**/index.ts", { nodir: true }).map((file) =>
    fileURLToPath(new URL(file, import.meta.url)),
  ),
];

export default defineConfig({
  pack: {
    entry: Object.fromEntries(
      filePaths.map((filePath) => {
        const relativePath = path.relative("./src", filePath);
        const parsed = path.parse(relativePath);
        const module = path.join(parsed.dir.replace(/\.+\//g, ""), parsed.name);

        return [module, filePath];
      }),
    ),
    sourcemap: true,
    deps: {
      neverBundle: ["@effect/platform", "effect"],
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
