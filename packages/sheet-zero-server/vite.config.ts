import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

const entry = (name: string) => fileURLToPath(new URL(`src/${name}.ts`, import.meta.url));

export default library({
  pack: {
    entry: {
      authorization: entry("authorization"),
      http: entry("http"),
      index: entry("index"),
      persistence: entry("persistence"),
      workflows: entry("workflows"),
    },
    deps: {
      neverBundle: [
        "@rocicorp/zero",
        "effect",
        "effect-zero-workflow",
        "sheet-auth",
        "sheet-workflow-contracts",
        "sheet-zero-api",
        "typhoon-zero",
      ],
    },
  },
});
