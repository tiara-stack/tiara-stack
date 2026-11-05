import { createHash } from "node:crypto";
import { Schema } from "effect";
import manifest from "./migration-artifact-manifest.json";

export type SheetDbMigrationArtifactSource = readonly [path: string, digest: string];

export const SheetDbMigrationArtifactManifestSchema = Schema.Struct({
  sources: Schema.Array(
    Schema.Tuple([
      Schema.String.check(
        Schema.isPattern(
          /^packages\/sheet-db-schema\/effect-sql-migrations\/\d{4}_[a-z0-9_]+\.ts$/,
        ),
      ),
      Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
    ]),
  ),
});

export const sheetDbMigrationArtifactSources = Schema.decodeUnknownSync(
  SheetDbMigrationArtifactManifestSchema,
)(manifest).sources;

/** Hashes the ordered path/digest manifest with explicit field boundaries. */
export const sheetDbMigrationArtifactDigestFromSources = (
  sources: ReadonlyArray<SheetDbMigrationArtifactSource>,
) => {
  const digest = createHash("sha256");
  for (const field of ["sheet-db-migration-artifact-manifest-v1", ...sources.flat()]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    digest.update(length).update(bytes);
  }
  return `sha256:${digest.digest("hex")}`;
};

export const sheetDbMigrationArtifactDigest = sheetDbMigrationArtifactDigestFromSources(
  sheetDbMigrationArtifactSources,
);
