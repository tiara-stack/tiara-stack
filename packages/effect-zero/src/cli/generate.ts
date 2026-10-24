import { NodeServices } from "@effect/platform-node";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  Result,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PlatformError } from "effect/PlatformError";
import { Project } from "ts-morph";
import { getGeneratedSchema } from "../write";
import { getConfigFromFileEffect, getDefaultConfigFilePathEffect } from "./config";
import { checkSignature, signContent, stripSignature } from "./signature";
import { discoverAllTsConfigsEffect } from "./tsconfig";
import { addSourceFilesFromTsConfigSafe, ensureSourceFileInProject } from "./ts-project";
import * as Data from "effect/Data";

class EffectZeroCliGenerateError extends Data.TaggedError("EffectZeroCliGenerateError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const defaultOutputFile = "./zero-schema.gen.ts";
const defaultTsConfigFile = "./tsconfig.json";

const EagerLoadingConfig = Config.boolean("EFFECT_ZERO_EAGER_LOADING").pipe(
  Config.withDefault(false),
);

const DebugFormatConfig = Config.boolean("EFFECT_ZERO_DEBUG_FORMAT").pipe(
  Config.withDefault(false),
);

const readBooleanConfig = (name: string, config: Config.Config<boolean>) =>
  config
    .parse(
      ConfigProvider.fromEnv({
        env: process.env /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Record<
          string,
          string
        > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
      }),
    )
    .pipe(
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
  readonly config?: string | undefined;
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
      return yield* new EffectZeroCliGenerateError({
        message: `${command} exited with code ${exitCode}`,
      });
    }
  });

const restoreFormatterInput = (
  fs: FileSystem.FileSystem,
  path: string,
  original: string | undefined,
) => (original === undefined ? Effect.void : fs.writeFileString(path, original));

type FormatterAttempt =
  | { readonly succeeded: true }
  | { readonly succeeded: false; readonly failure: unknown };

const runFormatterAttempt = (
  fs: FileSystem.FileSystem,
  path: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  original: string | undefined,
): Effect.Effect<FormatterAttempt, unknown, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(runFormatter(command, args, cwd));
    if (Result.isSuccess(result)) return { succeeded: true };
    yield* restoreFormatterInput(fs, path, original);
    return { succeeded: false, failure: result.failure };
  });

const formatterRecoveryContent = (
  provided: string | undefined,
  original: Result.Result<string, unknown>,
) => {
  if (provided !== undefined) return provided;
  if (Result.isSuccess(original)) return original.success;
  return undefined;
};

const formatterFailureDetail = (failure: unknown) =>
  failure instanceof Error ? failure.message : JSON.stringify(failure);

const warnFormatterUnavailable = (
  path: string,
  debugFormat: boolean,
  firstFailure: unknown,
  secondFailure: unknown,
) =>
  Effect.gen(function* () {
    yield* Console.warn(
      `effect-zero: oxfmt/vp formatter unavailable, leaving ${path} unformatted.`,
    );
    if (!debugFormat) return;
    yield* Console.warn(formatterFailureDetail(firstFailure));
    yield* Console.warn(formatterFailureDetail(secondFailure));
  });

const validateOutputPathEffect = (outputPath: string): Effect.Effect<string, Error, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = process.cwd();
    const resolved = path.resolve(root, outputPath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new EffectZeroCliGenerateError({
        message: `effect-zero: output path must be inside ${root}`,
      });
    }
    return resolved;
  });

