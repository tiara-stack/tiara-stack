import { Effect, Schema } from "effect";
import {
  EffectSqlKitConfigOverridesSchema,
  EffectSqlKitConfigSchema,
  ResolvedConfigSchema,
} from "./cli/schema";
import type { EffectSqlKitConfig, ResolvedConfig } from "./types";

export const defineConfig = <const Config extends EffectSqlKitConfig>(config: Config): Config =>
  config;

export const parseConfigObjectEffect = (input: unknown) =>
  Schema.decodeUnknownEffect(EffectSqlKitConfigSchema)(input);

const withoutUndefined = <A extends Record<string, unknown>>(object: A): Partial<A> =>
  Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  ) as Partial<A>;

const normalizeOverrides = (
  overrides?: Partial<EffectSqlKitConfig>,
): Partial<EffectSqlKitConfig> => {
  if (!overrides) {
    return {};
  }
  const { migrations, ...rest } = overrides;
  return {
    ...withoutUndefined(rest),
    ...(migrations ? { migrations: withoutUndefined(migrations) } : {}),
  };
};

export const resolveConfigEffect = (
  config: EffectSqlKitConfig,
  overrides?: Partial<EffectSqlKitConfig>,
) =>
  Effect.gen(function* () {
    const decodedConfig = yield* parseConfigObjectEffect(config);
    const decodedOverrides = yield* Schema.decodeUnknownEffect(EffectSqlKitConfigOverridesSchema)(
      normalizeOverrides(overrides),
    );
    const merged = {
      ...decodedConfig,
      ...decodedOverrides,
      migrations: {
        ...decodedConfig.migrations,
        ...decodedOverrides.migrations,
      },
    };
    const resolved = {
      dialect: merged.dialect,
      schema: merged.schema,
      out: merged.out ?? "./migrations",
      dbCredentials: merged.dbCredentials,
      migrations: {
        table: merged.migrations?.table ?? "effect_sql_migrations",
        schema: merged.migrations?.schema ?? "public",
      },
      breakpoints: merged.breakpoints ?? true,
    };
    return yield* Schema.decodeUnknownEffect(ResolvedConfigSchema)(resolved);
  });

export const resolveConfig = (
  config: EffectSqlKitConfig,
  overrides?: Partial<EffectSqlKitConfig>,
): ResolvedConfig => {
  const decodedConfig = Schema.decodeUnknownSync(EffectSqlKitConfigSchema)(config);
  const decodedOverrides = Schema.decodeUnknownSync(EffectSqlKitConfigOverridesSchema)(
    normalizeOverrides(overrides),
  );
  const merged = {
    ...decodedConfig,
    ...decodedOverrides,
    migrations: {
      ...decodedConfig.migrations,
      ...decodedOverrides.migrations,
    },
  };
  return Schema.decodeUnknownSync(ResolvedConfigSchema)({
    dialect: merged.dialect,
    schema: merged.schema,
    out: merged.out ?? "./migrations",
    dbCredentials: merged.dbCredentials,
    migrations: {
      table: merged.migrations?.table ?? "effect_sql_migrations",
      schema: merged.migrations?.schema ?? "public",
    },
    breakpoints: merged.breakpoints ?? true,
  });
};
