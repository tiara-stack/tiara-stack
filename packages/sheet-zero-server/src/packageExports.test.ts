import { readFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

const ExportConditions = Schema.Struct({
  types: Schema.String,
  browser: Schema.Null,
  development: Schema.String,
  default: Schema.String,
});
const PackageManifest = Schema.Struct({
  exports: Schema.Struct({
    ".": ExportConditions,
    "./authorization": ExportConditions,
    "./http": ExportConditions,
    "./persistence": ExportConditions,
    "./package.json": Schema.String,
  }),
});

it.live("blocks every sheet-zero-server code entrypoint from browsers", () =>
  Effect.gen(function* () {
    const packageJson = yield* Effect.promise(() =>
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    const manifest = yield* Schema.decodeUnknownEffect(PackageManifest)(JSON.parse(packageJson));

    expect(Object.keys(manifest.exports)).toEqual([
      ".",
      "./authorization",
      "./http",
      "./persistence",
      "./package.json",
    ]);
    for (const exportPath of [".", "./authorization", "./http", "./persistence"] as const) {
      expect(manifest.exports[exportPath].browser).toBeNull();
    }
  }),
);