const formatGeneratedFileEffectWithStatus = (
  formatPath: string,
  displayPath: string,
  originalContent?: string,
): Effect.Effect<
  FormatterAttempt,
  unknown,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Callers validate the requested destination before creating this staged path.
    const debugFormat = yield* readBooleanConfig("EFFECT_ZERO_DEBUG_FORMAT", DebugFormatConfig);
    const cwd = process.cwd();
    const original =
      originalContent === undefined
        ? yield* Effect.result(fs.readFileString(formatPath))
        : Result.succeed(originalContent);
    const recoveryContent = formatterRecoveryContent(originalContent, original);

    const first = yield* runFormatterAttempt(
      fs,
      formatPath,
      "pnpm",
      ["exec", "vp", "fmt", formatPath],
      cwd,
      recoveryContent,
    );
    if (first.succeeded) return first;
    const second = yield* runFormatterAttempt(
      fs,
      formatPath,
      "vp",
      ["fmt", formatPath],
      cwd,
      recoveryContent,
    );
    if (second.succeeded) return second;
    yield* warnFormatterUnavailable(displayPath, debugFormat, first.failure, second.failure);
    return second;
  });

const stagedFilePath = (path: Path.Path, outputPath: string) => {
  const extension = path.extname(outputPath);
  const basename = path.basename(outputPath, extension);
  return {
    directory: path.dirname(outputPath),
    prefix: `${basename}.stage-`,
    suffix: extension,
  };
};

export const formatGeneratedFileEffect = (
  outputPath: string,
): Effect.Effect<
  void,
  unknown,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedOutputPath = yield* validateOutputPathEffect(outputPath);
    const outputTargetPath = yield* resolveGeneratedOutputTargetPathEffect(
      fs,
      path,
      resolvedOutputPath,
    );
    const original = yield* Effect.result(fs.readFileString(outputTargetPath));
    if (Result.isFailure(original)) return yield* Effect.fail(original.failure);

    const outputInfo = yield* fs.stat(outputTargetPath);
    const outputMode = outputInfo.mode & 0o777;
    const outputSnapshot = generatedOutputSnapshot(original.success, outputInfo);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const tempPath = yield* fs.makeTempFileScoped(stagedFilePath(path, outputTargetPath));
        yield* fs.writeFileString(tempPath, original.success);
        const formatted = yield* formatGeneratedFileEffectWithStatus(
          tempPath,
          resolvedOutputPath,
          original.success,
        );
        if (!formatted.succeeded) return;
        yield* fs.chmod(tempPath, outputMode);
        yield* assertGeneratedOutputPathResolvesTo(
          fs,
          path,
          resolvedOutputPath,
          outputTargetPath,
          `effect-zero: ${resolvedOutputPath} changed while formatting; keeping the current file.`,
        );
        yield* replaceGeneratedOutputWithoutOverwrite(
          fs,
          path,
          tempPath,
          outputTargetPath,
          outputSnapshot,
          `effect-zero: ${resolvedOutputPath} changed while formatting; keeping the current file.`,
        );
      }),
    );
  });

type GeneratedOutputSnapshot = {
  readonly content: string | undefined;
  readonly mode: number | undefined;
  readonly device: number | undefined;
  readonly inode: number | undefined;
  readonly size: bigint | undefined;
  readonly modifiedAt: number | undefined;
};

type GeneratedOutputBackup = {
  readonly directory: string;
  readonly path: string;
};

const generatedOutputSnapshot = (
  content: string | undefined,
  info: FileSystem.File.Info | undefined,
): GeneratedOutputSnapshot => {
  if (info === undefined)
    return {
      content,
      mode: undefined,
      device: undefined,
      inode: undefined,
      size: undefined,
      modifiedAt: undefined,
    };
  return {
    content,
    mode: info.mode & 0o777,
    device: info.dev,
    inode: Option.getOrUndefined(info.ino),
    size: info.size,
    modifiedAt: Option.getOrUndefined(info.mtime)?.getTime(),
  };
};

