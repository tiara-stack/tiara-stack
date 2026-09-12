import { fileURLToPath } from "node:url";
import { library } from "tooling-config/vite";

export default library({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/index.ts", import.meta.url)),
      cli: fileURLToPath(new URL("src/cli.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
