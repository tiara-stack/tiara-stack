import { appsScript, packageEntries } from "tooling-config/vite";

export default appsScript({
  pack: {
    entry: packageEntries(import.meta.url, ["./src/index.ts", "./src/**/index.ts"]),
    deps: {
      neverBundle: ["@effect/platform", "effect"],
    },
  },
});
