import { fileURLToPath } from "node:url";
import { app } from "tooling-config/vite";

export default app({
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL("../sheet-workflows/src/", import.meta.url)),
      },
    ],
  },
});
