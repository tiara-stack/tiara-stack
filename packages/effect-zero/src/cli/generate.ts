import { NodeServices } from "@effect/platform-node";
import { Config, ConfigProvider, Console, Effect, FileSystem, Path, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Project } from "ts-morph";
import { getGeneratedSchema } from "../write";
import { getConfigFromFileEffect, getDefaultConfigFilePathEffect } from "./config";
import { checkSignature, signContent } from "./signature";
import { discoverAllTsConfigsEffect } from "./tsconfig";
import { addSourceFilesFromTsConfigSafe, ensureSourceFileInProject } from "./ts-project";

const defaultOutputFile = "./zero-schema.gen.ts";
const defaultTsConfigFile = "./tsconfig.json";

const EagerLoadingConfig = Config.boolean("EFFECT_ZERO_EAGER_LOADING").pipe(
  Config.withDefault(false),
);

const DebugFormatConfig = Config.boolean("EFFECT_ZERO_DEBUG_FORMAT").pipe(
  Config.withDefault(false),
);

const readBooleanConfig = (name: string, config: Config.Config<boolean>) =>
  config.parse(ConfigProvider.fromEnv({ env: process.env as Record<string, string> })).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (process.env[name] !== undefined) {
          yield* Console.warn(
            `effect-zero: Failed to parse ${name}; using false. ${String(error)}`,
          );
        }
        return false;
      }),
    ),
  );

export type GeneratorOptions = {
  readonly config?: string;
  readonly tsConfigPath?: string;
  readonly format?: boolean;
  readonly outputFilePath?: string;
  readonly debug?: boolean;
  readonly force?: boolean;
  readonly jsFileExtension?: boolean;
  readonly skipTypes?: boolean;
  readonly skipBuilder?: boolean;
  readonly skipDeclare?: boolean;
  readonly enableLegacyMutators?: boolean;
  readonly enableLegacyQueries?: boolean;
};

const runFormatter = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<void, Error, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        cwd,
      }),
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`${command} exited with code ${exitCode}`));
    }
  });

const validateOutputPathEffect = (outputPath: string): Effect.Effect<string, Error, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = process.cwd();
    const resolved = path.resolve(root, outputPath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* Effect.fail(new Error(`effect-zero: output path must be inside ${root}`));
    }
    return resolved;
  });

export const formatGeneratedFileEffect = (
  outputPath: string,
): Effect.Effect<void, unknown, ChildProcessSpawner.ChildProcessSpawner | Path.Path> =>
  Effect.gen(function* () {
    const resolvedOutputPath = yield* validateOutputPathEffect(outputPath);
    const debugFormat = yield* readBooleanConfig("EFFECT_ZERO_DEBUG_FORMAT", DebugFormatConfig);
    const cwd = process.cwd();

    const first = yield* Effect.result(
      runFormatter("pnpm", ["exec", "vp", "fmt", resolvedOutputPath], cwd),
    );
    if (Result.isSuccess(first)) {
      return;
    }

    const second = yield* Effect.result(runFormatter("vp", ["fmt", resolvedOutputPath], cwd));
    if (Result.isSuccess(second)) {
      return;
    }

    yield* Console.warn(
      `effect-zero: oxfmt/vp formatter unavailable, leaving ${resolvedOutputPath} unformatted.`,
    );
    if (debugFormat) {
      yield* Console.warn(
        first.failure instanceof Error ? first.failure.message : JSON.stringify(first.failure),
      );
      yield* Console.warn(
        second.failure instanceof Error ? second.failure.message : JSON.stringify(second.failure),
      );
    }
  });

export const formatGeneratedFile = (outputPath: string) =>
  Effect.runPromise(formatGeneratedFileEffect(outputPath).pipe(Effect.provide(NodeServices.layer)));

