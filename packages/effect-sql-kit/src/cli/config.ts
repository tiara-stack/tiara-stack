import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path, Schema } from "effect";
import { resolveConfigEffect } from "../config";
import type { EffectSqlKitConfig, EffectSqlSchema, ResolvedConfig } from "../types";
import { getDefaultConfigFilePathEffect, importFileEffect } from "./configFile";
import { isEffectSqlSchema, resolveConfigExport, resolveSchemaExport } from "./moduleExport";
import { EffectSqlKitConfigSchema, EffectSqlSchemaExportSchema } from "./schema";
import * as Data from "effect/Data";

class EffectSqlKitCliConfigError extends Data.TaggedError("EffectSqlKitCliConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const loadConfigEffect = (
  configPath?: string,
  overrides?: Partial<EffectSqlKitConfig>,
): Effect.Effect<
  { readonly config: ResolvedConfig; readonly configPath?: string },
  unknown,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const resolvedPath = configPath ?? (yield* getDefaultConfigFilePathEffect);
    if (!resolvedPath) {
      if (!overrides?.dialect) {
        return yield* new EffectSqlKitCliConfigError({
          message: "effect-sql-kit: no effect-sql.config.ts found; pass --config or --dialect",
        });
      }
      return {
        config: yield* resolveConfigEffect(overrides as EffectSqlKitConfig),
      };
    }

    const imported = yield* importFileEffect(resolvedPath);
    const rawConfig = resolveConfigExport(imported);
    const config = (yield* Schema.decodeUnknownEffect(EffectSqlKitConfigSchema)(
      rawConfig,
    )) as EffectSqlKitConfig;
    return {
      config: yield* resolveConfigEffect(config, overrides),
      configPath: resolvedPath,
    };
  });

export const loadConfig = (
  configPath?: string,
  overrides?: Partial<EffectSqlKitConfig>,
): Promise<{ readonly config: ResolvedConfig; readonly configPath?: string }> =>
  Effect.runPromise(
    loadConfigEffect(configPath, overrides).pipe(Effect.provide(NodeServices.layer)),
  );

export const loadSchemaEffect = (
  schemaPath: string | undefined,
  config: ResolvedConfig,
): Effect.Effect<EffectSqlSchema, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const filePath = schemaPath ?? config.schema;
    if (!filePath) {
      return yield* new EffectSqlKitCliConfigError({
        message: "effect-sql-kit: schema path is required in config or --schema",
      });
    }
    const imported = yield* importFileEffect(filePath);
    const sqlSchema = resolveSchemaExport(imported);
    const decoded = yield* Schema.decodeUnknownEffect(EffectSqlSchemaExportSchema)(sqlSchema);
    if (!isEffectSqlSchema(decoded)) {
      return yield* new EffectSqlKitCliConfigError({
        message: "effect-sql-kit: invalid schema export",
      });
    }
    return {
      ...decoded,
      prefix: config.prefix ?? decoded.prefix,
    };
  });
