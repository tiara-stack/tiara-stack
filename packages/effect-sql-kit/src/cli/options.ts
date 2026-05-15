import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Flag } from "effect/unstable/cli";
import type { EffectSqlKitConfig } from "../types";

export const optionalValue = <A>(option: Option.Option<A>): A | undefined =>
  Option.isSome(option) ? option.value : undefined;

export const tryPromise = <A>(try_: () => Promise<A>) =>
  Effect.tryPromise({
    try: try_,
    catch: (cause) => cause,
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
  url: Flag.string("url").pipe(Flag.optional),
  table: Flag.string("table").pipe(Flag.optional),
  dbSchema: Flag.string("db-schema").pipe(Flag.optional),
};

type ConfigInput = {
  readonly dialect: Option.Option<"postgresql" | "sqlite">;
  readonly schema: Option.Option<string>;
  readonly out: Option.Option<string>;
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

  return {
    dialect: optionalValue(input.dialect),
    schema: optionalValue(input.schema),
    out: optionalValue(input.out),
    dbCredentials: url ? { url } : undefined,
    migrations,
  };
};
