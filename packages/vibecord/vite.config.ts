import { fileURLToPath } from "url";
import { app } from "tooling-config/vite";

export default app({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/bot/index.ts", import.meta.url)),
      register: fileURLToPath(new URL("src/register.ts", import.meta.url)),
    },
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^.*$/],
      neverBundle: ["zlib-sync"],
    },
  },
});
