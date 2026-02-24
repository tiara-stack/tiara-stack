import { defineConfig } from "tsdown";
import { fileURLToPath } from "url";

export default defineConfig([
  {
    entry: {
      index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      client: fileURLToPath(new URL("./src/client.ts", import.meta.url)),
      schema: fileURLToPath(new URL("./src/schema.ts", import.meta.url)),
      plugins: fileURLToPath(new URL("./src/plugins/index.ts", import.meta.url)),
    },
    sourcemap: true,
    dts: {
      tsgo: true,
    },
  },
  {
    entry: {
      server: fileURLToPath(new URL("./src/server.ts", import.meta.url)),
    },
    sourcemap: true,
    noExternal: [/^.*$/],
  },
]);
