import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path, Result, Schema } from "effect";
import { tsImport } from "tsx/esm/api";
import { resolveConfigEffect } from "../config";
import type { EffectSqlKitConfig, EffectSqlSchema, ResolvedConfig } from "../types";
import { EffectSqlKitConfigSchema, EffectSqlSchemaExportSchema } from "./schema";

export const defaultConfigFilePath = "effect-sql.config.ts";

export const getDefaultConfigFilePathEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const full = path.resolve(process.cwd(), defaultConfigFilePath);
  const existsResult = yield* Effect.result(fs.exists(full));
  const exists = Result.isSuccess(existsResult) ? existsResult.success : false;
  return exists ? defaultConfigFilePath : undefined;
});

export const getDefaultConfigFilePath = (): Promise<string | undefined> =>
  Effect.runPromise(getDefaultConfigFilePathEffect.pipe(Effect.provide(NodeServices.layer)));

export const importFileEffect = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const full = path.resolve(process.cwd(), filePath);
    const existsResult = yield* Effect.result(fs.exists(full));
    const exists = Result.isSuccess(existsResult) ? existsResult.success : false;
    if (!exists) {
      return yield* Effect.fail(new Error(`effect-sql-kit: failed to find file at ${full}`));
    }
    const fileUrl = yield* path.toFileUrl(full);
    return yield* Effect.tryPromise({
      try: () => tsImport(fileUrl.href, import.meta.url) as Promise<Record<string, unknown>>,
      catch: (cause) => cause,
    });
  });

export const importFile = (filePath: string): Promise<Record<string, unknown>> =>
  Effect.runPromise(importFileEffect(filePath).pipe(Effect.provide(NodeServices.layer)));

const isEffectSqlSchema = (value: unknown): value is EffectSqlSchema =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "EffectSqlSchema" &&
  "tables" in value &&
  typeof value.tables === "object" &&
  value.tables !== null;

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
        return yield* Effect.fail(
          new Error("effect-sql-kit: no effect-sql.config.ts found; pass --config or --dialect"),
        );
      }
      return {
        config: yield* resolveConfigEffect(overrides as EffectSqlKitConfig),
      };
    }

    const imported = yield* importFileEffect(resolvedPath);
    const rawConfig =
      imported.default && typeof imported.default === "object" && "default" in imported.default
        ? (imported.default as { readonly default?: unknown }).default
        : imported.default;
    const config = yield* Schema.decodeUnknownEffect(EffectSqlKitConfigSchema)(rawConfig);
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
      return yield* Effect.fail(
        new Error("effect-sql-kit: schema path is required in config or --schema"),
      );
    }
    const imported = yield* importFileEffect(filePath);
    const sqlSchema = imported.default ?? imported.schema;
    const decoded = yield* Schema.decodeUnknownEffect(EffectSqlSchemaExportSchema)(sqlSchema);
    if (!isEffectSqlSchema(decoded)) {
      return yield* Effect.fail(new Error("effect-sql-kit: invalid schema export"));
    }
    return decoded;
  });

export const loadSchema = (
  schemaPath: string | undefined,
  config: ResolvedConfig,
): Promise<EffectSqlSchema> =>
  Effect.runPromise(loadSchemaEffect(schemaPath, config).pipe(Effect.provide(NodeServices.layer)));
