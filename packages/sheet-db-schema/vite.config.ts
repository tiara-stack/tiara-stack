import { fileURLToPath } from "url";
import { library } from "tooling-config/vite";

export default library({
  pack: {
    entry: {
      index: fileURLToPath(new URL("src/schema.ts", import.meta.url)),
      migrations: fileURLToPath(new URL("src/migrations.ts", import.meta.url)),
      models: fileURLToPath(new URL("src/models.ts", import.meta.url)),
      testdb: fileURLToPath(new URL("src/testdb.ts", import.meta.url)),
      zero: fileURLToPath(new URL("src/zero/index.ts", import.meta.url)),
    },
    deps: {
      neverBundle: ["@electric-sql/pglite", "drizzle-orm"],
    },
  },
});
