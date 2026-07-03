import { Effect, Predicate, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
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
import * as Data from "effect/Data";

class EffectSqlKitMigrationExtensionsError extends Data.TaggedError(
  "EffectSqlKitMigrationExtensionsError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const duplicateNames = duplicateValues(extensions.map((extension) => extension.name));
    if (duplicateNames.length > 0) {
      return yield* new EffectSqlKitMigrationExtensionsError({
        message: `effect-sql-kit: duplicate migration extension name(s): ${duplicateNames.join(", ")}`,
      });
    }

    const invalid = extensions.find((extension) => !isMigrationExtension(extension));
    if (invalid) {
      return yield* new EffectSqlKitMigrationExtensionsError({
        message: "effect-sql-kit: invalid migration extension",
      });
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
}): Effect.Effect<
  readonly (MigrationExtensionResult & { readonly name: string })[],
  unknown,
  never
> =>
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
              new EffectSqlKitMigrationExtensionsError({
                message: `effect-sql-kit: invalid migration extension result from ${extension.name}: ${String(error)}`,
              }),
          ),
        );
        return {
          ...decoded,
          name: extension.name,
        } as MigrationExtensionResult & { readonly name: string };
      }),
    )) as readonly (MigrationExtensionResult & { readonly name: string })[];
  }) as Effect.Effect<
    readonly (MigrationExtensionResult & { readonly name: string })[],
    unknown,
    never
  >;

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
}): Effect.Effect<Readonly<Record<string, JsonValue>>, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    yield* validateMigrationExtensionsEffect(config.extensions);

    const entries = yield* Effect.forEach(config.extensions, (extension) => {
      const introspect = extension.introspect;
      if (!introspect) {
        return Effect.void as Effect.Effect<undefined, never, never>;
      }

      return Effect.gen(function* () {
        const result = introspect({
          config,
          schema,
          previous,
          current,
        });
        const snapshotEffect: Effect.Effect<JsonValue | undefined, unknown, SqlClient.SqlClient> =
          Effect.isEffect(result)
            ? (result as Effect.Effect<JsonValue | undefined, unknown, SqlClient.SqlClient>)
            : Effect.promise(() => Promise.resolve(result));
        const snapshot = yield* snapshotEffect;
        if (snapshot === undefined) {
          return undefined;
        }
        const decoded = yield* Schema.decodeUnknownEffect(JsonValueSchema)(snapshot).pipe(
          Effect.mapError(
            (error) =>
              new EffectSqlKitMigrationExtensionsError({
                message: `effect-sql-kit: invalid migration extension snapshot from ${extension.name}: ${String(error)}`,
              }),
          ),
        );
        return [extension.name, decoded] as const;
      }) as Effect.Effect<readonly [string, JsonValue] | undefined, unknown, SqlClient.SqlClient>;
    });

    return Object.fromEntries(
      entries.filter((entry): entry is readonly [string, JsonValue] => entry !== undefined),
    ) as Readonly<Record<string, JsonValue>>;
  });

export const extensionSnapshotsEffect = (
  extensionResults: readonly (MigrationExtensionResult & { readonly name: string })[],
): Effect.Effect<Readonly<Record<string, JsonValue>>, Error, never> =>
  Effect.gen(function* () {
    const duplicates = duplicateValues(extensionResults.map((result) => result.name));

    if (duplicates.length > 0) {
      return yield* new EffectSqlKitMigrationExtensionsError({
        message: `effect-sql-kit: duplicate migration extension result name(s): ${duplicates.join(", ")}`,
      });
    }

    return Object.fromEntries(
      extensionResults.map((result) => [result.name, result.snapshot]),
    ) as Readonly<Record<string, JsonValue>>;
  });
