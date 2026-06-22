import { Effect, Predicate, Schema } from "effect";
import { JsonValueSchema, MigrationExtensionResultSchema } from "../cli/schema";
import type { MigrationStatement } from "../diff/types";
import type {
  EffectSqlSchema,
  JsonValue,
  MigrationExtension,
  MigrationExtensionResult,
  ResolvedConfig,
} from "../types";
import type { SchemaSnapshot } from "../snapshot";

const isMigrationExtension = (value: unknown): value is MigrationExtension =>
  Predicate.isTagged("EffectSqlKitMigrationExtension")(value) &&
  Predicate.hasProperty(value, "name") &&
  Predicate.isString(value.name) &&
  Predicate.hasProperty(value, "generate") &&
  Predicate.isFunction(value.generate);

const duplicateValues = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
};

const validateMigrationExtensionsEffect = (
  extensions: readonly MigrationExtension[],
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const duplicateNames = duplicateValues(extensions.map((extension) => extension.name));
    if (duplicateNames.length > 0) {
      return yield* Effect.fail(
        new Error(
          `effect-sql-kit: duplicate migration extension name(s): ${duplicateNames.join(", ")}`,
        ),
      );
    }

    const invalid = extensions.find((extension) => !isMigrationExtension(extension));
    if (invalid) {
      return yield* Effect.fail(new Error("effect-sql-kit: invalid migration extension"));
    }
  });

export const runMigrationExtensionsEffect = ({
  config,
  schema,
  previous,
  current,
  statements,
  previousExtensions,
}: {
  readonly config: ResolvedConfig;
  readonly schema: EffectSqlSchema;
  readonly previous: SchemaSnapshot;
  readonly current: SchemaSnapshot;
  readonly statements?: readonly MigrationStatement[];
  readonly previousExtensions: Readonly<Record<string, JsonValue>>;
}): Effect.Effect<readonly (MigrationExtensionResult & { readonly name: string })[], unknown> =>
  Effect.gen(function* () {
    yield* validateMigrationExtensionsEffect(config.extensions);

    return (yield* Effect.forEach(config.extensions, (extension) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            extension.generate({
              config,
              schema,
              previous,
              current,
              statements,
              previousExtensions,
            }),
          ),
        );
        const decoded = yield* Schema.decodeUnknownEffect(MigrationExtensionResultSchema)(
          result,
        ).pipe(
          Effect.mapError(
            (error) =>
              new Error(
                `effect-sql-kit: invalid migration extension result from ${extension.name}: ${String(error)}`,
              ),
          ),
        );
        return {
          ...decoded,
          name: extension.name,
        } as MigrationExtensionResult & { readonly name: string };
      }),
    )) as readonly (MigrationExtensionResult & { readonly name: string })[];
  }) as Effect.Effect<readonly (MigrationExtensionResult & { readonly name: string })[], unknown>;

export const introspectMigrationExtensionsEffect = ({
  config,
  schema,
  previous,
  current,
}: {
  readonly config: ResolvedConfig;
  readonly schema: EffectSqlSchema;
  readonly previous: SchemaSnapshot;
  readonly current: SchemaSnapshot;
}) =>
  Effect.gen(function* () {
    yield* validateMigrationExtensionsEffect(config.extensions);

    const entries = yield* Effect.forEach(config.extensions, (extension) => {
      const introspect = extension.introspect;
      if (!introspect) {
        return Effect.succeed(undefined);
      }

      return Effect.gen(function* () {
        const result = introspect({
          config,
          schema,
          previous,
          current,
        });
        const snapshot = yield* Effect.isEffect(result)
          ? result
          : Effect.promise(() => Promise.resolve(result));
        if (snapshot === undefined) {
          return undefined;
        }
        const decoded = yield* Schema.decodeUnknownEffect(JsonValueSchema)(snapshot).pipe(
          Effect.mapError(
            (error) =>
              new Error(
                `effect-sql-kit: invalid migration extension snapshot from ${extension.name}: ${String(error)}`,
              ),
          ),
        );
        return [extension.name, decoded] as const;
      });
    });

    return Object.fromEntries(
      entries.filter((entry): entry is readonly [string, JsonValue] => entry !== undefined),
    ) as Readonly<Record<string, JsonValue>>;
  });

export const extensionSnapshotsEffect = (
  extensionResults: readonly (MigrationExtensionResult & { readonly name: string })[],
): Effect.Effect<Readonly<Record<string, JsonValue>>, Error> =>
  Effect.gen(function* () {
    const duplicates = duplicateValues(extensionResults.map((result) => result.name));

    if (duplicates.length > 0) {
      return yield* Effect.fail(
        new Error(
          `effect-sql-kit: duplicate migration extension result name(s): ${duplicates.join(", ")}`,
        ),
      );
    }

    return Object.fromEntries(
      extensionResults.map((result) => [result.name, result.snapshot]),
    ) as Readonly<Record<string, JsonValue>>;
  });
