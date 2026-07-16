import { browserLibrary, packageEntries } from "tooling-config/vite";

export default browserLibrary({
  pack: {
    entry: packageEntries(import.meta.url, [
      "./src/index.ts",
      "./src/index.tsx",
      "./src/*/index.ts",
      "./src/*/index.tsx",
    ]),
    deps: {
      neverBundle: [
        "@tanstack/react-router",
        "@tanstack/react-start",
        "@tanstack/router-core",
        "effect",
        "react",
      ],
    },
  },
});