export const generateEffect = (
  opts: GeneratorOptions = {},
): Effect.Effect<
  { readonly content: string; readonly outputFilePath: string },
  unknown,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolvedTsConfigPath = opts.tsConfigPath ?? defaultTsConfigFile;
    const resolvedOutputFilePath = opts.outputFilePath ?? defaultOutputFile;
    const defaultConfigFilePath = yield* getDefaultConfigFilePathEffect;
    const configFilePath = opts.config ?? defaultConfigFilePath;

    if (!configFilePath) {
      return yield* Effect.fail(
        new Error(
          "effect-zero: No config file found. Create effect-zero.config.ts or pass --config.",
        ),
      );
    }

    const tsProject = new Project({
      tsConfigFilePath: resolvedTsConfigPath,
      skipAddingFilesFromTsConfig: true,
    });

    const eagerLoading = yield* readBooleanConfig("EFFECT_ZERO_EAGER_LOADING", EagerLoadingConfig);
    if (eagerLoading) {
      const tsConfigPaths = yield* discoverAllTsConfigsEffect(resolvedTsConfigPath);
      yield* Effect.forEach(
        tsConfigPaths,
        (tsConfigPath) =>
          Effect.sync(() =>
            addSourceFilesFromTsConfigSafe({
              tsProject,
              tsConfigPath,
              debug: Boolean(opts.debug),
            }),
          ),
        { concurrency: 4 },
      );
    }

    ensureSourceFileInProject({
      tsProject,
      filePath: path.resolve(process.cwd(), configFilePath),
      debug: Boolean(opts.debug),
    });

    const result = yield* getConfigFromFileEffect({ configFilePath, tsProject });

    if (Object.keys(result.zeroSchema.tables ?? {}).length === 0) {
      return yield* Effect.fail(new Error("effect-zero: No tables found in the schema."));
    }

    const generated = getGeneratedSchema({
      tsProject,
      zeroSchema: result.zeroSchema,
      outputFilePath: resolvedOutputFilePath,
      configImport: {
        exportName: result.exportName,
        configFilePath: result.configFilePath,
      },
      jsExtensionOverride: opts.jsFileExtension ? "force" : "auto",
      skipTypes: Boolean(opts.skipTypes),
      skipBuilder: Boolean(opts.skipBuilder),
      skipDeclare: Boolean(opts.skipDeclare),
      enableLegacyMutators: Boolean(opts.enableLegacyMutators),
      enableLegacyQueries: Boolean(opts.enableLegacyQueries),
      debug: Boolean(opts.debug),
    });

    return {
      content: signContent(generated),
      outputFilePath: resolvedOutputFilePath,
    };
  });

export const generate = (opts: GeneratorOptions = {}) =>
  Effect.runPromise(generateEffect(opts).pipe(Effect.provide(NodeServices.layer)));

export const writeGeneratedFileEffect = ({
  content,
  outputFilePath,
  force,
  format,
}: {
  readonly content: string;
  readonly outputFilePath: string;
  readonly force?: boolean;
  readonly format?: boolean;
}): Effect.Effect<
  string,
  unknown,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outputPath = yield* validateOutputPathEffect(outputFilePath);

    if (!force) {
      const exists = yield* fs.exists(outputPath);
      const existing = exists ? yield* fs.readFileString(outputPath) : undefined;
      if (existing && checkSignature(existing) === "modified") {
        return yield* Effect.fail(
          new Error(
            `effect-zero: ${outputPath} has been manually modified. Use --force to overwrite.`,
          ),
        );
      }
    }

    yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
    yield* fs.writeFileString(outputPath, content);

    if (format) {
      yield* formatGeneratedFileEffect(outputPath);
    }

    return outputPath;
  });

export const writeGeneratedFile = (options: {
  readonly content: string;
  readonly outputFilePath: string;
  readonly force?: boolean;
  readonly format?: boolean;
}) => Effect.runPromise(writeGeneratedFileEffect(options).pipe(Effect.provide(NodeServices.layer)));
