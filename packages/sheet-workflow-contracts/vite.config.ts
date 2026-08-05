import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

const entry = (name: string) => fileURLToPath(new URL(`src/${name}.ts`, import.meta.url));

export default library({
  pack: {
    entry: {
      catalog: entry("catalog"),
      client: entry("client"),
      failures: entry("failures"),
      index: entry("index"),
      policy: entry("policy"),
      values: entry("values"),
    },
    deps: {
      neverBundle: ["effect"],
    },
  },
});
