import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

const entry = (name: string) => fileURLToPath(new URL(`src/${name}.ts`, import.meta.url));

export default library({
  pack: {
    entry: {
      "apps-script": entry("apps-script"),
      index: entry("index"),
      routes: entry("routes"),
    },
    deps: {
      neverBundle: ["effect", "effect-zero-workflow", "sheet-workflow-contracts"],
    },
  },
});
