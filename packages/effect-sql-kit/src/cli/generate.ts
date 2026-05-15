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
    prefix: Flag.choice("prefix", ["index", "timestamp"] as const).pipe(Flag.withDefault("index")),
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
        prefix: options.prefix,
      });

      yield* Console.log(
        result.written
          ? `effect-sql-kit: generated ${loaded.config.out}/${result.tag}.ts`
          : "effect-sql-kit: no schema changes, nothing to generate",
      );
    }),
).pipe(Command.withDescription("Generate Effect SQL migration modules"));
