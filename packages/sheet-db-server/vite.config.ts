import { app, packageEntries } from "tooling-config/vite";

export default app({
  pack: {
    entry: packageEntries(import.meta.url, ["./src/index.ts", "./src/**/index.ts"]),
    deps: {
      alwaysBundle: [/^.*$/],
    },
  },
});
