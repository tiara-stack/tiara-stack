import { NodeServices } from "@effect/platform-node";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Result, Sink, Stream } from "effect";
import { TestConsole } from "effect/testing";
import { PlatformError, SystemError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  formatGeneratedFileEffect,
  generate,
  writeGeneratedFile,
  writeGeneratedFileEffect,
} from "./generate";
import { checkSignature, signContent } from "./signature";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const writeTempProject = async () => {
  const dir = await mkdtemp(path.join(packageRoot, ".tmp-effect-zero-cli-"));
  await symlink(path.join(packageRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  const schemaImport = `./${path.relative(dir, path.join(packageRoot, "src/schema.ts")).replaceAll(path.sep, "/")}`;
  await writeFile(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        skipLibCheck: true,
        paths: {},
      },
      include: ["**/*.ts"],
    }),
  );
  await writeFile(
    path.join(dir, "effect-zero.config.ts"),
    [
      'import { pg } from "effect-sql-schema";',
      `import { schema as effectZeroSchema } from ${JSON.stringify(schemaImport)};`,
      'class User extends pg.Class<User>("User")({ table: "users", fields: { id: pg.uuid().primaryKey().defaultRandom(), name: pg.text("display_name").notNull() } }) {}',
      "export const schema = effectZeroSchema({ users: User });",
    ].join("\n"),
  );
  return dir;
};

const withTempProject = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(Effect.promise(writeTempProject), f, (dir) =>
    Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

const withTempDirectory = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(packageRoot, ".tmp-effect-zero-link-error-"))),
    f,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

const isGeneratedTemporaryEntry = (entry: string) =>
  entry.includes(".stage-") || entry.includes(".hardlink-probe-") || entry.includes(".recovery-");

