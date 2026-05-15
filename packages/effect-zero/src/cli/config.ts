import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Path, Result, Schema } from "effect";
import type { Project } from "ts-morph";
import { tsImport } from "tsx/esm/api";
import type { EffectZeroSchema } from "../types";
import { EffectZeroSchemaExportSchema } from "./schema";

export const defaultConfigFilePath = "effect-zero.config.ts";

export const getDefaultConfigFilePathEffect = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fullConfigPath = path.resolve(process.cwd(), defaultConfigFilePath);
  const existsResult = yield* Effect.result(fs.exists(fullConfigPath));
  const exists = Result.isSuccess(existsResult) ? existsResult.success : false;
  return exists ? defaultConfigFilePath : null;
});

export const getDefaultConfigFilePath = (): Promise<string | null> =>
  Effect.runPromise(getDefaultConfigFilePathEffect.pipe(Effect.provide(NodeServices.layer)));

const isEffectZeroSchema = (value: unknown): value is EffectZeroSchema =>
  typeof value === "object" &&
  value !== null &&
  "tables" in value &&
  typeof value.tables === "object" &&
  value.tables !== null;

export const getConfigFromFileEffect = ({
  configFilePath,
  tsProject,
}: {
  readonly configFilePath: string;
  readonly tsProject: Project;
}): Effect.Effect<
  {
    readonly zeroSchema: EffectZeroSchema;
    readonly exportName: "default" | "schema";
    readonly configFilePath: string;
  },
  unknown,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fullConfigPath = path.resolve(process.cwd(), configFilePath);
    const relativeConfigPath = path.relative(process.cwd(), fullConfigPath);
    if (relativeConfigPath.startsWith("..") || path.isAbsolute(relativeConfigPath)) {
      return yield* Effect.fail(
        new Error("effect-zero: Config file must be inside the current working directory"),
      );
    }
    const existsResult = yield* Effect.result(fs.exists(fullConfigPath));
    const exists = Result.isSuccess(existsResult) ? existsResult.success : false;
    if (!exists) {
      return yield* Effect.fail(
        new Error(`effect-zero: Failed to find config file at ${fullConfigPath}`),
      );
    }

    const fileUrl = yield* path.toFileUrl(fullConfigPath);
    const imported = yield* Effect.tryPromise({
      try: () => tsImport(fileUrl.href, import.meta.url),
      catch: (error) =>
        new Error(
          `effect-zero: Failed to import config file at ${fullConfigPath}. ${String(error)}`,
        ),
    });
    const defaultExport = imported?.default;
    const namedExport = imported?.schema;
    const cjsNamedExport =
      typeof defaultExport === "object" && defaultExport !== null && "schema" in defaultExport
        ? (defaultExport as { readonly schema?: unknown }).schema
        : undefined;
    const exportName =
      Schema.decodeUnknownOption(EffectZeroSchemaExportSchema)(defaultExport)._tag === "Some"
        ? "default"
        : "schema";
    const zeroSchema = exportName === "default" ? defaultExport : (namedExport ?? cjsNamedExport);

    if (!zeroSchema) {
      return yield* Effect.fail(
        new Error(
          "effect-zero: No config found in the config file - export `default` or `schema`.",
        ),
      );
    }

    const decoded = yield* Schema.decodeUnknownEffect(EffectZeroSchemaExportSchema)(zeroSchema);
    if (!isEffectZeroSchema(decoded)) {
      return yield* Effect.fail(new Error("effect-zero: invalid config schema export"));
    }

    yield* ensureConfigTypeInProject({
      tsProject,
      configPath: fullConfigPath,
      exportName,
    });

    return {
      zeroSchema: decoded,
      exportName,
      configFilePath,
    } as const;
  });

export const getConfigFromFile = ({
  configFilePath,
  tsProject,
}: {
  readonly configFilePath: string;
  readonly tsProject: Project;
}) =>
  Effect.runPromise(
    getConfigFromFileEffect({ configFilePath, tsProject }).pipe(Effect.provide(NodeServices.layer)),
  );

const ensureConfigTypeInProject = ({
  tsProject,
  configPath,
  exportName,
}: {
  readonly tsProject: Project;
  readonly configPath: string;
  readonly exportName: string;
}): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const sourceFile =
      tsProject.getSourceFile(configPath) ?? tsProject.addSourceFileAtPathIfExists(configPath);
    if (!sourceFile) {
      return yield* Effect.fail(
        new Error(`effect-zero: Failed to find type definitions for ${configPath}`),
      );
    }

    if (
      exportName === "default" &&
      sourceFile.getExportAssignment((declaration) => !declaration.isExportEquals())
    ) {
      return;
    }

    const variableDeclaration = sourceFile.getVariableDeclaration(exportName);
    if (variableDeclaration?.isExported()) {
      return;
    }

    if (sourceFile.getExportedDeclarations().get(exportName)?.[0]) {
      return;
    }

    yield* Console.warn(
      "effect-zero: Could not confirm config export types with ts-morph; generated output will still reference the runtime export.",
    );
  });