const resolveGeneratedOutputTargetPathEffect = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  outputPath: string,
  visited: ReadonlySet<string> = new Set(),
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    const normalizedPath = path.resolve(outputPath);
    if (visited.has(normalizedPath)) {
      return yield* new EffectZeroCliGenerateError({
        message: `effect-zero: output path ${outputPath} contains a symbolic link cycle.`,
      });
    }
    const nextVisited = new Set(visited).add(normalizedPath);
    const resolvedPath = yield* Effect.result(fs.realPath(normalizedPath));
    if (Result.isSuccess(resolvedPath)) return resolvedPath.success;

    const linkTarget = yield* Effect.result(fs.readLink(normalizedPath));
    if (Result.isSuccess(linkTarget)) {
      return yield* resolveGeneratedOutputTargetPathEffect(
        fs,
        path,
        path.resolve(path.dirname(normalizedPath), linkTarget.success),
        nextVisited,
      );
    }

    const directory = yield* fs.realPath(path.dirname(normalizedPath));
    return path.join(directory, path.basename(normalizedPath));
  });

const assertGeneratedOutputPathResolvesTo = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  outputPath: string,
  expectedTargetPath: string,
  changedMessage: string,
) =>
  Effect.gen(function* () {
    const currentTargetPath = yield* Effect.result(
      resolveGeneratedOutputTargetPathEffect(fs, path, outputPath),
    );
    if (Result.isSuccess(currentTargetPath) && currentTargetPath.success === expectedTargetPath) {
      return;
    }
    return yield* new EffectZeroCliGenerateError({
      message: changedMessage,
      cause: Result.isFailure(currentTargetPath) ? currentTargetPath.failure : undefined,
    });
  });

const sameGeneratedOutputMetadata = (
  current: GeneratedOutputSnapshot,
  expected: GeneratedOutputSnapshot,
) =>
  [
    current.mode === expected.mode,
    current.device === expected.device,
    current.inode === expected.inode,
    current.size === expected.size,
    current.modifiedAt === expected.modifiedAt,
  ].every(Boolean);

const sameGeneratedOutputSnapshot = (
  current: GeneratedOutputSnapshot,
  expected: GeneratedOutputSnapshot,
) => current.content === expected.content && sameGeneratedOutputMetadata(current, expected);

const readGeneratedOutputSnapshot = (
  fs: FileSystem.FileSystem,
  outputPath: string,
): Effect.Effect<GeneratedOutputSnapshot, unknown> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(outputPath);
    if (!exists) return generatedOutputSnapshot(undefined, undefined);
    const content = yield* fs.readFileString(outputPath);
    const info = yield* fs.stat(outputPath);
    return generatedOutputSnapshot(content, info);
  });

const rejectModifiedGeneratedOutput = (
  outputPath: string,
  force: boolean | undefined,
  content: string | undefined,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    if (force) return;
    if (content === undefined) return;
    if (checkSignature(content) !== "modified") return;
    return yield* new EffectZeroCliGenerateError({
      message: `effect-zero: ${outputPath} has been manually modified. Use --force to overwrite.`,
    });
  });

const generatedContentPlan = (content: string, format: boolean | undefined) => {
  const hasValidSignature = checkSignature(content) === "valid";
  return {
    hasValidSignature,
    contentToFormat: format && hasValidSignature ? stripSignature(content) : content,
  };
};

const signStagedGeneratedContent = (
  fs: FileSystem.FileSystem,
  tempPath: string,
  originalContent: string,
  formatted: FormatterAttempt,
) =>
  Effect.gen(function* () {
    const body = formatted.succeeded ? yield* fs.readFileString(tempPath) : originalContent;
    yield* fs.writeFileString(tempPath, signContent(body));
  });

const restoreUnsignedStagedContent = (
  fs: FileSystem.FileSystem,
  tempPath: string,
  originalContent: string,
  formatted: FormatterAttempt,
) => (formatted.succeeded ? Effect.void : fs.writeFileString(tempPath, originalContent));

