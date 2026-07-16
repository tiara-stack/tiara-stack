import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

export default library({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/index.mts", import.meta.url)),
      snapshot: fileURLToPath(new URL("src/snapshot.mts", import.meta.url)),
    },
    dts: false,
  },
});
