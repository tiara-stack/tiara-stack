import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Loader, ResolvedMigration } from "effect/unstable/sql/Migrator";
import { listMigrationModules } from "./journal";

export const fromDirectory = (directory: string): Loader =>
  Effect.promise(async () => {
    const files = await listMigrationModules(directory);
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
            const mod = await import(`${directory}/${file}`);
            if (!Effect.isEffect(mod.default)) {
              throw new Error(`effect-sql-kit: migration ${file} must default export an Effect`);
            }
            return mod.default as Effect.Effect<unknown, unknown, SqlClient.SqlClient>;
          }),
        ],
      ];
    });
  });
