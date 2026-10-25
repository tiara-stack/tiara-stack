import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";
import { generateMigrationEffect } from "../migration/generate";
import { loadConfigEffect, loadSchemaEffect } from "./config";
import { configFlags, configInputToOverrides, optionalValue } from "./options";

export const generateCommand = Command.make(
  "generate",
  {
    ...configFlags,
    name: Flag.string("name").pipe(Flag.optional),
    custom: Flag.boolean("custom").pipe(Flag.withDefault(false)),
    breakpoints: Flag.boolean("breakpoints").pipe(Flag.optional),
    migrationPrefix: Flag.choice("migration-prefix", ["index", "timestamp"] as const).pipe(
      Flag.withDefault("index"),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfigEffect(optionalValue(options.config), {
        ...configInputToOverrides(options),
        breakpoints:
          options.breakpoints._tag === "Some" && options.breakpoints.value === true
            ? true
            : undefined,
      });

      const sqlSchema = yield* loadSchemaEffect(optionalValue(options.schema), loaded.config);

      const result = yield* generateMigrationEffect({
        config: loaded.config,
        schema: sqlSchema,
        name: optionalValue(options.name),
        custom: options.custom,
        prefix: options.migrationPrefix,
      });

      yield* Console.log(
        result.written
          ? `effect-sql-kit: generated ${/* oxlint-disable typescript/restrict-template-expressions -- inherited master site */ loaded.config.out /* oxlint-enable typescript/restrict-template-expressions -- inherited master site */}/${/* oxlint-disable typescript/restrict-template-expressions -- inherited master site */ result.tag /* oxlint-enable typescript/restrict-template-expressions -- inherited master site */}.ts`
          : "effect-sql-kit: no schema changes, nothing to generate",
      );
    }),
).pipe(Command.withDescription("Generate Effect SQL migration modules"));
