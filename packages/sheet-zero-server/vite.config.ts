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
    },
    deps: {
      neverBundle: ["@rocicorp/zero", "effect", "sheet-auth", "sheet-zero-api", "typhoon-zero"],
    },
  },
});
