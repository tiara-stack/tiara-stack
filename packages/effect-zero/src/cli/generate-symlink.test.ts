import { NodeServices } from "@effect/platform-node";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { formatGeneratedFileEffect, writeGeneratedFileEffect } from "./generate";
import { signContent } from "./signature";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const withTempDirectory = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(packageRoot, ".tmp-effect-zero-symlink-"))),
    use,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

const assertSymlinkOutputIsUpdated = (
  dir: string,
  options: {
    readonly outputName: string;
    readonly targetName: string;
    readonly linkTarget: "relative" | "absolute";
    readonly force: boolean;
  },
) =>
  Effect.gen(function* () {
    const outputFilePath = path.join(dir, options.outputName);
    const targetPath = path.join(dir, options.targetName);
    const linkTarget = options.linkTarget === "relative" ? path.basename(targetPath) : targetPath;
    const validPrevious = signContent("export const schema = { previous: true };\n");
    const previous = options.force ? `${validPrevious}\n// manual edit\n` : validPrevious;
    const generated = signContent("export const schema = { generated: true };\n");
    yield* Effect.promise(() => writeFile(targetPath, previous));
    yield* Effect.promise(() => symlink(linkTarget, outputFilePath));

    const writtenPath = yield* writeGeneratedFileEffect({
      content: generated,
      outputFilePath,
      force: options.force,
      format: false,
    });

    expect(writtenPath).toBe(outputFilePath);
    expect((yield* Effect.promise(() => lstat(outputFilePath))).isSymbolicLink()).toBe(true);
    expect(yield* Effect.promise(() => readlink(outputFilePath))).toBe(linkTarget);
    expect(yield* Effect.promise(() => readFile(targetPath, "utf-8"))).toBe(generated);
    expect(yield* Effect.promise(() => readFile(outputFilePath, "utf-8"))).toBe(generated);
    const remaining = yield* Effect.promise(() => readdir(dir));
    expect(remaining.filter((entry) => entry.includes(".recovery-"))).toEqual([]);
  });

const assertDanglingSymlinkOutputIsCreated = (
  dir: string,
  options: {
    readonly outputName: string;
    readonly targetName: string;
    readonly linkTarget: "relative" | "absolute";
  },
) =>
  Effect.gen(function* () {
    const outputFilePath = path.join(dir, options.outputName);
    const targetPath = path.join(dir, options.targetName);
    const linkTarget = options.linkTarget === "relative" ? path.basename(targetPath) : targetPath;
    const generated = signContent("export const schema = { generated: true };\n");
    yield* Effect.promise(() => symlink(linkTarget, outputFilePath));

    const writtenPath = yield* writeGeneratedFileEffect({
      content: generated,
      outputFilePath,
      format: false,
    });

    expect(writtenPath).toBe(outputFilePath);
    expect((yield* Effect.promise(() => lstat(outputFilePath))).isSymbolicLink()).toBe(true);
    expect(yield* Effect.promise(() => readlink(outputFilePath))).toBe(linkTarget);
    expect(yield* Effect.promise(() => readFile(targetPath, "utf-8"))).toBe(generated);
  });

