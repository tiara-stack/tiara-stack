import { PgClient } from "@effect/sql-pg";
import { Effect, Layer } from "effect";
import { config } from "@/config";

export const postgresSqlLayer = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* config.postgresUrl;
    return PgClient.layer({
      url,
      applicationName: "sheet-workflows",
      maxConnections: 10,
      transformJson: true,
    });
  }),
);
