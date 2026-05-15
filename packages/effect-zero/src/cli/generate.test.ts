import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Result } from "effect";
import {
  formatGeneratedFileEffect,
  generate,
  writeGeneratedFile,
  writeGeneratedFileEffect,
} from "./generate";
import { checkSignature } from "./signature";

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

describe("cli generation", () => {
  it.effect("generates and signs a schema file", () =>
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
        expect(output).toContain("display_name");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to overwrite modified generated files without force", () =>
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
  );

  it.effect("writeGeneratedFileEffect refuses manually modified generated files", () =>
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
  );

  it.effect("formatGeneratedFileEffect warns instead of failing when formatting fails", () =>
    withTempProject((dir) => formatGeneratedFileEffect(path.join(dir, "missing.ts"))).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
});
