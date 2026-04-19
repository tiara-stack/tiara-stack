import { fileURLToPath } from "url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        client: fileURLToPath(new URL("./src/client.ts", import.meta.url)),
        model: fileURLToPath(new URL("./src/model/index.ts", import.meta.url)),
        schema: fileURLToPath(new URL("./src/schema.ts", import.meta.url)),
        "plugins/kubernetes-oauth/index": fileURLToPath(
          new URL("./src/plugins/kubernetes-oauth/index.ts", import.meta.url),
        ),
        "plugins/kubernetes-oauth/client": fileURLToPath(
          new URL("./src/plugins/kubernetes-oauth/client.ts", import.meta.url),
        ),
      },
      sourcemap: true,
      deps: {
        neverBundle: ["@better-fetch/fetch", "@standard-schema/spec", "nanostores"],
        onlyBundle: false,
      },
      dts: {
        tsgo: true,
      },
    },
    {
      entry: {
        server: fileURLToPath(new URL("./src/server.ts", import.meta.url)),
      },
      sourcemap: true,
      deps: {
        alwaysBundle: [/^.*$/],
        onlyBundle: false,
      },
    },
  ],
  lint: {
    ignorePatterns: ["dist"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
