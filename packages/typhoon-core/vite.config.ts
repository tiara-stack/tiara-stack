import { browserLibrary, packageEntries } from "tooling-config/vite";

export default browserLibrary({
  pack: {
    entry: packageEntries(import.meta.url, ["./src/index.ts", "./src/*/index.ts"]),
    deps: {
      neverBundle: ["effect"],
    },
  },
});
