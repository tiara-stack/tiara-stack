import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Result } from "effect";
import { Project } from "ts-morph";
import { getConfigFromFileEffect, getDefaultConfigFilePathEffect } from "./config";

const withTempCwd = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "effect-zero-config-"))),
    (dir) =>
      Effect.gen(function* () {
        const previousCwd = process.cwd();
        process.chdir(dir);
        try {
          return yield* f(dir);
        } finally {
          process.chdir(previousCwd);
        }
      }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

describe("effect-zero config effects", () => {
  it.effect("finds the default config file", () =>
    withTempCwd((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(path.join(dir, "effect-zero.config.ts"), "export default {};\n"),
        );
        const result = yield* getDefaultConfigFilePathEffect;
        expect(result).toBe("effect-zero.config.ts");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects invalid config exports through the schema parser", () =>
    withTempCwd((dir) =>
      Effect.gen(function* () {
        const configPath = path.join(dir, "effect-zero.config.ts");
        yield* Effect.promise(() => writeFile(configPath, "export default { tables: 1 };\n"));
        const tsProject = new Project({
          skipAddingFilesFromTsConfig: true,
          useInMemoryFileSystem: true,
        });
        tsProject.createSourceFile(configPath, "export default { tables: 1 };\n");

        const result = yield* Effect.result(
          getConfigFromFileEffect({
            configFilePath: "effect-zero.config.ts",
            tsProject,
          }),
        );

        expect(Result.isFailure(result)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