const writeStagedGeneratedContent = (
  fs: FileSystem.FileSystem,
  tempPath: string,
  content: string,
  format: boolean | undefined,
  hasValidSignature: boolean,
  displayPath: string,
) =>
  Effect.gen(function* () {
    yield* fs.writeFileString(tempPath, content);
    if (!format) return;
    const formatted = yield* formatGeneratedFileEffectWithStatus(tempPath, displayPath, content);
    if (hasValidSignature)
      return yield* signStagedGeneratedContent(fs, tempPath, content, formatted);
    yield* restoreUnsignedStagedContent(fs, tempPath, content, formatted);
  });

const assertGeneratedOutputUnchanged = (
  fs: FileSystem.FileSystem,
  outputPath: string,
  snapshot: GeneratedOutputSnapshot,
) =>
  Effect.gen(function* () {
    const current = yield* readGeneratedOutputSnapshot(fs, outputPath);
    if (sameGeneratedOutputSnapshot(current, snapshot)) return;
    return yield* new EffectZeroCliGenerateError({
      message: `effect-zero: ${outputPath} changed while generation was running; keeping the current file.`,
    });
  });

const applyGeneratedOutputMode = (
  fs: FileSystem.FileSystem,
  tempPath: string,
  snapshot: GeneratedOutputSnapshot,
) => (snapshot.mode === undefined ? Effect.void : fs.chmod(tempPath, snapshot.mode));

const cleanupGeneratedOutputBackup = (
  fs: FileSystem.FileSystem,
  backup: GeneratedOutputBackup,
  outputPath: string,
  outcome: "restored" | "updated",
) =>
  Effect.gen(function* () {
    const backupRemoved = yield* Effect.result(fs.remove(backup.path));
    if (Result.isFailure(backupRemoved)) {
      return yield* new EffectZeroCliGenerateError({
        message:
          outcome === "restored"
            ? `effect-zero: ${outputPath} was restored, but its recovery link remains at ${backup.path}.`
            : `effect-zero: ${outputPath} was updated, but its previous version remains at ${backup.path}.`,
        cause: backupRemoved.failure,
      });
    }
    const directoryRemoved = yield* Effect.result(fs.remove(backup.directory, { recursive: true }));
    if (Result.isFailure(directoryRemoved)) {
      return yield* new EffectZeroCliGenerateError({
        message: `effect-zero: ${outputPath} was ${outcome}, but its recovery directory remains at ${backup.directory}.`,
        cause: directoryRemoved.failure,
      });
    }
  });

const restoreGeneratedOutputBackup = (
  fs: FileSystem.FileSystem,
  backup: GeneratedOutputBackup,
  outputPath: string,
  failure: unknown,
) =>
  Effect.gen(function* () {
    const restored = yield* Effect.result(fs.link(backup.path, outputPath));
    if (Result.isFailure(restored)) {
      return yield* new EffectZeroCliGenerateError({
        message: `effect-zero: ${outputPath} could not be restored without replacing a concurrent file; recovery copy kept at ${backup.path}.`,
        cause: { failure, restoreFailure: restored.failure },
      });
    }
    yield* cleanupGeneratedOutputBackup(fs, backup, outputPath, "restored");
    return yield* Effect.fail(failure);
  });

const moveGeneratedOutputToBackup = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  outputPath: string,
): Effect.Effect<GeneratedOutputBackup, unknown> =>
  Effect.gen(function* () {
    const directory = yield* fs.makeTempDirectory({
      directory: path.dirname(outputPath),
      prefix: `${path.basename(outputPath)}.recovery-`,
    });
    const backup = { directory, path: path.join(directory, path.basename(outputPath)) };
    const moved = yield* Effect.result(fs.rename(outputPath, backup.path));
    if (Result.isFailure(moved)) {
      const directoryRemoved = yield* Effect.result(fs.remove(directory, { recursive: true }));
      if (Result.isFailure(directoryRemoved)) {
        return yield* new EffectZeroCliGenerateError({
          message: `effect-zero: ${outputPath} could not be backed up and its recovery directory remains at ${directory}.`,
          cause: { moveFailure: moved.failure, cleanupFailure: directoryRemoved.failure },
        });
      }
      return yield* Effect.fail(moved.failure);
    }
    return backup;
  });

