import { Effect, Schema } from "effect";
import "dotenv/config";
import { defineConfig } from "effect-sql-kit";
import { zeroPublication } from "effect-zero";
import zeroSchema from "./effect-zero.config";

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
  dbCredentials: {
    url: env.POSTGRES_URL ?? "",
  },
  migrations: {
    schema: "public",
  },
  extensions: [
    zeroPublication({
      name: "zero_data",
      schema: zeroSchema,
    }),
  ],
});