describe("CLI generation through symlink outputs", () => {
  for (const symlinkCase of [
    {
      name: "updates a relative symlink output without replacing the link",
      outputName: "relative-link-schema.gen.ts",
      targetName: "relative-target-schema.gen.ts",
      linkTarget: "relative",
      force: false,
    },
    {
      name: "updates an absolute symlink output without replacing the link",
      outputName: "absolute-link-schema.gen.ts",
      targetName: "absolute-target-schema.gen.ts",
      linkTarget: "absolute",
      force: false,
    },
    {
      name: "force-updates a relative symlink target without replacing the link",
      outputName: "relative-force-link-schema.gen.ts",
      targetName: "relative-force-target-schema.gen.ts",
      linkTarget: "relative",
      force: true,
    },
    {
      name: "force-updates an absolute symlink target without replacing the link",
      outputName: "absolute-force-link-schema.gen.ts",
      targetName: "absolute-force-target-schema.gen.ts",
      linkTarget: "absolute",
      force: true,
    },
  ] as const) {
    it.live(
      symlinkCase.name,
      () =>
        withTempDirectory((dir) => assertSymlinkOutputIsUpdated(dir, symlinkCase)).pipe(
          Effect.provide(NodeServices.layer),
        ),
      15_000,
    );
  }

  for (const symlinkCase of [
    {
      name: "creates a missing target through a relative symlink output",
      outputName: "relative-dangling-schema.gen.ts",
      targetName: "relative-dangling-target.gen.ts",
      linkTarget: "relative",
    },
    {
      name: "creates a missing target through an absolute symlink output",
      outputName: "absolute-dangling-schema.gen.ts",
      targetName: "absolute-dangling-target.gen.ts",
      linkTarget: "absolute",
    },
  ] as const) {
    it.live(
      symlinkCase.name,
      () =>
        withTempDirectory((dir) => assertDanglingSymlinkOutputIsCreated(dir, symlinkCase)).pipe(
          Effect.provide(NodeServices.layer),
        ),
      15_000,
    );
  }

  it.live(
    "rejects a symlink cycle without creating an output or recovery file",
    () =>
      withTempDirectory((dir) =>
        Effect.gen(function* () {
          const outputFilePath = path.join(dir, "cycle-output-schema.gen.ts");
          const otherLinkPath = path.join(dir, "cycle-target-schema.gen.ts");
          yield* Effect.promise(() => symlink(path.basename(otherLinkPath), outputFilePath));
          yield* Effect.promise(() => symlink(path.basename(outputFilePath), otherLinkPath));

          const result = yield* Effect.exit(
            writeGeneratedFileEffect({
              content: signContent("export const schema = {};\n"),
              outputFilePath,
              format: false,
            }),
          );

          expect(Exit.isFailure(result)).toBe(true);
          expect((yield* Effect.promise(() => lstat(outputFilePath))).isSymbolicLink()).toBe(true);
          expect((yield* Effect.promise(() => lstat(otherLinkPath))).isSymbolicLink()).toBe(true);
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(
            remaining.some((entry) => entry.includes(".stage-") || entry.includes(".recovery-")),
          ).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "preserves a symlink target's concurrent edit and cleans up its recovery directory",
    () =>
      withTempDirectory((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "concurrent-symlink-schema.gen.ts");
          const targetPath = path.join(dir, "concurrent-symlink-target.gen.ts");
          const previous = signContent("export const schema = { previous: true };\n");
          const manual = `${previous}\n// concurrent manual edit\n`;
          yield* Effect.promise(() => writeFile(targetPath, previous));
          yield* Effect.promise(() => symlink(path.basename(targetPath), outputFilePath));
          let edited = false;
          const raceFileSystem = new Proxy(fs, {
            get(target, property) {
              if (property !== "rename") return Reflect.get(target, property, target);
              return (fromPath: string, toPath: string) => {
                const replace = target.rename(fromPath, toPath);
                if (fromPath !== targetPath || !toPath.includes(".recovery-") || edited)
                  return replace;
                edited = true;
                return target.writeFileString(targetPath, manual).pipe(Effect.andThen(replace));
              };
            },
          });

          const result = yield* Effect.exit(
            writeGeneratedFileEffect({
              content: signContent("export const schema = { generated: true };\n"),
              outputFilePath,
              format: false,
            }).pipe(Effect.provideService(FileSystem.FileSystem, raceFileSystem)),
          );

          expect(edited).toBe(true);
          expect(Exit.isFailure(result)).toBe(true);
          expect((yield* Effect.promise(() => lstat(outputFilePath))).isSymbolicLink()).toBe(true);
          expect(yield* Effect.promise(() => readFile(outputFilePath, "utf-8"))).toBe(manual);
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(remaining.filter((entry) => entry.includes(".recovery-"))).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "keeps a newly selected symlink target unchanged while generation is running",
    () =>
      withTempDirectory((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "changing-link-schema.gen.ts");
          const originalTargetPath = path.join(dir, "original-target-schema.gen.ts");
          const replacementTargetPath = path.join(dir, "replacement-target-schema.gen.ts");
          const original = signContent("export const schema = { original: true };\n");
          const replacement = signContent("export const schema = { replacement: true };\n");
          yield* Effect.promise(() => writeFile(originalTargetPath, original));
          yield* Effect.promise(() => writeFile(replacementTargetPath, replacement));
          yield* Effect.promise(() => symlink(path.basename(originalTargetPath), outputFilePath));
          let outputPathResolutions = 0;
          const changingFileSystem = new Proxy(fs, {
            get(target, property) {
              if (property !== "realPath") return Reflect.get(target, property, target);
              return (resolvedPath: string) => {
                if (resolvedPath !== outputFilePath) return target.realPath(resolvedPath);
                outputPathResolutions += 1;
                if (outputPathResolutions !== 2) return target.realPath(resolvedPath);
                return target
                  .remove(outputFilePath)
                  .pipe(
                    Effect.andThen(
                      target.symlink(path.basename(replacementTargetPath), outputFilePath),
                    ),
                    Effect.andThen(target.realPath(resolvedPath)),
                  );
              };
            },
          });

          const result = yield* Effect.exit(
            writeGeneratedFileEffect({
              content: signContent("export const schema = { generated: true };\n"),
              outputFilePath,
              format: false,
            }).pipe(Effect.provideService(FileSystem.FileSystem, changingFileSystem)),
          );

          expect(outputPathResolutions).toBe(2);
          expect(Exit.isFailure(result)).toBe(true);
          expect((yield* Effect.promise(() => lstat(outputFilePath))).isSymbolicLink()).toBe(true);
          expect(yield* Effect.promise(() => readlink(outputFilePath))).toBe(
            path.basename(replacementTargetPath),
          );
          expect(yield* Effect.promise(() => readFile(originalTargetPath, "utf-8"))).toBe(original);
          expect(yield* Effect.promise(() => readFile(replacementTargetPath, "utf-8"))).toBe(
            replacement,
          );
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(remaining.filter((entry) => entry.includes(".recovery-"))).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "formats a symlink output through its target without replacing the link",
    () =>
      withTempDirectory((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "formatted-link-schema.gen.ts");
          const targetPath = path.join(dir, "formatted-target-schema.gen.ts");
          const original = "export const formatTarget = true;\n";
          const formatted = "export const formatTarget=true;\n";
          yield* fs.writeFileString(targetPath, original);
          yield* Effect.promise(() => symlink(path.basename(targetPath), outputFilePath));
          const formatter = ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand")
              return Effect.die(new Error("formatter command should be a standard process"));
            const stagedPath = command.args.at(-1);
            if (stagedPath === undefined)
              return Effect.die(new Error("formatter command did not receive an output path"));
            return fs.writeFileString(stagedPath, formatted).pipe(
              Effect.andThen(
                Effect.succeed(
                  ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(1),
                    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                    isRunning: Effect.succeed(false),
                    kill: () => Effect.void,
                    stdin: Sink.drain,
                    stdout: Stream.empty,
                    stderr: Stream.empty,
                    all: Stream.empty,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                    unref: Effect.succeed(Effect.void),
                  }),
                ),
              ),
            );
          });

          yield* formatGeneratedFileEffect(outputFilePath).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, formatter),
          );

          expect((yield* Effect.promise(() => lstat(outputFilePath))).isSymbolicLink()).toBe(true);
          expect(yield* Effect.promise(() => readFile(targetPath, "utf-8"))).toBe(formatted);
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(remaining.filter((entry) => entry.includes(".recovery-"))).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );
});
