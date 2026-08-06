import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

export default library({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/index.ts", import.meta.url)),
      contract: fileURLToPath(new URL("src/contract.ts", import.meta.url)),
      "contract/server": fileURLToPath(new URL("src/contract-server.ts", import.meta.url)),
      "contract/http": fileURLToPath(new URL("src/contract-http.ts", import.meta.url)),
      "contract/http/server": fileURLToPath(
        new URL("src/contract-http-server.ts", import.meta.url),
      ),
      "contract/transport": fileURLToPath(new URL("src/contract-transport.ts", import.meta.url)),
      "contract/zero": fileURLToPath(new URL("src/contract-zero.ts", import.meta.url)),
    },
  },
});
