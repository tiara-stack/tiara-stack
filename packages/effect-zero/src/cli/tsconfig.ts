import { NodeServices } from "@effect/platform-node";
import { parse as parseJsonc, type ParseError as JsoncParseError } from "jsonc-parser";
import { Console, Effect, FileSystem, Path, Result, Schema } from "effect";

const TsConfigReferenceSchema = Schema.Struct({
  path: Schema.String,
});

const TsConfigSchema = Schema.Struct({
  references: Schema.optionalKey(Schema.Array(TsConfigReferenceSchema)),
});

const tsConfigConcurrency = Number.parseInt(process.env.EFFECT_ZERO_TSCONFIG_CONCURRENCY ?? "", 10);
const discoverConcurrency =
  Number.isFinite(tsConfigConcurrency) && tsConfigConcurrency > 0 ? tsConfigConcurrency : 10;

export const resolveReferencePathEffect = (
  refPath: string,
  tsConfigDir: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedPath = path.resolve(tsConfigDir, refPath);

    const stats = yield* Effect.result(fs.stat(resolvedPath));
    if (Result.isFailure(stats)) {
      yield* Console.warn(`effect-zero: Could not resolve reference path: ${refPath}`);
      return undefined;
    }

    return stats.success.type === "Directory"
      ? path.join(resolvedPath, "tsconfig.json")
      : resolvedPath;
  });

export const resolveReferencePath = (
  refPath: string,
  tsConfigDir: string,
): Promise<string | undefined> =>
  Effect.runPromise(
    resolveReferencePathEffect(refPath, tsConfigDir).pipe(Effect.provide(NodeServices.layer)),
  );

export const discoverAllTsConfigsEffect = (
  initialTsConfigPath: string,
): Effect.Effect<Set<string>, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processedPaths = new Set<string>();
    const toProcess = [path.resolve(initialTsConfigPath)];

    const processTsConfig = (tsConfigPath: string) =>
      Effect.gen(function* () {
        if (processedPaths.has(tsConfigPath)) {
          return [];
        }

        processedPaths.add(tsConfigPath);

        const content = yield* Effect.result(fs.readFileString(tsConfigPath));
        if (Result.isFailure(content)) {
          yield* Console.warn(`effect-zero: Could not find tsconfig file: ${tsConfigPath}`);
          return [];
        }

        const errors: JsoncParseError[] = [];
        const parsed = parseJsonc(content.success, errors);

        if (errors.length > 0) {
          yield* Console.warn(
            `effect-zero: Found syntax errors in ${path.relative(
              process.cwd(),
              tsConfigPath,
            )}. Continuing.`,
          );
        }

        const tsConfig = yield* Schema.decodeUnknownEffect(TsConfigSchema)(parsed).pipe(
          Effect.mapError(
            (error) =>
              new Error(
                `effect-zero: Error processing tsconfig file ${tsConfigPath}: ${String(error)}`,
              ),
          ),
        );

        if (!tsConfig.references) {
          return [];
        }

        const tsConfigDir = path.dirname(tsConfigPath);
        const newPaths: Array<string> = [];
        for (const ref of tsConfig.references) {
          const referencedPath = yield* resolveReferencePathEffect(ref.path, tsConfigDir);
          if (referencedPath && !processedPaths.has(referencedPath)) {
            newPaths.push(referencedPath);
          }
        }
        return newPaths;
      });

    while (toProcess.length > 0) {
      const current = toProcess.splice(0);
      const next = yield* Effect.forEach(current, processTsConfig, {
        concurrency: discoverConcurrency,
      });
      toProcess.push(...next.flat());
    }

    return processedPaths;
  });

export const discoverAllTsConfigs = (initialTsConfigPath: string): Promise<Set<string>> =>
  Effect.runPromise(
    discoverAllTsConfigsEffect(initialTsConfigPath).pipe(Effect.provide(NodeServices.layer)),
  );
