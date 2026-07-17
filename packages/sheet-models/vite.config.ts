import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

export default library({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/index.ts", import.meta.url)),
    },
    deps: {
      neverBundle: ["effect"],
    },
  },
});
