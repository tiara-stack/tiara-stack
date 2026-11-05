import { Effect } from "effect";
import { admitSheetDbMigrationHistory as admitMigrationHistory } from "sheet-db-schema/admission";
import { sheetDbMigrationArtifactDigest } from "sheet-db-schema/migrations";

/** Reads the schema owner's loaded artifact identity without exposing its migration API. */
export const getSheetDbMigrationArtifactDigest = (): string => sheetDbMigrationArtifactDigest;

/** Runs the shared schema journal check through the database server boundary. */
export const admitSheetDbMigrationHistory = Effect.suspend(() => admitMigrationHistory);
