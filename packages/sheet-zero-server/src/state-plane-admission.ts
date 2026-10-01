import { Effect } from "effect";
import { admitSheetDbMigrationHistory as admitMigrationHistory } from "sheet-db-schema/admission";

/** Runs the shared schema journal check through the database server boundary. */
export const admitSheetDbMigrationHistory = Effect.suspend(() => admitMigrationHistory);
