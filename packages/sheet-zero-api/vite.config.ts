import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

const entry = (name: string) => fileURLToPath(new URL(`src/${name}.ts`, import.meta.url));

export default library({
  resolve: {
    alias: {
      "effect-zero-workflow": fileURLToPath(
        new URL("../effect-zero-workflow/src/index.ts", import.meta.url),
      ),
    },
  },
  pack: {
    entry: {
      client: entry("client"),
      index: entry("index"),
      rows: entry("rows"),
      schema: entry("schema"),
      server: entry("server"),
    },
    deps: {
      neverBundle: ["@rocicorp/zero", "effect", "effect-zero-workflow"],
    },
  },
});
