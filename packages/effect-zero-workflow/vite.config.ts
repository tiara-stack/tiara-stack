import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

export default library({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/index.ts", import.meta.url)),
      contract: fileURLToPath(new URL("src/contract.ts", import.meta.url)),
      "contract/server": fileURLToPath(new URL("src/contract-server.ts", import.meta.url)),
    },
  },
});
