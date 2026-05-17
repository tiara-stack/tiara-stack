import { Effect, Schema } from "effect";
import "dotenv/config";
import { defineConfig } from "effect-sql-kit";

const env = Schema.decodeUnknownSync(
  Schema.Struct({
    POSTGRES_URL: Schema.optional(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
    ),
  }),
)(process.env);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./effect-sql-migrations",
  tablePrefix: "sheet_db",
  dbCredentials: {
    url: env.POSTGRES_URL ?? "",
  },
  migrations: {
    schema: "public",
  },
});