const installFormatterHarness = async (
  dir: string,
  options: {
    readonly mode: "partial-failure" | "manual-race";
    readonly outputFilePath: string;
    readonly manualContent?: string;
  },
) => {
  const captureRoot = process.env.TIA230_FIXTURE_CHILD_CAPTURE_DIR ?? dir;
  const captureDirectory = path.join(
    captureRoot,
    `effect-zero-formatter-${process.pid}-${Date.now()}`,
  );
  await mkdir(captureDirectory, { recursive: true });
  const wrapper = String.raw`#!/usr/bin/env python3
import hashlib, json, os, sys, uuid
from datetime import datetime, timezone
from pathlib import Path

name = Path(sys.argv[0]).name
args = [name, *sys.argv[1:]]
pid = os.getpid()
started = datetime.now(timezone.utc).isoformat()
capture = Path(os.environ["TIA230_FORMATTER_CAPTURE_DIR"])
stem = f"{name}-{pid}-{uuid.uuid4().hex}"
stdout_path = capture / f"{stem}.stdout.raw"
stderr_path = capture / f"{stem}.stderr.raw"
stdout_path.write_bytes(b"")
stderr_path.write_bytes(b"")
start = {"pid": pid, "startedAt": started, "argv": args, "cwd": os.getcwd(), "childLaunched": True}
(capture / f"{stem}.start.json").write_text(json.dumps(start, indent=2) + "\n")
target = Path(args[-1])
target.write_text(f"partial formatter output from {name}", encoding="utf-8")
mode = os.environ["TIA230_FORMATTER_TEST_MODE"]
if mode == "manual-race" and name == "pnpm":
    Path(os.environ["TIA230_FORMATTER_TARGET_OUTPUT"]).write_text(
        os.environ["TIA230_FORMATTER_MANUAL_CONTENT"], encoding="utf-8"
    )
exit_code = 1 if mode == "partial-failure" or name == "pnpm" else 0
completed = datetime.now(timezone.utc).isoformat()
receipt = {
    "pid": pid, "startedAt": started, "completedAt": completed, "argv": args,
    "cwd": os.getcwd(), "exitCode": exit_code, "childLaunched": True,
    "stdout": {"path": str(stdout_path), "bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()},
    "stderr": {"path": str(stderr_path), "bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()},
}
(capture / f"{stem}.receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
sys.exit(exit_code)
`;
  for (const name of ["pnpm", "vp"]) {
    const commandPath = path.join(dir, name);
    await writeFile(commandPath, wrapper);
    await chmod(commandPath, 0o755);
  }

  const variables = [
    "PATH",
    "TIA230_FORMATTER_CAPTURE_DIR",
    "TIA230_FORMATTER_TEST_MODE",
    "TIA230_FORMATTER_TARGET_OUTPUT",
    "TIA230_FORMATTER_MANUAL_CONTENT",
  ] as const;
  const previous = new Map(variables.map((key) => [key, process.env[key]]));
  process.env.PATH = `${dir}${path.delimiter}${previous.get("PATH") ?? ""}`;
  process.env.TIA230_FORMATTER_CAPTURE_DIR = captureDirectory;
  process.env.TIA230_FORMATTER_TEST_MODE = options.mode;
  process.env.TIA230_FORMATTER_TARGET_OUTPUT = options.outputFilePath;
  if (options.manualContent !== undefined)
    process.env.TIA230_FORMATTER_MANUAL_CONTENT = options.manualContent;

  return {
    captureDirectory,
    restore: () => {
      for (const key of variables) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
};

describe("cli generation", () => {
  it.live(
    "generates and signs a schema file",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const outputFilePath = path.join(dir, "zero-schema.gen.ts");
          const result = yield* Effect.promise(() =>
            generate({
              config: path.join(dir, "effect-zero.config.ts"),
              tsConfigPath: path.join(dir, "tsconfig.json"),
              outputFilePath,
            }),
          );
          const outputPath = yield* Effect.promise(() => writeGeneratedFile(result));
          const output = yield* Effect.promise(() => readFile(outputPath, "utf-8"));
          expect(checkSignature(output)).toBe("valid");
          expect(output).toContain("return null!;");
          expect(output).not.toContain("as unknown as");
          expect(output).toContain("display_name");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "signs the formatted generated schema content",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const outputFilePath = path.join(dir, "formatted-schema.gen.ts");
          const result = yield* Effect.promise(() =>
            generate({
              config: path.join(dir, "effect-zero.config.ts"),
              tsConfigPath: path.join(dir, "tsconfig.json"),
              outputFilePath,
            }),
          );
          const outputPath = yield* Effect.promise(() =>
            writeGeneratedFile({ ...result, format: true }),
          );
          const output = yield* Effect.promise(() => readFile(outputPath, "utf-8"));

          expect(checkSignature(output)).toBe("valid");
          expect(output).toContain("return null!;");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "refuses to overwrite modified generated files without force",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const outputFilePath = path.join(dir, "zero-schema.gen.ts");
          const result = yield* Effect.promise(() =>
            generate({
              config: path.join(dir, "effect-zero.config.ts"),
              tsConfigPath: path.join(dir, "tsconfig.json"),
              outputFilePath,
            }),
          );
          const outputPath = yield* Effect.promise(() => writeGeneratedFile(result));
          const output = yield* Effect.promise(() => readFile(outputPath, "utf-8"));
          yield* Effect.promise(() => writeFile(outputPath, `${output}\n// manual edit\n`));
          yield* Effect.promise(() =>
            expect(writeGeneratedFile(result)).rejects.toThrow("manually modified"),
          );
          yield* Effect.promise(() =>
            expect(writeGeneratedFile({ ...result, force: true })).resolves.toBe(outputPath),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "writeGeneratedFileEffect refuses manually modified generated files",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const outputFilePath = path.join(dir, "zero-schema.gen.ts");
          const result = {
            content: signContent("export const schema = {};\n"),
            outputFilePath,
          };
          const outputPath = yield* writeGeneratedFileEffect(result);
          const output = yield* Effect.promise(() => readFile(outputPath, "utf-8"));
          yield* Effect.promise(() => writeFile(outputPath, `${output}\n// manual edit\n`));
          const failure = yield* Effect.result(writeGeneratedFileEffect(result));
          expect(Result.isFailure(failure)).toBe(true);
          if (Result.isFailure(failure)) {
            expect(String(failure.failure)).toContain("manually modified");
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "reports unsupported hard-link failures separately from concurrent creation",
    () =>
      withTempDirectory((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "unsupported-link-schema.gen.ts");
          const unsupportedLinkFailure = new PlatformError(
            new SystemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "link",
              syscall: "link",
              pathOrDescriptor: outputFilePath,
              description: "Operation not supported",
            }),
          );
          let linkCalls = 0;
          const unsupportedLinkFileSystem = new Proxy(fs, {
            get(target, property) {
              if (property !== "link") return Reflect.get(target, property, target);
              return (_fromPath: string, toPath: string) => {
                linkCalls += 1;
                expect(toPath).toBe(outputFilePath);
                return Effect.fail(unsupportedLinkFailure);
              };
            },
          });

          const result = yield* Effect.result(
            writeGeneratedFileEffect({
              content: signContent("export const schema = { generated: true };\n"),
              outputFilePath,
              format: false,
            }).pipe(Effect.provideService(FileSystem.FileSystem, unsupportedLinkFileSystem)),
          );

          expect(linkCalls).toBe(1);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(String(result.failure)).toContain("hard link");
            expect(String(result.failure)).not.toContain("changed while generation was running");
            expect(result.failure).toHaveProperty("cause", unsupportedLinkFailure);
          }
          expect(yield* fs.exists(outputFilePath)).toBe(false);
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(remaining.filter(isGeneratedTemporaryEntry)).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "preserves an existing output when hard-link replacement is unsupported",
    () =>
      withTempDirectory((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "unsupported-restore-schema.gen.ts");
          const previousContent = signContent("export const schema = { previous: true };\n");
          yield* fs.writeFileString(outputFilePath, previousContent);
          yield* Effect.promise(() => chmod(outputFilePath, 0o640));
          const previousMode = (yield* Effect.promise(() => stat(outputFilePath))).mode & 0o777;
          const unsupportedLinkFailure = new PlatformError(
            new SystemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "link",
              syscall: "link",
              pathOrDescriptor: outputFilePath,
              description: "Operation not supported",
            }),
          );
          const unsupportedLinkFileSystem = new Proxy(fs, {
            get(target, property) {
              if (property !== "link") return Reflect.get(target, property, target);
              return () => Effect.fail(unsupportedLinkFailure);
            },
          });

          const result = yield* Effect.result(
            writeGeneratedFileEffect({
              content: signContent("export const schema = { generated: true };\n"),
              outputFilePath,
              format: false,
            }).pipe(Effect.provideService(FileSystem.FileSystem, unsupportedLinkFileSystem)),
          );
          const outputExists = yield* fs.exists(outputFilePath);
          const outputBytes = outputExists
            ? yield* Effect.promise(() => readFile(outputFilePath))
            : undefined;
          const outputMode = outputExists
            ? (yield* Effect.promise(() => stat(outputFilePath))).mode & 0o777
            : undefined;
          const recoveryDirectories = (yield* Effect.promise(() => readdir(dir))).filter((entry) =>
            entry.startsWith(`${path.basename(outputFilePath)}.recovery-`),
          );
          expect(Result.isFailure(result)).toBe(true);
          expect(outputExists).toBe(true);
          expect(outputBytes).toEqual(Buffer.from(previousContent));
          expect(outputMode).toBe(previousMode);
          if (Result.isFailure(result)) {
            expect(result.failure).toHaveProperty("cause", unsupportedLinkFailure);
            expect(String(result.failure)).toContain("hard link");
          }
          expect(recoveryDirectories).toEqual([]);
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(remaining.filter(isGeneratedTemporaryEntry)).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );

  it.live(
    "keeps a concurrently occupied hard-link probe destination",
    () =>
      withTempDirectory((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "occupied-probe-schema.gen.ts");
          const previousContent = signContent("export const schema = { previous: true };\n");
          const competingContent = "competing probe destination\n";
          yield* fs.writeFileString(outputFilePath, previousContent);
          yield* Effect.promise(() => chmod(outputFilePath, 0o640));
          const previousMode = (yield* Effect.promise(() => stat(outputFilePath))).mode & 0o777;
          let probePath: string | undefined;
          let alreadyExistsFailure: PlatformError | undefined;
          let linkCalls = 0;
          const occupiedProbeFileSystem = new Proxy(fs, {
            get(target, property) {
              if (property !== "link") return Reflect.get(target, property, target);
              return (_fromPath: string, toPath: string) => {
                linkCalls += 1;
                probePath = toPath;
                const failure = new PlatformError(
                  new SystemError({
                    _tag: "AlreadyExists",
                    module: "FileSystem",
                    method: "link",
                    syscall: "link",
                    pathOrDescriptor: toPath,
                    description: "EEXIST",
                  }),
                );
                alreadyExistsFailure = failure;
                return target
                  .writeFileString(toPath, competingContent)
                  .pipe(Effect.andThen(Effect.fail(failure)));
              };
            },
          });

          const result = yield* Effect.result(
            writeGeneratedFileEffect({
              content: signContent("export const schema = { generated: true };\n"),
              outputFilePath,
              format: false,
            }).pipe(Effect.provideService(FileSystem.FileSystem, occupiedProbeFileSystem)),
          );
          const outputExists = yield* fs.exists(outputFilePath);
          const outputBytes = outputExists
            ? yield* Effect.promise(() => readFile(outputFilePath))
            : undefined;
          const outputMode = outputExists
            ? (yield* Effect.promise(() => stat(outputFilePath))).mode & 0o777
            : undefined;

          expect(linkCalls).toBe(1);
          expect(probePath).toBeDefined();
          expect(probePath).not.toBe(outputFilePath);
          expect(Result.isFailure(result)).toBe(true);
          expect(outputExists).toBe(true);
          expect(outputBytes).toEqual(Buffer.from(previousContent));
          expect(outputMode).toBe(previousMode);
          if (probePath !== undefined) {
            expect(yield* fs.readFileString(probePath)).toBe(competingContent);
          }
          if (Result.isFailure(result)) {
            expect(String(result.failure)).toContain("probe destination was occupied");
            expect(result.failure).toHaveProperty("cause", alreadyExistsFailure);
          }
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(
            remaining.filter((entry) => entry.includes(".stage-") || entry.includes(".recovery-")),
          ).toEqual([]);
          const occupiedProbeDirectory =
            probePath === undefined ? [] : [path.basename(path.dirname(probePath))];
          expect(remaining.filter((entry) => entry.includes(".hardlink-probe-"))).toEqual(
            occupiedProbeDirectory,
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );

  it.live(
    "keeps the concurrent-creation message and competing file after an EEXIST link race",
    () =>
      withTempDirectory((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "concurrent-create-schema.gen.ts");
          const competingContent = signContent("export const schema = { competing: true };\n");
          const alreadyExists = new PlatformError(
            new SystemError({
              _tag: "AlreadyExists",
              module: "FileSystem",
              method: "link",
              syscall: "link",
              pathOrDescriptor: outputFilePath,
              description: "EEXIST",
            }),
          );
          let linkCalls = 0;
          const competingCreatorFileSystem = new Proxy(fs, {
            get(target, property) {
              if (property !== "link") return Reflect.get(target, property, target);
              return (_fromPath: string, toPath: string) => {
                linkCalls += 1;
                expect(toPath).toBe(outputFilePath);
                return target
                  .writeFileString(toPath, competingContent)
                  .pipe(Effect.andThen(Effect.fail(alreadyExists)));
              };
            },
          });

          const result = yield* Effect.result(
            writeGeneratedFileEffect({
              content: signContent("export const schema = { generated: true };\n"),
              outputFilePath,
              format: false,
            }).pipe(Effect.provideService(FileSystem.FileSystem, competingCreatorFileSystem)),
          );

          expect(linkCalls).toBe(1);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(String(result.failure)).toContain("changed while generation was running");
            expect(result.failure).toHaveProperty("cause", alreadyExists);
          }
          expect(yield* fs.readFileString(outputFilePath)).toBe(competingContent);
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(remaining.filter(isGeneratedTemporaryEntry)).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "removes the recovery directory after replacing an existing generated file",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "recovery-cleanup-schema.gen.ts");
          const previous = signContent("export const schema = { previous: true };\n");
          const generated = signContent("export const schema = { generated: true };\n");
          yield* fs.writeFileString(outputFilePath, previous);

          yield* writeGeneratedFileEffect({
            content: generated,
            outputFilePath,
            format: false,
          });

          expect(yield* fs.readFileString(outputFilePath)).toBe(generated);
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(remaining.filter(isGeneratedTemporaryEntry)).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "formatGeneratedFileEffect warns and preserves the file when formatters fail",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "format-target.ts");
          const original = "export const formatTarget = true;\n";
          yield* fs.writeFileString(outputFilePath, original);
          return yield* Effect.acquireUseRelease(
            Effect.promise(() =>
              installFormatterHarness(dir, { mode: "partial-failure", outputFilePath }),
            ),
            ({ captureDirectory }) =>
              Effect.gen(function* () {
                const warnings: Array<ReadonlyArray<unknown>> = [];
                yield* TestConsole.testConsoleWith((testConsole) => {
                  const originalWarn = testConsole.warn;
                  testConsole.warn = (...args) => {
                    warnings.push(args);
                    originalWarn(...args);
                  };
                  return formatGeneratedFileEffect(outputFilePath).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        testConsole.warn = originalWarn;
                      }),
                    ),
                  );
                });
                const warningText = warnings.flat().map(String).join("\n");
                expect(warningText).toContain(outputFilePath);
                expect(warningText).not.toContain(".stage-");
                const formatted = yield* fs.readFileString(outputFilePath);
                expect(formatted).toBe(original);
                const receipts = yield* Effect.promise(async () => {
                  const names = (await readdir(captureDirectory)).filter((name) =>
                    name.endsWith(".receipt.json"),
                  );
                  return Promise.all(
                    names.map(async (name) =>
                      JSON.parse(await readFile(path.join(captureDirectory, name), "utf8")),
                    ),
                  );
                });
                expect(receipts.map(({ exitCode }) => exitCode)).toEqual([1, 1]);
                const remaining = yield* Effect.promise(() => readdir(dir));
                expect(remaining.filter(isGeneratedTemporaryEntry)).toEqual([]);
              }),
            ({ restore }) => Effect.sync(restore),
          );
        }),
      ).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "does not leave a partial destination when the original formatter input cannot be read",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "missing-format-target.ts");
          let formatterCalls = 0;
          const failingSpawner = ChildProcessSpawner.make((command) => {
            formatterCalls += 1;
            if (command._tag !== "StandardCommand")
              return Effect.die(new Error("formatter command should be a standard process"));
            const targetPath = command.args.at(-1);
            if (targetPath === undefined)
              return Effect.die(new Error("formatter command did not receive an output path"));
            return fs
              .writeFileString(targetPath, "partial formatter output")
              .pipe(Effect.andThen(Effect.die(new Error("formatter failed"))));
          });

          const result = yield* Effect.exit(
            formatGeneratedFileEffect(outputFilePath).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingSpawner),
            ),
          );
          expect(Exit.isFailure(result)).toBe(true);
          expect(formatterCalls).toBe(0);
          expect(yield* fs.exists(outputFilePath)).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "keeps the prior signed output when formatting is interrupted after a partial temp write",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "interrupted-schema.gen.ts");
          const previous = signContent("export const schema = { previous: true };\n");
          yield* fs.writeFileString(outputFilePath, previous);
          const interruptedSpawner = ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand")
              return Effect.die(new Error("formatter command should be a standard process"));
            const temporaryPath = command.args.at(-1);
            if (temporaryPath === undefined)
              return Effect.die(new Error("formatter command did not receive an output path"));
            return fs
              .writeFileString(temporaryPath, "partial formatter output")
              .pipe(Effect.andThen(Effect.interrupt));
          });
          const interrupted = yield* Effect.exit(
            writeGeneratedFileEffect({
              content: signContent("export const schema = { next: true };\n"),
              outputFilePath,
              format: true,
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, interruptedSpawner),
            ),
          );
          expect(Exit.isFailure(interrupted)).toBe(true);
          const output = yield* fs.readFileString(outputFilePath);
          expect(output).toBe(previous);
          expect(checkSignature(output)).toBe("valid");
          const remaining = yield* Effect.promise(() => readdir(dir));
          expect(remaining.filter(isGeneratedTemporaryEntry)).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "restores and signs the complete generated bytes after both formatters fail",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "formatter-failure-schema.gen.ts");
          const previous = signContent("export const schema = { previous: true };\n");
          const generated = signContent("export const schema = { generated: true };\n");
          yield* fs.writeFileString(outputFilePath, previous);

          return yield* Effect.acquireUseRelease(
            Effect.promise(() =>
              installFormatterHarness(dir, { mode: "partial-failure", outputFilePath }),
            ),
            ({ captureDirectory }) =>
              Effect.gen(function* () {
                const warnings: Array<ReadonlyArray<unknown>> = [];
                const writtenPath = yield* TestConsole.testConsoleWith((testConsole) => {
                  const originalWarn = testConsole.warn;
                  testConsole.warn = (...args) => {
                    warnings.push(args);
                    originalWarn(...args);
                  };
                  return writeGeneratedFileEffect({
                    content: generated,
                    outputFilePath,
                    format: true,
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        testConsole.warn = originalWarn;
                      }),
                    ),
                  );
                });
                const warningText = warnings.flat().map(String).join("\n");
                expect(warningText).toContain(outputFilePath);
                expect(warningText).not.toContain(".stage-");
                expect(writtenPath).toBe(outputFilePath);
                const output = yield* fs.readFileString(outputFilePath);
                expect(output).toBe(generated);
                expect(checkSignature(output)).toBe("valid");
                const receipts = yield* Effect.promise(async () => {
                  const names = (await readdir(captureDirectory)).filter((name) =>
                    name.endsWith(".receipt.json"),
                  );
                  return Promise.all(
                    names.map(async (name) =>
                      JSON.parse(await readFile(path.join(captureDirectory, name), "utf8")),
                    ),
                  );
                });
                expect(receipts.map(({ exitCode }) => exitCode)).toEqual([1, 1]);
                expect(
                  receipts.every(
                    ({ pid, stdout, stderr }) =>
                      pid > 0 && stdout.bytes === 0 && stderr.bytes === 0,
                  ),
                ).toBe(true);
                const remaining = yield* Effect.promise(() => readdir(dir));
                expect(remaining.filter(isGeneratedTemporaryEntry)).toEqual([]);
              }),
            ({ restore }) => Effect.sync(restore),
          );
        }),
      ).pipe(Effect.provide(TestConsole.layer), Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "does not overwrite a manual edit made while formatting is in progress",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "concurrent-manual-schema.gen.ts");
          const previous = signContent("export const schema = { previous: true };\n");
          const manual = `${previous}\n// concurrent manual edit\n`;
          yield* fs.writeFileString(outputFilePath, previous);

          return yield* Effect.acquireUseRelease(
            Effect.promise(() =>
              installFormatterHarness(dir, {
                mode: "manual-race",
                outputFilePath,
                manualContent: manual,
              }),
            ),
            ({ captureDirectory }) =>
              Effect.gen(function* () {
                const result = yield* Effect.exit(
                  writeGeneratedFileEffect({
                    content: signContent("export const schema = { generated: true };\n"),
                    outputFilePath,
                    format: true,
                  }),
                );
                expect(Exit.isFailure(result)).toBe(true);
                const output = yield* fs.readFileString(outputFilePath);
                expect(output).toBe(manual);
                expect(checkSignature(output)).toBe("modified");
                const receipts = yield* Effect.promise(async () => {
                  const names = (await readdir(captureDirectory)).filter((name) =>
                    name.endsWith(".receipt.json"),
                  );
                  const reversedNames = [...names].sort().reverse();
                  return Promise.all(
                    reversedNames.map(async (name) =>
                      JSON.parse(await readFile(path.join(captureDirectory, name), "utf8")),
                    ),
                  );
                });
                expect(receipts.map(({ argv }) => argv[0])).toEqual(["vp", "pnpm"]);
                const exitCodesByCommand = Object.fromEntries(
                  receipts.map(({ argv, exitCode }) => [argv[0], exitCode]),
                );
                expect(exitCodesByCommand).toEqual({ pnpm: 1, vp: 0 });
                const remaining = yield* Effect.promise(() => readdir(dir));
                expect(remaining.filter(isGeneratedTemporaryEntry)).toEqual([]);
              }),
            ({ restore }) => Effect.sync(restore),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );

  it.live(
    "does not overwrite a manual edit made after the final snapshot check",
    () =>
      withTempProject((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputFilePath = path.join(dir, "final-check-race-schema.gen.ts");
          const previous = signContent("export const schema = { previous: true };\n");
          const generated = signContent("export const schema = { generated: true };\n");
          const manual = `${previous}\n// manual edit after snapshot check\n`;
          yield* fs.writeFileString(outputFilePath, previous);
          let edited = false;
          let formattingCompleted = false;
          const raceBeforeReplaceFileSystem = new Proxy(fs, {
            get(target, property) {
              if (property !== "link" && property !== "rename")
                return Reflect.get(target, property, target);
              return (fromPath: string, toPath: string) => {
                const replace =
                  property === "link"
                    ? target.link(fromPath, toPath)
                    : target.rename(fromPath, toPath);
                if (toPath !== outputFilePath || !formattingCompleted || edited) return replace;
                edited = true;
                return target.writeFileString(outputFilePath, manual).pipe(Effect.andThen(replace));
              };
            },
          });
          const successfulFormatter = ChildProcessSpawner.make(() => {
            formattingCompleted = true;
            return Effect.succeed(
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
            );
          });
          const result = yield* Effect.exit(
            writeGeneratedFileEffect({
              content: generated,
              outputFilePath,
              format: true,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, raceBeforeReplaceFileSystem),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, successfulFormatter),
            ),
          );

          expect(formattingCompleted).toBe(true);
          expect(edited).toBe(true);
          expect(Exit.isFailure(result)).toBe(true);
          expect(yield* fs.readFileString(outputFilePath)).toBe(manual);
          expect(checkSignature(manual)).toBe("modified");
          const recoveryDirectories = (yield* Effect.promise(() => readdir(dir))).filter((entry) =>
            entry.startsWith(`${path.basename(outputFilePath)}.recovery-`),
          );
          expect(recoveryDirectories).toHaveLength(1);
          const recoveryDirectory = path.join(dir, recoveryDirectories[0] ?? "");
          const recoveryFiles = yield* Effect.promise(() => readdir(recoveryDirectory));
          expect(recoveryFiles).toHaveLength(1);
          expect(
            yield* Effect.promise(() =>
              readFile(path.join(recoveryDirectory, recoveryFiles[0] ?? ""), "utf8"),
            ),
          ).toBe(previous);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    15_000,
  );
});
