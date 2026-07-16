import { fileURLToPath } from "url";
import { app } from "tooling-config/vite";

export default app({
  pack: [
    {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        client: fileURLToPath(new URL("./src/client.ts", import.meta.url)),
        model: fileURLToPath(new URL("./src/model/index.ts", import.meta.url)),
        schema: fileURLToPath(new URL("./src/schema.ts", import.meta.url)),
        oauth: fileURLToPath(new URL("./src/oauth.ts", import.meta.url)),
        "oauth-resource-authorization": fileURLToPath(
          new URL("./src/oauth-resource-authorization.ts", import.meta.url),
        ),
        "plugins/sheet-oauth/client": fileURLToPath(
          new URL("./src/plugins/sheet-oauth/client.ts", import.meta.url),
        ),
      },
      deps: {
        neverBundle: ["@better-fetch/fetch", "@standard-schema/spec", "nanostores"],
      },
    },
    {
      entry: {
        server: fileURLToPath(new URL("./src/server.ts", import.meta.url)),
        "seed-trusted-oauth-clients": fileURLToPath(
          new URL("./scripts/seed-trusted-oauth-clients.ts", import.meta.url),
        ),
      },
      dts: false,
      deps: {
        alwaysBundle: [/^.*$/],
      },
    },
  ],
});
