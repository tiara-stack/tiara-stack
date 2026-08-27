import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

const entry = (name: string) => fileURLToPath(new URL(`src/${name}.ts`, import.meta.url));

export default library({
  pack: {
    entry: {
      admission: entry("admission"),
      actions: entry("actions"),
      cache: entry("cache"),
      discord: entry("discord"),
      delivery: entry("delivery"),
      errors: entry("errors"),
      http: entry("http"),
      index: entry("index"),
      message: entry("message"),
      references: entry("references"),
    },
    deps: {
      neverBundle: ["effect"],
    },
  },
});