const validateMovedGeneratedOutput = (
  fs: FileSystem.FileSystem,
  backup: GeneratedOutputBackup,
  outputPath: string,
  snapshot: GeneratedOutputSnapshot,
  changedMessage: string,
) =>
  Effect.gen(function* () {
    const movedSnapshot = yield* Effect.result(readGeneratedOutputSnapshot(fs, backup.path));
    if (Result.isFailure(movedSnapshot)) {
      return yield* restoreGeneratedOutputBackup(fs, backup, outputPath, movedSnapshot.failure);
    }
    if (!sameGeneratedOutputSnapshot(movedSnapshot.success, snapshot)) {
      return yield* restoreGeneratedOutputBackup(
        fs,
        backup,
        outputPath,
        new EffectZeroCliGenerateError({ message: changedMessage }),
      );
    }
  });

const linkGeneratedOutputWithBackup = (
  fs: FileSystem.FileSystem,
  tempPath: string,
  outputPath: string,
  backup: GeneratedOutputBackup,
) =>
  Effect.gen(function* () {
    const linked = yield* Effect.result(fs.link(tempPath, outputPath));
    if (Result.isFailure(linked)) {
      return yield* restoreGeneratedOutputBackup(fs, backup, outputPath, linked.failure);
    }

    yield* cleanupGeneratedOutputBackup(fs, backup, outputPath, "updated");
  });

const noOverwriteLinkFailureMessage = (
  failure: PlatformError,
  outputPath: string,
  changedMessage: string,
) =>
  Match.value(failure.reason._tag).pipe(
    Match.when("AlreadyExists", () => changedMessage),
    Match.orElse(
      () =>
        `effect-zero: ${outputPath} could not be installed with a hard link. ${failure.message}`,
    ),
  );

const probeHardLinkSupportBeforeReplacing = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempPath: string,
  outputPath: string,
) =>
  Effect.gen(function* () {
    const probeDirectory = yield* Effect.result(
      fs.makeTempDirectory({
        directory: path.dirname(outputPath),
        prefix: `${path.basename(outputPath)}.hardlink-probe-`,
      }),
    );
    if (Result.isFailure(probeDirectory)) {
      return yield* new EffectZeroCliGenerateError({
        message: `effect-zero: ${outputPath} could not verify hard-link support before replacing the existing file; the current file was kept.`,
        cause: probeDirectory.failure,
      });
    }

    const probePath = path.join(probeDirectory.success, path.basename(outputPath));
    const link = yield* Effect.result(fs.link(tempPath, probePath));
    if (Result.isFailure(link)) {
      if (link.failure.reason._tag === "AlreadyExists") {
        return yield* new EffectZeroCliGenerateError({
          message: `effect-zero: ${outputPath} could not use its hard-link probe because the probe destination was occupied at ${probePath}; the current file and occupied probe path were kept.`,
          cause: link.failure,
        });
      }
      const cleanup = yield* Effect.result(fs.remove(probeDirectory.success, { recursive: true }));
      return yield* new EffectZeroCliGenerateError({
        message: `effect-zero: ${outputPath} could not be installed with a hard link. ${link.failure.message}`,
        cause: Result.isFailure(cleanup)
          ? { linkFailure: link.failure, cleanupFailure: cleanup.failure }
          : link.failure,
      });
    }

    const probeRemoved = yield* Effect.result(fs.remove(probePath));
    if (Result.isFailure(probeRemoved)) {
      return yield* new EffectZeroCliGenerateError({
        message: `effect-zero: ${outputPath} could not remove its hard-link capability probe; the current file was kept.`,
        cause: probeRemoved.failure,
      });
    }
    const cleanup = yield* Effect.result(fs.remove(probeDirectory.success, { recursive: true }));
    if (Result.isFailure(cleanup)) {
      return yield* new EffectZeroCliGenerateError({
        message: `effect-zero: ${outputPath} could not clean up its hard-link capability probe; the current file was kept.`,
        cause: cleanup.failure,
      });
    }
  });

