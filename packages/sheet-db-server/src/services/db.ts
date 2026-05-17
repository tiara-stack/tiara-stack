import { zeroDrizzle, type DrizzleDatabase } from "@rocicorp/zero/server/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import { Cause, Effect, Layer, pipe, Context } from "effect";
import postgres from "postgres";
import { schema as zeroSchema } from "sheet-db-schema/zero";
import { config } from "@/config";

export class DBService extends Context.Service<DBService>()("DBService", {
  make: Effect.gen(function* () {
    yield* Effect.log("creating db client");
    const postgresUrl = yield* config.postgresUrl;
    const client = yield* Effect.try({
      try: () => postgres(postgresUrl),
      catch: (error) => new Cause.UnknownError(error),
    });
    const db = yield* Effect.try({
      try: () => drizzle(client),
      catch: (error) => new Cause.UnknownError(error),
    });
    const zql = yield* Effect.try({
      try: () => zeroDrizzle(zeroSchema, db as unknown as DrizzleDatabase),
      catch: (error) => new Cause.UnknownError(error),
    });
    yield* Effect.addFinalizer(() =>
      pipe(
        Effect.promise(() => client.end()),
        Effect.andThen(() => Effect.log("DB client closed")),
      ),
    );
    return { db, zql };
  }),
}) {
  static layer = Layer.effect(DBService, this.make);
}
