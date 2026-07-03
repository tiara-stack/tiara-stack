import { Effect, FileSystem, Path } from "effect";
import { createJiti } from "jiti";
import * as Data from "effect/Data";

class EffectSqlKitCliConfigFileError extends Data.TaggedError("EffectSqlKitCliConfigFileError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const defaultConfigFilePath = "effect-sql.config.ts";

const jiti = createJiti(import.meta.url, {
  interopDefault: false,
});

export const getDefaultConfigFilePathEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const full = path.resolve(process.cwd(), defaultConfigFilePath);
  const exists = yield* fs.exists(full);
  return exists ? defaultConfigFilePath : undefined;
});

export const importFileEffect = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const full = path.resolve(process.cwd(), filePath);
    const exists = yield* fs.exists(full);
    if (!exists) {
      return yield* new EffectSqlKitCliConfigFileError({
        message: `effect-sql-kit: failed to find file at ${full}`,
      });
    }
    return yield* Effect.tryPromise({
      try: () => jiti.import<Record<string, unknown>>(full),
      catch: (cause) =>
        new EffectSqlKitCliConfigFileError({
          message: `effect-sql-kit: failed to import file at ${full}`,
          cause: cause,
        }),
    });
  });
