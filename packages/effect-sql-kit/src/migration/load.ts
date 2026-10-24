import { Effect } from "effect";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Loader, ResolvedMigration } from "effect/unstable/sql/Migrator";
import { listMigrationModules } from "./journal";

export const fromDirectory = (directory: string): Loader =>
  Effect.promise(async () => {
    const resolvedDirectory = new URL(
      `${directory.replace(/\/$/, "")}/`,
      pathToFileURL(`${process.cwd()}/`),
    );
    const files = await listMigrationModules(fileURLToPath(resolvedDirectory));
    return files.flatMap((file): readonly ResolvedMigration[] => {
      const match = file.match(/^(\d+)_(.+)\.(ts|js|mjs)$/);
      if (!match) {
        return [];
      }
      const [, id, name] = match;
      return [
        [
          Number(id),
          name!,
          Effect.promise(async () => {
            const mod = await import(new URL(file, resolvedDirectory).href);
            if (!Effect.isEffect(mod.default)) {
              throw new Error(`effect-sql-kit: migration ${file} must default export an Effect`);
            }

            return mod.default /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Effect.Effect<
              unknown,
              unknown,
              SqlClient.SqlClient
            > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
          }),
        ],
      ];
    });
  });