const replaceGeneratedOutputWithoutOverwrite = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempPath: string,
  outputPath: string,
  snapshot: GeneratedOutputSnapshot,
  changedMessage: string,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      if (snapshot.mode === undefined) {
        const linked = yield* Effect.result(fs.link(tempPath, outputPath));
        if (Result.isFailure(linked)) {
          return yield* new EffectZeroCliGenerateError({
            message: noOverwriteLinkFailureMessage(linked.failure, outputPath, changedMessage),
            cause: linked.failure,
          });
        }
        return;
      }
      yield* probeHardLinkSupportBeforeReplacing(fs, path, tempPath, outputPath);
      const backup = yield* moveGeneratedOutputToBackup(fs, path, outputPath);
      yield* validateMovedGeneratedOutput(fs, backup, outputPath, snapshot, changedMessage);
      yield* linkGeneratedOutputWithBackup(fs, tempPath, outputPath, backup);
    }),
  );

const commitGeneratedOutput = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tempPath: string,
  outputPath: string,
  requestedOutputPath: string,
  force: boolean | undefined,
  snapshot: GeneratedOutputSnapshot,
) =>
  Effect.gen(function* () {
    yield* assertGeneratedOutputPathResolvesTo(
      fs,
      path,
      requestedOutputPath,
      outputPath,
      `effect-zero: ${requestedOutputPath} changed while generation was running; keeping the current file.`,
    );
    yield* applyGeneratedOutputMode(fs, tempPath, snapshot);
    if (force) return yield* fs.rename(tempPath, outputPath);
    yield* assertGeneratedOutputUnchanged(fs, outputPath, snapshot);
    yield* replaceGeneratedOutputWithoutOverwrite(
      fs,
      path,
      tempPath,
      outputPath,
      snapshot,
      `effect-zero: ${outputPath} changed while generation was running; keeping the current file.`,
    );
  });

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
      return yield* new EffectZeroCliGenerateError({
        message:
          "effect-zero: No config file found. Create effect-zero.config.ts or pass --config.",
      });
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
      return yield* new EffectZeroCliGenerateError({
        message: "effect-zero: No tables found in the schema.",
      });
    }

    const generated = getGeneratedSchema({
      tsProject,
      zeroSchema: result.zeroSchema,
      outputFilePath: resolvedOutputFilePath,
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
    const requestedOutputPath = yield* validateOutputPathEffect(outputFilePath);
    yield* fs.makeDirectory(path.dirname(requestedOutputPath), { recursive: true });
    const outputPath = yield* resolveGeneratedOutputTargetPathEffect(fs, path, requestedOutputPath);
    const snapshot = yield* readGeneratedOutputSnapshot(fs, outputPath);
    yield* rejectModifiedGeneratedOutput(requestedOutputPath, force, snapshot.content);
    const plan = generatedContentPlan(content, format);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const tempPath = yield* fs.makeTempFileScoped(stagedFilePath(path, outputPath));
        yield* writeStagedGeneratedContent(
          fs,
          tempPath,
          plan.contentToFormat,
          format,
          plan.hasValidSignature,
          requestedOutputPath,
        );
        yield* commitGeneratedOutput(
          fs,
          path,
          tempPath,
          outputPath,
          requestedOutputPath,
          force,
          snapshot,
        );
        return requestedOutputPath;
      }),
    );
  });

export const writeGeneratedFile = (options: {
  readonly content: string;
  readonly outputFilePath: string;
  readonly force?: boolean;
  readonly format?: boolean;
}) => Effect.runPromise(writeGeneratedFileEffect(options).pipe(Effect.provide(NodeServices.layer)));
