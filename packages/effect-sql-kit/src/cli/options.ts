import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Flag } from "effect/unstable/cli";
import type { EffectSqlKitConfig } from "../types";
import * as Data from "effect/Data";

class EffectSqlKitCliOptionsError extends Data.TaggedError("EffectSqlKitCliOptionsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const optionalValue = <A>(option: Option.Option<A>): A | undefined =>
  Option.isSome(option) ? option.value : undefined;

export const tryPromise = <A>(try_: () => Promise<A>) =>
  Effect.tryPromise({
    try: try_,
    catch: (cause) => new EffectSqlKitCliOptionsError({ message: String(cause), cause: cause }),
  });

export const configFlags = {
  config: Flag.path("config").pipe(
    Flag.withAlias("c"),
    Flag.withDescription("Path to effect-sql config file"),
    Flag.optional,
  ),
  dialect: Flag.choice("dialect", ["postgresql", "sqlite"] as const).pipe(Flag.optional),
  schema: Flag.path("schema").pipe(Flag.optional),
  out: Flag.path("out").pipe(Flag.optional),
  prefix: Flag.string("prefix").pipe(Flag.optional),
  url: Flag.string("url").pipe(Flag.optional),
  table: Flag.string("table").pipe(Flag.optional),
  dbSchema: Flag.string("db-schema").pipe(Flag.optional),
};

type ConfigInput = {
  readonly dialect: Option.Option<"postgresql" | "sqlite">;
  readonly schema: Option.Option<string>;
  readonly out: Option.Option<string>;
  readonly prefix: Option.Option<string>;
  readonly url: Option.Option<string>;
  readonly table: Option.Option<string>;
  readonly dbSchema: Option.Option<string>;
};

export const configInputToOverrides = (input: ConfigInput): Partial<EffectSqlKitConfig> => {
  const table = optionalValue(input.table);
  const dbSchema = optionalValue(input.dbSchema);
  const migrations =
    table || dbSchema
      ? {
          table,
          schema: dbSchema,
        }
      : undefined;

  const url = optionalValue(input.url);

  const dialect = optionalValue(input.dialect);
  const schema = optionalValue(input.schema);
  const out = optionalValue(input.out);
  const prefix = optionalValue(input.prefix);
  return {
    ...(dialect === undefined ? {} : { dialect }),
    ...(schema === undefined ? {} : { schema }),
    ...(out === undefined ? {} : { out }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(url === undefined ? {} : { dbCredentials: { url } }),
    ...(migrations === undefined ? {} : { migrations }),
  };
};
