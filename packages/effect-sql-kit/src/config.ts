import { Effect, Schema } from "effect";
import {
  EffectSqlKitConfigOverridesSchema,
  EffectSqlKitConfigSchema,
  ResolvedConfigSchema,
} from "./cli/schema";
import type { EffectSqlKitConfig, ResolvedConfig } from "./types";

export const defineConfig = <const Config extends EffectSqlKitConfig>(config: Config): Config =>
  config;

const parseConfigObjectEffect = (input: unknown) =>
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

const prefixedIdentifierName = (prefix: string, tableName: string): string =>
  prefix ? `${prefix.replace(/_+$/, "")}_${tableName}` : tableName;

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
    const prefix = merged.prefix ?? "";
    const resolved = {
      dialect: merged.dialect,
      schema: merged.schema,
      out: merged.out ?? "./migrations",
      prefix,
      dbCredentials: merged.dbCredentials,
      migrations: {
        table: merged.migrations?.table ?? prefixedIdentifierName(prefix, "effect_sql_migrations"),
        schema: merged.migrations?.schema ?? "public",
      },
      breakpoints: merged.breakpoints ?? true,
      extensions: merged.extensions ?? [],
    };
    const decoded = yield* Schema.decodeUnknownEffect(ResolvedConfigSchema)(resolved);
    return decoded as ResolvedConfig;
  });
